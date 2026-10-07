#!/usr/bin/env python3
"""Detached, checkpoint-safe controller for the frozen E014 training run.

The controller never provisions a machine or connects to a provider.  It is
intended to be copied with the project onto a persistent /workspace volume.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
TOTAL_STEPS = 2454
RATE_USD_HOUR = 1.09
PROFILE = "L40S_48GB_MB4"
OUTPUT_REL = Path("outputs/qwen3-8b-research-v0.1-qlora")
STOP_GRACE_SECONDS = 300
MIN_FREE_BYTES = 10 * 1024**3

sys.path.insert(0, str(ROOT / "src"))
from research_model.training.checkpoints import latest_complete_checkpoint, validate_checkpoint


def now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _read(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _append(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"timestamp": now(), **value}, ensure_ascii=False) + "\n")


@dataclass(frozen=True)
class Paths:
    root: Path
    project: Path

    @property
    def state(self) -> Path: return self.root / "state.json"
    @property
    def config(self) -> Path: return self.root / "config.json"
    @property
    def stop(self) -> Path: return self.root / "STOP_REQUESTED"
    @property
    def logs(self) -> Path: return self.root / "logs"
    @property
    def metrics(self) -> Path: return self.root / "metrics"
    @property
    def provenance(self) -> Path: return self.root / "provenance"
    @property
    def output(self) -> Path: return self.project / OUTPUT_REL


def paths() -> Paths:
    project = Path(os.environ.get("E014_PROJECT_ROOT", "/workspace/research-model-mm/source")).resolve()
    root = Path(os.environ.get("E014_CONTROLLER_ROOT", "/workspace/e014-runs/E014")).resolve()
    return Paths(root, project)


def under_workspace(path: Path) -> bool:
    try:
        path.relative_to("/workspace")
        return True
    except ValueError:
        return False


def training_command(project: Path, profile: str, resume: bool) -> list[str]:
    command = ["uv", "run", "--locked", "--extra", "dev", "--extra", "ml", "python",
               "scripts/train_transformers.py", "--config", "configs/training/qwen3_8b_v0.1_qlora.toml",
               "--hardware-profile", profile]
    if resume:
        command.append("--resume")
    return command


def classify_failure(text: str, returncode: int | None = None) -> str:
    lowered = text.lower()
    if re.search(r"cuda out of memory|outofmemoryerror|cublas_status_alloc_failed", lowered): return "CUDA_OOM"
    if re.search(r"non[- ]finite|nan(?:\b|[^a-z])", lowered): return "NONFINITE_LOSS"
    if re.search(r"no space left|disk quota|errno 28", lowered): return "DISK_EXHAUSTION"
    if re.search(r"checkpoint.*(corrupt|invalid|missing)|no atomically committed", lowered): return "CHECKPOINT_INVALID"
    return f"TRAINING_EXIT_{returncode}" if returncode is not None else "PROCESS_DEATH"


def gpu_snapshot() -> dict[str, Any]:
    try:
        raw = subprocess.check_output(["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total",
                                       "--format=csv,noheader,nounits"], text=True, timeout=5).strip()
        util, used, total = [float(part.strip()) for part in raw.splitlines()[0].split(",")]
        return {"gpu_utilization_percent": util, "vram_used_mib": used, "vram_total_mib": total}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return {"gpu_utilization_percent": None, "vram_used_mib": None, "vram_total_mib": None}


def events_snapshot(output: Path) -> dict[str, Any]:
    events = []
    event_path = output / "training_events.jsonl"
    if event_path.is_file():
        for line in event_path.read_text(encoding="utf-8", errors="replace").splitlines():
            try: events.append(json.loads(line))
            except json.JSONDecodeError: pass
    latest = events[-1] if events else {}
    logs = [event for event in events if event.get("event") == "log"]
    progress = [event for event in events if event.get("global_step") is not None]
    step = int(latest.get("global_step", 0) or 0)
    if progress: step = max(step, max(int(event.get("global_step", 0) or 0) for event in progress))
    latest_log = logs[-1] if logs else {}
    return {"optimizer_step": step, "epoch": latest_log.get("epoch", latest.get("epoch")),
            "loss": latest_log.get("loss", latest_log.get("train_loss")),
            "learning_rate": latest_log.get("learning_rate"), "tokens_per_second": latest_log.get("train_tokens_per_second"),
            "events": events}


def checkpoint_snapshot(output: Path) -> dict[str, Any]:
    checkpoint = latest_complete_checkpoint(output, 1) if output.is_dir() else None
    invalid = []
    if output.is_dir():
        for candidate in sorted(output.glob("checkpoint-*")):
            if candidate.is_dir() and validate_checkpoint(candidate, 1) is None:
                invalid.append(candidate.name)
    return {"latest_checkpoint": str(checkpoint) if checkpoint else None,
            "checkpoint_age_seconds": time.time() - checkpoint.stat().st_mtime if checkpoint else None,
            "invalid_checkpoints": invalid}


def status_snapshot(p: Paths) -> dict[str, Any]:
    state = _read(p.state, {}) or {}
    metrics = events_snapshot(p.output)
    checkpoint = checkpoint_snapshot(p.output)
    started = state.get("started_epoch_seconds")
    elapsed = max(0.0, time.time() - started) if started else state.get("elapsed_seconds", 0.0)
    step = metrics["optimizer_step"]
    rate = (step / elapsed) if elapsed and step else 0.0
    eta = ((TOTAL_STEPS - step) / rate) if rate else None
    result = {"state": state.get("state", "STOPPED" if not state else "FAILED"), "stage": state.get("stage"),
              "supervisor_pid": state.get("supervisor_pid"), "training_pid": state.get("training_pid"),
              "epoch": metrics["epoch"], "optimizer_step": step, "total_optimizer_steps": TOTAL_STEPS,
              "progress_percent": round(step / TOTAL_STEPS * 100, 3), "latest_loss": metrics["loss"],
              "learning_rate": metrics["learning_rate"], "throughput_tokens_per_second": metrics["tokens_per_second"],
              "elapsed_seconds": round(elapsed, 1), "eta_seconds": round(eta, 1) if eta is not None else None,
              **checkpoint, "gpu": gpu_snapshot(), "stop_reason": state.get("stop_reason"),
              "failure_class": state.get("failure_class"), "disk_free_bytes": shutil.disk_usage(p.root).free if p.root.exists() else None}
    return result


def save_status(p: Paths, state: dict[str, Any]) -> None:
    _write(p.state, state)
    _append(p.metrics / "status_history.jsonl", status_snapshot(p))


def _ensure(p: Paths) -> None:
    if not p.project.is_dir(): raise SystemExit(f"project root is missing: {p.project}")
    if not under_workspace(p.root) or not under_workspace(p.project):
        if os.environ.get("E014_ALLOW_NON_WORKSPACE") != "1":
            raise SystemExit("refusing non-/workspace durable paths; set E014_ALLOW_NON_WORKSPACE=1 only for local tests")
    for directory in (p.root, p.logs, p.metrics, p.provenance): directory.mkdir(parents=True, exist_ok=True)


def _valid_output(path: Path) -> bool:
    value = _read(path, None)
    return isinstance(value, dict) and bool(value)


def evaluation_commands() -> list[tuple[str, list[str], Path]]:
    base = ["uv", "run", "--locked", "--extra", "dev", "--extra", "ml"]
    rev = "49e3418fbbbca6ecbdf9608b4d22e5a407081db4"
    return [
        ("baseline_research", base + ["research-model", "baseline", "run", "--backend", "transformers", "--model", "Qwen/Qwen3-8B-Base", "--model-revision", rev, "--dataset", "benchmarks/releases/research-bench-v0.1.jsonl", "--output", "data/generated/E014_qwen3-8b-base-research-bench-v0.1.json", "--checkpoint-path", "data/generated/E014_qwen3-8b-base-research-bench-v0.1.partial.json", "--checkpoint-every", "1", "--max-new-tokens", "512", "--temperature", "0.0", "--load-in-4bit"], Path("data/generated/E014_qwen3-8b-base-research-bench-v0.1.json")),
        ("baseline_control", base + ["research-model", "control", "evaluate", "--backend", "transformers", "--model", "Qwen/Qwen3-8B-Base", "--model-revision", rev, "--label", "E014-base", "--max-new-tokens", "256", "--temperature", "0.0", "--load-in-4bit", "--output", "data/generated/E014_qwen3-8b-base-general-control-v0.1.json"], Path("data/generated/E014_qwen3-8b-base-general-control-v0.1.json")),
        ("tuned_research", base + ["research-model", "evaluate", "--backend", "transformers", "--model", "Qwen/Qwen3-8B-Base", "--model-revision", rev, "--adapter-path", str(OUTPUT_REL), "--dataset", "benchmarks/releases/research-bench-v0.1.jsonl", "--output", "data/generated/E014_qwen3-8b-tuned-research-bench-v0.1.json", "--checkpoint-path", "data/generated/E014_qwen3-8b-tuned-research-bench-v0.1.partial.json", "--checkpoint-every", "1", "--max-new-tokens", "512", "--temperature", "0.0", "--load-in-4bit"], Path("data/generated/E014_qwen3-8b-tuned-research-bench-v0.1.json")),
        ("tuned_control", base + ["research-model", "control", "evaluate", "--backend", "transformers", "--model", "Qwen/Qwen3-8B-Base", "--model-revision", rev, "--adapter-path", str(OUTPUT_REL), "--label", "E014-tuned", "--max-new-tokens", "256", "--temperature", "0.0", "--load-in-4bit", "--output", "data/generated/E014_qwen3-8b-tuned-general-control-v0.1.json"], Path("data/generated/E014_qwen3-8b-tuned-general-control-v0.1.json")),
        ("paired_research", base + ["research-model", "stats", "compare", "--base", "data/generated/E014_qwen3-8b-base-research-bench-v0.1.json", "--tuned", "data/generated/E014_qwen3-8b-tuned-research-bench-v0.1.json", "--output", "paper/statistical_outputs/E014_8b_primary_paired_bootstrap.json", "--samples", "20000", "--seed", "17", "--id-key", "example_id"], Path("paper/statistical_outputs/E014_8b_primary_paired_bootstrap.json")),
        ("paired_control", base + ["research-model", "stats", "compare", "--base", "data/generated/E014_qwen3-8b-base-general-control-v0.1.json", "--tuned", "data/generated/E014_qwen3-8b-tuned-general-control-v0.1.json", "--output", "paper/statistical_outputs/E014_control_paired_bootstrap.json", "--samples", "20000", "--seed", "17", "--id-key", "control_id"], Path("paper/statistical_outputs/E014_control_paired_bootstrap.json")),
    ]


class Controller:
    def __init__(self, p: Paths | None = None) -> None:
        self.p = p or paths()

    def request_start(self, resume: bool, max_runtime_hours: float | None, max_cost_usd: float | None) -> None:
        _ensure(self.p)
        current = _read(self.p.state, {}) or {}
        if current.get("state") == "RUNNING": raise SystemExit("E014 is already RUNNING")
        checkpoint = latest_complete_checkpoint(self.p.output, 1) if self.p.output.is_dir() else None
        has_artifacts = self.p.output.is_dir() and any(self.p.output.iterdir())
        completed = _read(self.p.output / "training_run.json", {}) or {}
        if completed.get("status") == "completed" and int(completed.get("global_step", 0) or 0) >= TOTAL_STEPS:
            print("E014 training is already complete; refusing to launch a second run")
            return
        if (resume or has_artifacts) and not checkpoint and not _valid_output(self.p.output / "training_run.json"):
            raise SystemExit("refusing to start from step 0: existing output has no valid checkpoint")
        if resume and not checkpoint: raise SystemExit("resume requested but no valid checkpoint exists")
        config = {"segment_id": uuid.uuid4().hex, "resume": bool(resume or checkpoint), "profile": PROFILE,
                  "max_runtime_hours": max_runtime_hours, "max_cost_usd": max_cost_usd, "rate_usd_per_hour": RATE_USD_HOUR,
                  "created_at": now()}
        _write(self.p.config, config)
        _write(self.p.provenance / "controller.json", {"experiment": "E014_qwen3_8b_primary_qlora", "scientific_config": "configs/training/qwen3_8b_v0.1_qlora.toml", "invariants": "configs/research/e014_scientific_invariants_v1.json", "controller_config": config, "checkpoint_resume": "operational continuation; no scientific hyperparameters changed"})
        self.p.stop.unlink(missing_ok=True)
        env = os.environ.copy(); env["E014_STOP_FILE"] = str(self.p.stop)
        log = (self.p.logs / "controller.log").open("a", encoding="utf-8")
        child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--supervise"], cwd=self.p.project, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        _write(self.p.state, {"state": "RUNNING", "stage": "STARTING", "supervisor_pid": child.pid, "started_at": now(), "started_epoch_seconds": time.time(), "resume": config["resume"]})
        print(f"[AMD002/E014] detached controller started (supervisor PID {child.pid})")

    def request_stop(self, reason: str = "user_requested_stop") -> None:
        _ensure(self.p)
        state = _read(self.p.state, {}) or {}
        if state.get("state") != "RUNNING": print("E014 is not running"); return
        self.p.stop.write_text(reason + "\n", encoding="utf-8")
        state.update({"stage": "STOP_REQUESTED", "stop_reason": reason})
        _write(self.p.state, state)
        print("E014 graceful stop requested; waiting for the next checkpoint boundary")

    def supervise(self) -> int:
        p = self.p; _ensure(p); config = _read(p.config, {}) or {}; state = _read(p.state, {}) or {}
        state.update({"state": "RUNNING", "stage": "VALIDATING", "supervisor_pid": os.getpid()}); _write(p.state, state)
        if shutil.disk_usage(p.root).free < MIN_FREE_BYTES:
            state.update({"state": "FAILED", "stage": "VALIDATING", "failure_class": "DISK_EXHAUSTION", "disk_free_bytes": shutil.disk_usage(p.root).free}); _write(p.state, state)
            return 1
        command = training_command(p.project, config.get("profile", PROFILE), bool(config.get("resume")))
        _append(p.provenance / "commands.jsonl", {"stage": "training", "argv": command, "segment_id": config.get("segment_id")})
        out = (p.logs / "training.stdout.log").open("a", encoding="utf-8"); err = (p.logs / "training.stderr.log").open("a", encoding="utf-8")
        env = os.environ.copy(); env["E014_STOP_FILE"] = str(p.stop)
        proc = subprocess.Popen(command, cwd=p.project, env=env, stdout=out, stderr=err, start_new_session=True)
        state.update({"stage": "TRAINING", "training_pid": proc.pid}); _write(p.state, state)
        started = time.time(); stop_seen = False
        while proc.poll() is None:
            budget = config.get("max_runtime_hours")
            cost = config.get("max_cost_usd")
            elapsed = time.time() - started
            exceeded = (budget is not None and elapsed >= float(budget) * 3600) or (cost is not None and elapsed / 3600 * RATE_USD_HOUR >= float(cost))
            if (p.stop.is_file() or exceeded) and not stop_seen:
                stop_seen = True; reason = p.stop.read_text(encoding="utf-8").strip() if p.stop.is_file() else "budget_exhausted"
                p.stop.write_text(reason + "\n", encoding="utf-8"); state.update({"stage": "STOP_REQUESTED", "stop_reason": reason}); _write(p.state, state)
            _append(p.metrics / "status_history.jsonl", status_snapshot(p)); time.sleep(5)
        out.close(); err.close()
        text = (p.logs / "training.stdout.log").read_text(encoding="utf-8", errors="replace")[-20000:] + (p.logs / "training.stderr.log").read_text(encoding="utf-8", errors="replace")[-20000:]
        if stop_seen:
            checkpoint = latest_complete_checkpoint(p.output, 1) if p.output.is_dir() else None
            state.update({"state": "STOPPED", "stage": "CHECKPOINTED_STOP", "training_pid": None, "latest_checkpoint": str(checkpoint) if checkpoint else None}); _write(p.state, state); return 0
        if proc.returncode != 0:
            state.update({"state": "FAILED", "stage": "TRAINING", "training_pid": None, "failure_class": classify_failure(text, proc.returncode), "exit_code": proc.returncode}); _write(p.state, state); return proc.returncode or 1
        state.update({"stage": "EVALUATING", "training_pid": None}); _write(p.state, state)
        for label, command, output in evaluation_commands():
            target = p.project / output
            if _valid_output(target): continue
            _append(p.provenance / "commands.jsonl", {"stage": label, "argv": command, "segment_id": config.get("segment_id")})
            result = subprocess.run(command, cwd=p.project, stdout=(p.logs / f"{label}.stdout.log").open("a"), stderr=subprocess.STDOUT)
            if result.returncode:
                state.update({"state": "FAILED", "stage": label, "failure_class": f"EVALUATION_EXIT_{result.returncode}", "exit_code": result.returncode}); _write(p.state, state); return result.returncode
        state.update({"state": "COMPLETE", "stage": "COMPLETE", "completed_at": now()}); _write(p.state, state); _write(p.root / "artifacts/final_status.json", status_snapshot(p)); return 0

    def logs(self, follow: bool = False) -> None:
        path = self.p.logs / "training.stdout.log"
        if not path.exists(): print(f"no logs yet: {path}"); return
        if not follow: print(path.read_text(encoding="utf-8", errors="replace")[-12000:]); return
        position = 0
        while True:
            if path.exists():
                data = path.read_text(encoding="utf-8", errors="replace"); print(data[position:], end="", flush=True); position = len(data)
            if (_read(self.p.state, {}) or {}).get("state") in {"COMPLETE", "FAILED", "STOPPED"}: return
            time.sleep(2)


def main() -> int:
    parser = argparse.ArgumentParser(); parser.add_argument("command", nargs="?", choices=["start", "status", "logs", "stop", "resume"]); parser.add_argument("--supervise", action="store_true"); parser.add_argument("--follow", action="store_true"); parser.add_argument("--max-runtime-hours", type=float); parser.add_argument("--max-cost-usd", type=float)
    args = parser.parse_args(); controller = Controller()
    if args.supervise: return controller.supervise()
    if args.command == "start": controller.request_start(False, args.max_runtime_hours, args.max_cost_usd)
    elif args.command == "resume": controller.request_start(True, args.max_runtime_hours, args.max_cost_usd)
    elif args.command == "stop": controller.request_stop()
    elif args.command == "logs": controller.logs(args.follow)
    elif args.command == "status": print(json.dumps(status_snapshot(controller.p), indent=2))
    else: parser.print_help()
    return 0


if __name__ == "__main__": raise SystemExit(main())
