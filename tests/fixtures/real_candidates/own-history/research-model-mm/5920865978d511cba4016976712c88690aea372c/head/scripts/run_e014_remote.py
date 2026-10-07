"""Detached AMD003 E014 runner, status reporter, and result packager."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SESSION_ID = "AMD003"
PROVIDER_RATE_USD_PER_HOUR = 1.99
TOTAL_OPTIMIZER_STEPS = 2454
MODEL = "Qwen/Qwen3-8B-Base"
MODEL_REVISION = "49e3418fbbbca6ecbdf9608b4d22e5a407081db4"
TOKENIZER_REVISION = MODEL_REVISION
DATASET_SHA256 = "703aceae7a28450fe9dca35be29c09cf0e64aceeda49f60e7f626b6e3708a91f"
RESEARCH_BENCHMARK_SHA256 = "3f1f859a10f1bb34ebb22197fadfeba08f2f812c2346a9d75c2b1b7e97b878c4"
CONTROL_BENCHMARK_SHA256 = "b9ff1050dd05eeaf062aba8e8fce1f0a39ffc7da68754d02f011779780628636"
TRAINING_CONFIG = "configs/training/qwen3_8b_v0.1_qlora.toml"
INVARIANTS = "configs/research/e014_scientific_invariants_v1.json"
TRAINING_OUTPUT = "outputs/qwen3-8b-research-v0.1-qlora"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def append_jsonl(path: Path, event: str, **fields: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "timestamp_utc": utc_now(),
        "host": socket.gethostname(),
        "event": event,
        **fields,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True, ensure_ascii=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


class RemoteRun:
    def __init__(self, session_root: Path, resume: bool = False) -> None:
        self.session_root = session_root.resolve()
        self.repo_root = self.session_root / "research-model"
        self.runtime_root = self.session_root / "runtime"
        self.log_root = self.runtime_root / "logs"
        self.environment_root = self.runtime_root / "environment"
        self.telemetry_root = self.runtime_root / "telemetry"
        self.result_root = self.session_root / "result"
        self.status_path = self.session_root / "status.json"
        self.timeline_path = self.session_root / "timeline.jsonl"
        self.command_path = self.session_root / "commands.jsonl"
        self.resume = resume
        self.monitor: subprocess.Popen[bytes] | None = None
        self.monitor_stdout = None
        self.started_at = _read_json(self.status_path).get("started_at_utc") or utc_now()

    def _status(self) -> dict[str, Any]:
        return _read_json(self.status_path)

    def update_status(self, **fields: Any) -> None:
        status = self._status()
        status.update(
            {
                "session_id": SESSION_ID,
                "state": status.get("state", "RUNNING"),
                "started_at_utc": self.started_at,
                "runner_pid": os.getpid(),
                "total_optimizer_steps": TOTAL_OPTIMIZER_STEPS,
                "provider_rate_usd_per_hour": PROVIDER_RATE_USD_PER_HOUR,
                "repo_root": str(self.repo_root),
                **fields,
            }
        )
        atomic_write_json(self.status_path, status)

    def set_stage(self, stage: str, state: str = "RUNNING", detail: str | None = None) -> None:
        self.update_status(state=state, current_stage=stage, detail=detail)
        append_jsonl(self.timeline_path, "STAGE_STARTED", state=state, stage=stage, detail=detail)

    def run_command(self, label: str, command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
        self.log_root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        stdout_path = self.log_root / f"{stamp}-{label}.stdout.log"
        stderr_path = self.log_root / f"{stamp}-{label}.stderr.log"
        display = shlex.join(command)
        append_jsonl(
            self.command_path,
            "COMMAND_STARTED",
            label=label,
            command=display,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
        )
        started = time.monotonic()
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            result = subprocess.run(command, cwd=self.repo_root, stdout=stdout, stderr=stderr, check=False)
        append_jsonl(
            self.command_path,
            "COMMAND_COMPLETED",
            label=label,
            command=display,
            stdout_path=str(stdout_path),
            stderr_path=str(stderr_path),
            exit_status=result.returncode,
            duration_seconds=round(time.monotonic() - started, 3),
        )
        if check and result.returncode:
            raise RuntimeError(f"{label} failed with exit status {result.returncode}; inspect {stderr_path}")
        return result

    def record_environment(self, label: str) -> None:
        self.environment_root.mkdir(parents=True, exist_ok=True)
        self.telemetry_root.mkdir(parents=True, exist_ok=True)
        commands = {
            "uname": ["uname", "-a"],
            "os_release": ["bash", "-lc", "cat /etc/os-release"],
            "memory": ["free", "-b"],
            "disk": ["df", "-B1"],
            "rocminfo": ["bash", "-lc", "command -v rocminfo >/dev/null && rocminfo || true"],
            "amd_smi_list": ["bash", "-lc", "command -v amd-smi >/dev/null && amd-smi list --json || true"],
            "amd_smi_static": ["bash", "-lc", "command -v amd-smi >/dev/null && amd-smi static --json || true"],
            "amd_smi_metric": ["bash", "-lc", "command -v amd-smi >/dev/null && amd-smi metric --json || true"],
        }
        for name, command in commands.items():
            result = self.run_command(f"environment_{label}_{name}", command, check=False)
            output_paths = sorted(self.log_root.glob(f"*-environment_{label}_{name}.stdout.log"))
            if output_paths:
                destination = self.environment_root / f"{label}.{name}.log"
                destination.write_bytes(output_paths[-1].read_bytes())
            if result.returncode and name in {"uname", "os_release", "memory", "disk"}:
                raise RuntimeError(f"required environment command failed: {name}")

    def start_telemetry(self) -> None:
        self.telemetry_root.mkdir(parents=True, exist_ok=True)
        if shutil.which("amd-smi") is None:
            return
        output = (self.telemetry_root / "gpu-monitor.jsonl").open("ab")
        errors = (self.telemetry_root / "gpu-monitor.stderr.log").open("ab")
        self.monitor_stdout = (output, errors)
        self.monitor = subprocess.Popen(
            ["amd-smi", "monitor", "--json", "--watch", "2", "--watch_time", "86400"],
            stdout=output,
            stderr=errors,
            start_new_session=True,
        )
        (self.telemetry_root / "gpu-monitor.pid").write_text(f"{self.monitor.pid}\n", encoding="utf-8")

    def stop_telemetry(self) -> None:
        if self.monitor is not None:
            try:
                self.monitor.terminate()
                self.monitor.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                try:
                    self.monitor.kill()
                except OSError:
                    pass
        if self.monitor_stdout:
            for handle in self.monitor_stdout:
                handle.close()
        self.monitor = None
        self.monitor_stdout = None

    def _valid_output(self, path: Path) -> bool:
        if not path.is_file() or path.stat().st_size == 0:
            return False
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        return isinstance(value, dict) and "per_example" in value

    def run_research_evaluation(self, label: str, output: str, adapter_path: str | None = None) -> None:
        output_path = self.repo_root / output
        if self._valid_output(output_path):
            append_jsonl(self.timeline_path, "STAGE_SKIPPED", stage=label, reason="final output already valid")
            return
        command = [
            "uv", "run", "--no-sync", "--locked", "--extra", "dev", "--extra", "ml",
            "research-model", "baseline", "run" if adapter_path is None else "evaluate",
            "--backend", "transformers", "--model", MODEL, "--model-revision", MODEL_REVISION,
            "--dataset", "benchmarks/releases/research-bench-v0.1.jsonl",
            "--output", output, "--checkpoint-path", output + ".partial.json", "--checkpoint-every", "1",
            "--max-new-tokens", "512", "--temperature", "0.0", "--load-in-4bit",
        ]
        if adapter_path is not None:
            command.extend(["--adapter-path", adapter_path])
        if (self.repo_root / (output + ".partial.json")).is_file():
            command.append("--resume")
        self.set_stage(label)
        self.run_command(label.lower().replace(" ", "_"), command)
        if not self._valid_output(output_path):
            raise RuntimeError(f"{label} completed without a valid output: {output_path}")

    def run_control_evaluation(self, label: str, output: str, adapter_path: str | None = None) -> None:
        output_path = self.repo_root / output
        if self._valid_output(output_path):
            append_jsonl(self.timeline_path, "STAGE_SKIPPED", stage=label, reason="final output already valid")
            return
        command = [
            "uv", "run", "--no-sync", "--locked", "--extra", "dev", "--extra", "ml",
            "research-model", "control", "evaluate", "--backend", "transformers", "--model", MODEL,
            "--model-revision", MODEL_REVISION, "--label", label, "--max-new-tokens", "256",
            "--temperature", "0.0", "--load-in-4bit", "--output", output,
        ]
        if adapter_path is not None:
            command.extend(["--adapter-path", adapter_path])
        self.set_stage(label)
        self.run_command(label.lower().replace(" ", "_"), command)
        if not self._valid_output(output_path):
            raise RuntimeError(f"{label} completed without a valid output: {output_path}")

    def run_training(self) -> None:
        output_dir = self.repo_root / TRAINING_OUTPUT
        report_path = output_dir / "training_run.json"
        report = _read_json(report_path)
        if report.get("status") == "completed" and int(report.get("global_step", 0)) >= TOTAL_OPTIMIZER_STEPS:
            append_jsonl(self.timeline_path, "STAGE_SKIPPED", stage="E014 training", reason="completed training report exists")
            return
        sys.path.insert(0, str(self.repo_root / "src"))
        from research_model.training.checkpoints import latest_complete_checkpoint

        checkpoint = latest_complete_checkpoint(output_dir, 1) if output_dir.is_dir() else None
        has_artifacts = output_dir.is_dir() and any(output_dir.iterdir())
        if has_artifacts and checkpoint is None:
            raise RuntimeError(
                "training output exists but no valid atomic checkpoint was found; refusing to restart E014 from zero"
            )
        if self.resume and checkpoint is None and not has_artifacts:
            raise RuntimeError("resume requested but no valid E014 checkpoint exists")
        action = "resume" if checkpoint is not None else "run"
        command = [
            "uv", "run", "--no-sync", "--locked", "--extra", "dev", "--extra", "ml",
            "python", "scripts/train_transformers.py", "--config", TRAINING_CONFIG,
            "--hardware-profile", "AMD_MI300X_SINGLE",
        ]
        if action == "resume":
            command.append("--resume")
        self.set_stage("E014 training", detail=f"action={action}")
        self.run_command("e014_training", command)
        report = _read_json(report_path)
        if report.get("status") != "completed" or int(report.get("global_step", 0)) < TOTAL_OPTIMIZER_STEPS:
            raise RuntimeError("E014 training command returned without a completed 2454-step report")
        self.update_status(state="TRAINING_COMPLETE", current_stage="E014 training complete")
        append_jsonl(self.timeline_path, "TRAINING_COMPLETE", global_step=report.get("global_step"))

    def run_stats(self, label: str, base: str, tuned: str, output: str, id_key: str) -> None:
        output_path = self.repo_root / output
        if output_path.is_file() and output_path.stat().st_size:
            append_jsonl(self.timeline_path, "STAGE_SKIPPED", stage=label, reason="statistics output exists")
            return
        command = [
            "uv", "run", "--no-sync", "--locked", "--extra", "dev", "--extra", "ml",
            "research-model", "stats", "compare", "--base", base, "--tuned", tuned,
            "--output", output, "--samples", "20000", "--seed", "17", "--id-key", id_key,
        ]
        self.set_stage(label)
        self.run_command(label.lower().replace(" ", "_"), command)
        if not output_path.is_file():
            raise RuntimeError(f"{label} did not create {output}")

    def write_summary(self, state: str, error: str | None = None) -> None:
        self.result_root.mkdir(parents=True, exist_ok=True)
        summary = {
            "session_id": SESSION_ID,
            "state": state,
            "created_at_utc": utc_now(),
            "error": error,
            "source_commit": _read_json(self.session_root / "transfer/manifest.remote.json").get("source_commit"),
            "scientific_invariants": INVARIANTS,
            "model": MODEL,
            "model_revision": MODEL_REVISION,
            "dataset_sha256": DATASET_SHA256,
            "research_benchmark_sha256": RESEARCH_BENCHMARK_SHA256,
            "control_benchmark_sha256": CONTROL_BENCHMARK_SHA256,
            "optimizer_steps": TOTAL_OPTIMIZER_STEPS,
            "provider_rate_usd_per_hour": PROVIDER_RATE_USD_PER_HOUR,
            "full_training_started": state not in {"RUNNING", "FAILED"} or bool((self.repo_root / TRAINING_OUTPUT).exists()),
            "result_paths": {
                "status": str(self.status_path),
                "timeline": str(self.timeline_path),
                "commands": str(self.command_path),
                "repository": str(self.repo_root),
            },
        }
        atomic_write_json(self.result_root / "summary.json", summary)

    def run(self) -> int:
        self.session_root.mkdir(parents=True, exist_ok=True)
        self.runtime_root.mkdir(parents=True, exist_ok=True)
        self.update_status(state="RUNNING", current_stage="starting", resume=self.resume)
        append_jsonl(self.timeline_path, "RUN_STARTED", resume=self.resume)
        try:
            self.start_telemetry()
            self.set_stage("environment snapshot")
            self.record_environment("before_setup")
            self.set_stage("frozen E014 invariant validation")
            self.run_command("validate_e014_invariants", ["uv", "run", "--no-sync", "python", "scripts/validate_e014_invariants.py"])
            self.set_stage("MI300X and ROCm preflight")
            self.run_command("amd003_remote_preflight", ["bash", "scripts/amd_remote_preflight.sh", "preflight", SESSION_ID, "root"])
            self.set_stage("exact dependency setup")
            self.run_command("prepare_amd_host", ["bash", "scripts/prepare_amd_host.sh"])
            self.set_stage("environment and dependency record")
            self.record_environment("after_setup")
            self.run_command(
                "record_python_environment",
                ["uv", "run", "--no-sync", "python", "-c", "import importlib.metadata,json,platform,sys,torch; names=['torch','transformers','peft','trl','bitsandbytes','accelerate','datasets']; print(json.dumps({'python':sys.version,'platform':platform.platform(),'torch':torch.__version__,'hip':torch.version.hip,'packages':{n:importlib.metadata.version(n) for n in names}}, default=str))"],
            )
            self.set_stage("pinned model revision verification")
            self.run_command(
                "verify_pinned_model_revision",
                ["uv", "run", "--no-sync", "--locked", "--extra", "ml", "python", "scripts/run_e014_remote.py", "verify-model", "--session-root", str(self.session_root)],
            )

            self.run_research_evaluation("base research benchmark", "data/generated/E014_qwen3-8b-base-research-bench-v0.1.json")
            self.run_control_evaluation("base general control", "data/generated/E014_qwen3-8b-base-general-control-v0.1.json")
            self.run_training()
            tuned_output = TRAINING_OUTPUT
            self.run_research_evaluation("tuned research benchmark", "data/generated/E014_qwen3-8b-tuned-research-bench-v0.1.json", tuned_output)
            self.run_control_evaluation("tuned general control", "data/generated/E014_qwen3-8b-tuned-general-control-v0.1.json", tuned_output)
            self.run_stats(
                "paired research bootstrap",
                "data/generated/E014_qwen3-8b-base-research-bench-v0.1.json",
                "data/generated/E014_qwen3-8b-tuned-research-bench-v0.1.json",
                "paper/statistical_outputs/E014_8b_primary_paired_bootstrap.json",
                "example_id",
            )
            self.run_stats(
                "paired control bootstrap",
                "data/generated/E014_qwen3-8b-base-general-control-v0.1.json",
                "data/generated/E014_qwen3-8b-tuned-general-control-v0.1.json",
                "paper/statistical_outputs/E014_control_paired_bootstrap.json",
                "control_id",
            )
            self.stop_telemetry()
            self.update_status(state="EVALUATION_COMPLETE", current_stage="evaluation complete")
            append_jsonl(self.timeline_path, "EVALUATION_COMPLETE")
            self.write_summary("COMPLETE")
            self.update_status(state="COMPLETE", current_stage="packaging result archive", finished_at_utc=utc_now())
            package_result(self.session_root)
            append_jsonl(self.timeline_path, "RUN_COMPLETE", state="COMPLETE")
            print("E014 AMD003 COMPLETE")
            return 0
        except Exception as exc:
            self.stop_telemetry()
            error = f"{type(exc).__name__}: {exc}"
            (self.session_root / "failures").mkdir(parents=True, exist_ok=True)
            (self.session_root / "failures/failure.txt").write_text(error + "\n", encoding="utf-8")
            append_jsonl(self.timeline_path, "RUN_FAILED", error=error)
            self.update_status(state="FAILED", current_stage="failed", finished_at_utc=utc_now(), failure=error)
            self.write_summary("FAILED", error)
            try:
                package_result(self.session_root)
            except Exception as package_error:
                (self.session_root / "failures/package_failure.txt").write_text(
                    f"{type(package_error).__name__}: {package_error}\n", encoding="utf-8"
                )
            print(f"E014 AMD003 FAILED: {error}", file=sys.stderr)
            return 1
        finally:
            self.stop_telemetry()


def package_result(session_root: Path) -> Path:
    result_root = session_root / "result"
    result_root.mkdir(parents=True, exist_ok=True)
    archive = result_root / "AMD003-e014-results.tar.gz"
    temporary = result_root / f".{archive.name}.{os.getpid()}.tmp"
    candidates = [
        "status.json", "timeline.jsonl", "commands.jsonl", "runtime", "transfer",
        "failures", "environment", "result/summary.json", "research-model/experiments/E014_qwen3_8b_primary_qlora",
        "research-model/configs/research/e014_scientific_invariants_v1.json",
        "research-model/configs/training/qwen3_8b_v0.1_qlora.toml",
        "research-model/configs/evaluation/research_benchmark_v0.1.toml",
        f"research-model/{TRAINING_OUTPUT}",
    ]
    for directory in (session_root / "research-model/data/generated", session_root / "research-model/paper/statistical_outputs"):
        if directory.is_dir():
            prefix = directory.relative_to(session_root).as_posix()
            candidates.extend(
                f"{prefix}/{path.name}"
                for path in directory.iterdir()
                if path.name.startswith("E014_")
            )
    members = [member for member in candidates if (session_root / member).exists()]
    if not members:
        raise RuntimeError("no AMD003 result members exist to package")
    subprocess.run(["tar", "-czf", str(temporary), "-C", str(session_root), *members], check=True)
    os.replace(temporary, archive)
    digest = sha256(archive)
    (result_root / "AMD003-e014-results.tar.gz.sha256").write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    atomic_write_json(
        result_root / "archive_manifest.json",
        {"archive": str(archive), "bytes": archive.stat().st_size, "sha256": digest, "members": members},
    )
    status = _read_json(session_root / "status.json")
    status.update({"result_archive": str(archive), "result_archive_sha256": digest})
    atomic_write_json(session_root / "status.json", status)
    return archive


def verify_model(session_root: Path) -> int:
    from transformers import AutoConfig, AutoTokenizer

    config = AutoConfig.from_pretrained(MODEL, revision=MODEL_REVISION)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, revision=TOKENIZER_REVISION)
    resolved_model = getattr(config, "_commit_hash", None)
    resolved_tokenizer = getattr(tokenizer, "init_kwargs", {}).get("_commit_hash")
    for label, value in (("model", resolved_model), ("tokenizer", resolved_tokenizer)):
        if value is not None and value != MODEL_REVISION:
            raise RuntimeError(f"{label} resolved revision {value!r}, expected {MODEL_REVISION!r}")
    payload = {
        "model": MODEL,
        "requested_model_revision": MODEL_REVISION,
        "requested_tokenizer_revision": TOKENIZER_REVISION,
        "resolved_model_revision": resolved_model,
        "resolved_tokenizer_revision": resolved_tokenizer,
        "verification": "config_and_tokenizer_loaded_at_pinned_revision; training loads the same pinned model revision",
        "verified_at_utc": utc_now(),
    }
    atomic_write_json(session_root / "runtime/model_revision.json", payload)
    print(json.dumps(payload, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    run = subparsers.add_parser("run")
    run.add_argument("--session-root", required=True, type=Path)
    run.add_argument("--resume", action="store_true")
    status = subparsers.add_parser("status")
    status.add_argument("--session-root", required=True, type=Path)
    package = subparsers.add_parser("package")
    package.add_argument("--session-root", required=True, type=Path)
    verify = subparsers.add_parser("verify-model")
    verify.add_argument("--session-root", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "status":
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        from amd003_status import build_status

        print(json.dumps(build_status(args.session_root), indent=2, ensure_ascii=False))
        return 0
    if args.command == "package":
        print(json.dumps({"archive": str(package_result(args.session_root))}, indent=2))
        return 0
    if args.command == "verify-model":
        return verify_model(args.session_root)
    return RemoteRun(args.session_root, resume=args.resume).run()


if __name__ == "__main__":
    raise SystemExit(main())

