from __future__ import annotations

import json
from pathlib import Path

from research_model.training.checkpoints import (
    latest_complete_checkpoint,
    quarantine_incomplete_checkpoints,
    validate_checkpoint,
    write_checkpoint_complete_marker,
)


def _make_checkpoint(root: Path, step: int, world_size: int = 1, marker: bool = True) -> Path:
    checkpoint = root / f"checkpoint-{step}"
    checkpoint.mkdir(parents=True)
    (checkpoint / "adapter_config.json").write_text("{}\n", encoding="utf-8")
    (checkpoint / "adapter_model.safetensors").write_bytes(b"adapter-weights")
    (checkpoint / "optimizer.pt").write_bytes(b"optimizer-state")
    (checkpoint / "scheduler.pt").write_bytes(b"scheduler-state")
    (checkpoint / "trainer_state.json").write_text(json.dumps({"global_step": step}) + "\n", encoding="utf-8")
    rng_names = ["rng_state.pth"] if world_size == 1 else [f"rng_state_{rank}.pth" for rank in range(world_size)]
    for name in rng_names:
        (checkpoint / name).write_bytes(b"rng-state")
    if marker:
        write_checkpoint_complete_marker(checkpoint, world_size)
    return checkpoint


def test_checkpoint_is_not_resumable_until_complete_marker_is_written(tmp_path: Path) -> None:
    checkpoint = _make_checkpoint(tmp_path, 5, marker=False)
    assert validate_checkpoint(checkpoint, 1) is None
    marker = write_checkpoint_complete_marker(checkpoint, 1)
    assert marker.is_file()
    assert validate_checkpoint(checkpoint, 1)["global_step"] == 5
    assert latest_complete_checkpoint(tmp_path, 1) == checkpoint


def test_checkpoint_validation_detects_missing_or_changed_files(tmp_path: Path) -> None:
    checkpoint = _make_checkpoint(tmp_path, 5)
    assert validate_checkpoint(checkpoint, 1)
    with (checkpoint / "optimizer.pt").open("ab") as handle:
        handle.write(b"truncated-or-changed")
    assert validate_checkpoint(checkpoint, 1) is None


def test_distributed_checkpoint_requires_each_rank_rng_state(tmp_path: Path) -> None:
    checkpoint = _make_checkpoint(tmp_path, 5, world_size=2)
    assert validate_checkpoint(checkpoint, 2)
    assert validate_checkpoint(checkpoint, 1) is None


def test_latest_checkpoint_ignores_and_quarantines_partial_checkpoint(tmp_path: Path) -> None:
    good = _make_checkpoint(tmp_path, 5)
    partial = _make_checkpoint(tmp_path, 10, marker=False)
    assert latest_complete_checkpoint(tmp_path, 1) == good
    moved = quarantine_incomplete_checkpoints(tmp_path, 1)
    assert len(moved) == 1
    assert moved[0].name == partial.name
    assert not partial.exists()
    assert (moved[0] / "optimizer.pt").is_file()
