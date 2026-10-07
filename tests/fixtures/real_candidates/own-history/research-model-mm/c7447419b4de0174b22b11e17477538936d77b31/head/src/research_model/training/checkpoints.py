"""Atomic completion markers and conservative resume selection for Trainer checkpoints."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


CHECKPOINT_MARKER = "research_model_checkpoint_complete.json"
_CHECKPOINT_RE = re.compile(r"^checkpoint-(\d+)$")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _checkpoint_step(path: Path) -> int | None:
    match = _CHECKPOINT_RE.fullmatch(path.name)
    return int(match.group(1)) if match else None


def _checkpoint_payload(path: Path, world_size: int) -> dict[str, Any]:
    step = _checkpoint_step(path)
    if step is None or not path.is_dir():
        raise ValueError(f"not a Trainer checkpoint directory: {path}")

    state_path = path / "trainer_state.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    if int(state.get("global_step", -1)) != step:
        raise ValueError(f"checkpoint state step does not match directory name: {path}")

    adapter_weights = sorted(
        item for pattern in ("adapter_model.safetensors", "adapter_model.bin") for item in path.glob(pattern)
        if item.is_file() and item.stat().st_size > 0
    )
    if not adapter_weights or not (path / "adapter_config.json").is_file():
        raise ValueError(f"PEFT adapter files are incomplete: {path}")

    required = [path / "trainer_state.json", path / "optimizer.pt", path / "scheduler.pt"]
    rng_paths = sorted(path.glob("rng_state*.pth"))
    expected_rng_names = (
        ["rng_state.pth"] if world_size == 1 else [f"rng_state_{rank}.pth" for rank in range(world_size)]
    )
    if sorted(item.name for item in rng_paths) != sorted(expected_rng_names):
        raise ValueError(f"checkpoint RNG states are incomplete for world size {world_size}: {path}")
    required.extend(rng_paths)
    required.append(path / "adapter_config.json")
    required.extend(adapter_weights)
    for item in required:
        if not item.is_file() or item.stat().st_size <= 0:
            raise ValueError(f"checkpoint file is missing or empty: {item}")

    return {
        "schema_version": 1,
        "global_step": step,
        "world_size": world_size,
        "created_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "files": {
            item.name: {
                "size_bytes": item.stat().st_size,
                "sha256": _sha256(item) if item.name in {"trainer_state.json", "adapter_config.json"} else None,
            }
            for item in required
        },
    }


def write_checkpoint_complete_marker(checkpoint_dir: str | Path, world_size: int) -> Path:
    path = Path(checkpoint_dir)
    payload = _checkpoint_payload(path, world_size)
    marker = path / CHECKPOINT_MARKER
    if marker.exists():
        raise FileExistsError(f"checkpoint completion marker already exists: {marker}")

    fd, raw_temp_path = tempfile.mkstemp(prefix=f".{CHECKPOINT_MARKER}.", suffix=".tmp", dir=path)
    temp_path = Path(raw_temp_path)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, marker)
        directory_fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if temp_path.exists():
            temp_path.unlink()
    return marker


def validate_checkpoint(checkpoint_dir: str | Path, expected_world_size: int | None = None) -> dict[str, Any] | None:
    path = Path(checkpoint_dir)
    marker_path = path / CHECKPOINT_MARKER
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
        step = _checkpoint_step(path)
        world_size = int(marker["world_size"])
        if marker.get("schema_version") != 1 or step is None or int(marker["global_step"]) != step:
            return None
        if expected_world_size is not None and world_size != expected_world_size:
            return None
        expected = _checkpoint_payload(path, world_size)
        if expected["global_step"] != step:
            return None
        recorded_files = marker.get("files", {})
        for name, details in expected["files"].items():
            recorded = recorded_files.get(name)
            if not isinstance(recorded, dict) or recorded.get("size_bytes") != details["size_bytes"]:
                return None
            if recorded.get("sha256") is not None and recorded.get("sha256") != details.get("sha256"):
                return None
        if set(recorded_files) != set(expected["files"]):
            return None
        return marker
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def latest_complete_checkpoint(output_dir: str | Path, expected_world_size: int) -> Path | None:
    root = Path(output_dir)
    candidates: list[tuple[int, Path]] = []
    if not root.is_dir():
        return None
    for item in root.iterdir():
        step = _checkpoint_step(item)
        if step is not None and validate_checkpoint(item, expected_world_size):
            candidates.append((step, item))
    return max(candidates, default=(0, None), key=lambda pair: pair[0])[1]


def quarantine_incomplete_checkpoints(output_dir: str | Path, expected_world_size: int) -> list[Path]:
    """Move incomplete checkpoint folders aside without deleting recovery evidence."""

    root = Path(output_dir)
    valid = {item.resolve() for item in root.iterdir() if _checkpoint_step(item) is not None and validate_checkpoint(item, expected_world_size)}
    incomplete = [item for item in root.iterdir() if _checkpoint_step(item) is not None and item.resolve() not in valid]
    if not incomplete:
        return []
    quarantine = root / "incomplete-checkpoints"
    quarantine.mkdir(exist_ok=True)
    moved: list[Path] = []
    for item in incomplete:
        destination = quarantine / item.name
        if destination.exists():
            timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            destination = quarantine / f"{item.name}-{timestamp}"
        shutil.move(str(item), str(destination))
        moved.append(destination)
    return moved
