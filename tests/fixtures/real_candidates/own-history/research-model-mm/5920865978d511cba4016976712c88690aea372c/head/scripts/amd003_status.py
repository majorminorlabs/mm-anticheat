"""Pure status parsing helpers for the detached AMD003 runner."""

from __future__ import annotations

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


PROVIDER_RATE_USD_PER_HOUR = 1.99
TOTAL_OPTIMIZER_STEPS = 2454
CHECKPOINT_RE = re.compile(r"^checkpoint-(\d+)$")


def _number(value: Any) -> float | int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    return None


def _quantity(value: Any) -> float | None:
    if isinstance(value, dict):
        raw = _number(value.get("value"))
        return float(raw) if raw is not None else None
    raw = _number(value)
    return float(raw) if raw is not None else None


def _json_values(text: str) -> Iterator[Any]:
    decoder = json.JSONDecoder()
    offset = 0
    while offset < len(text):
        next_positions = [position for position in (text.find("[", offset), text.find("{", offset)) if position >= 0]
        if not next_positions:
            return
        position = min(next_positions)
        try:
            value, end = decoder.raw_decode(text[position:])
        except json.JSONDecodeError:
            offset = position + 1
            continue
        yield value
        offset = position + end


def _gpu_records(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        if "gfx" in value and "vram_used" in value:
            yield value
        for child in value.values():
            yield from _gpu_records(child)
    elif isinstance(value, list):
        for child in value:
            yield from _gpu_records(child)


def parse_latest_gpu_telemetry(path: str | Path) -> dict[str, Any] | None:
    """Parse the latest AMD-SMI monitor sample without assuming one JSON shape."""

    telemetry_path = Path(path)
    if not telemetry_path.is_file():
        return None
    latest: dict[str, Any] | None = None
    for value in _json_values(telemetry_path.read_text(encoding="utf-8", errors="replace")):
        for record in _gpu_records(value):
            latest = record
    if latest is None:
        return None
    return {
        "gpu": latest.get("gpu"),
        "timestamp": latest.get("timestamp"),
        "gpu_utilization_percent": _quantity(latest.get("gfx")),
        "hbm_used_gb": _quantity(latest.get("vram_used")),
        "hbm_total_gb": _quantity(latest.get("vram_total")),
        "power_watts": _quantity(latest.get("power_usage")),
        "temperature_c": _quantity(latest.get("hotspot_temperature")),
    }


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _read_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    if not path.is_file():
        return events
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def _checkpoint_snapshot(output_dir: Path) -> tuple[int | None, str | None]:
    candidates: list[tuple[int, Path]] = []
    if not output_dir.is_dir():
        return None, None
    for path in output_dir.iterdir():
        match = CHECKPOINT_RE.fullmatch(path.name)
        if match and (path / "research_model_checkpoint_complete.json").is_file():
            candidates.append((int(match.group(1)), path))
    if not candidates:
        return None, None
    step, path = max(candidates, key=lambda item: item[0])
    return step, str(path)


def _training_snapshot(repo_root: Path) -> dict[str, Any]:
    output_dir = repo_root / "outputs/qwen3-8b-research-v0.1-qlora"
    events = _read_events(output_dir / "training_events.jsonl")
    latest_step: int | None = None
    latest_loss: float | None = None
    progress_times: list[tuple[int, datetime]] = []
    for event in events:
        step = event.get("global_step")
        if isinstance(step, int):
            latest_step = max(latest_step or 0, step)
            if event.get("event") in {"progress", "log"} and isinstance(event.get("timestamp"), str):
                try:
                    progress_times.append((step, datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))))
                except ValueError:
                    pass
        if isinstance(event.get("loss"), (int, float)):
            latest_loss = float(event["loss"])
    checkpoint_step, checkpoint_path = _checkpoint_snapshot(output_dir)
    training_report = _read_json(output_dir / "training_run.json")
    if isinstance(training_report.get("global_step"), int):
        latest_step = max(latest_step or 0, int(training_report["global_step"]))
    seconds_per_step: float | None = None
    distinct_progress: dict[int, datetime] = {}
    for step, timestamp in progress_times:
        distinct_progress[step] = timestamp
    ordered_progress = sorted(distinct_progress.items())
    if len(ordered_progress) >= 2:
        first_step, first_time = ordered_progress[-2]
        last_step, last_time = ordered_progress[-1]
        step_delta = last_step - first_step
        if step_delta > 0:
            seconds_per_step = max(0.0, (last_time - first_time).total_seconds() / step_delta)
    return {
        "current_optimizer_step": latest_step or 0,
        "total_optimizer_steps": TOTAL_OPTIMIZER_STEPS,
        "latest_checkpoint": checkpoint_path,
        "latest_checkpoint_step": checkpoint_step,
        "latest_training_loss": latest_loss,
        "seconds_per_optimizer_step": seconds_per_step,
        "training_report": training_report or None,
    }


def _process_alive(pid: Any) -> bool | None:
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def build_status(session_root: str | Path) -> dict[str, Any]:
    root = Path(session_root)
    status = _read_json(root / "status.json")
    state = status.get("state", "NOT_STARTED")
    started_raw = status.get("started_at_utc")
    elapsed_seconds: float | None = None
    if isinstance(started_raw, str):
        try:
            started = datetime.fromisoformat(started_raw.replace("Z", "+00:00"))
            elapsed_seconds = max(0.0, (datetime.now(timezone.utc) - started).total_seconds())
        except ValueError:
            pass
    training = _training_snapshot(root / "research-model")
    telemetry = parse_latest_gpu_telemetry(root / "runtime/telemetry/gpu-monitor.jsonl")
    if telemetry is None:
        telemetry = parse_latest_gpu_telemetry(root / "runtime/telemetry/during_training.amd-smi-monitor.jsonl")
    current_step = int(training["current_optimizer_step"])
    projected_remaining_seconds: float | None = None
    if training["seconds_per_optimizer_step"] is not None and current_step < TOTAL_OPTIMIZER_STEPS:
        projected_remaining_seconds = (TOTAL_OPTIMIZER_STEPS - current_step) * training["seconds_per_optimizer_step"]
    recent_log_tail = ""
    log_candidates = sorted((root / "runtime/logs").glob("*.log"))
    if log_candidates:
        recent_log_tail = log_candidates[-1].read_text(encoding="utf-8", errors="replace")[-2000:]
    result = {
        **status,
        "state": state,
        "process_alive": _process_alive(status.get("runner_pid")),
        "elapsed_seconds": round(elapsed_seconds, 3) if elapsed_seconds is not None else status.get("elapsed_seconds"),
        "estimated_cost_usd": round((elapsed_seconds or 0.0) / 3600.0 * PROVIDER_RATE_USD_PER_HOUR, 4)
        if elapsed_seconds is not None
        else status.get("estimated_cost_usd"),
        **training,
        "projected_remaining_seconds": round(projected_remaining_seconds, 3)
        if projected_remaining_seconds is not None
        else None,
        "projected_remaining_cost_usd": round(projected_remaining_seconds / 3600.0 * PROVIDER_RATE_USD_PER_HOUR, 4)
        if projected_remaining_seconds is not None
        else None,
        "gpu": telemetry,
        "recent_log_tail": recent_log_tail,
    }
    return result
