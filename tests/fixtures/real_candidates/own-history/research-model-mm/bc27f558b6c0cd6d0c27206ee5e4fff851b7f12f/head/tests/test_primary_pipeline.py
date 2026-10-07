from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_primary_training_dry_run_checks_frozen_rows_without_loading_weights():
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ROOT / "src")
    result = subprocess.run(
        [
            sys.executable,
            "scripts/train_transformers.py",
            "--config",
            "configs/training/qwen3_8b_v0.1_qlora.toml",
            "--dry-run",
            "--dry-run-examples",
            "1",
            "--skip-tokenizer",
        ],
        cwd=ROOT,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    report = json.loads(result.stdout)
    assert report["dry_run"] is True
    assert report["model"] == "Qwen/Qwen3-8B-Base"
    assert report["dataset"]["split_counts"] == {"train": 19626, "validation": 2816, "test": 2827}
    assert report["dataset"]["estimated_optimizer_steps"] == 2454
    assert len(report["sample_character_lengths"]["train"]) == 1
    assert report["tokenizer_check"].startswith("skipped")
