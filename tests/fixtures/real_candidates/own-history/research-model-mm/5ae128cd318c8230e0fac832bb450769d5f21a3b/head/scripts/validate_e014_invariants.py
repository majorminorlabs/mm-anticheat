"""Validate the E014 scientific-invariant snapshot against frozen source artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import tomllib
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INVARIANTS = ROOT / "configs/research/e014_scientific_invariants_v1.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _content_hash(rows: list[dict[str, Any]]) -> str:
    payload = "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def validate(invariants_path: Path = DEFAULT_INVARIANTS) -> dict[str, Any]:
    invariants = json.loads(invariants_path.read_text(encoding="utf-8"))
    failures: list[str] = []
    verified_files: dict[str, str] = {}

    source_files = {
        "source_manifest": (invariants["source_manifest"], invariants["source_manifest_sha256"]),
        "source_training_config": (invariants["source_training_config"], invariants["source_training_config_sha256"]),
        "source_hypothesis_config": (
            invariants["source_hypothesis_config"], invariants["source_hypothesis_config_sha256"]
        ),
        "source_research_evaluation_config": (
            invariants["source_research_evaluation_config"],
            invariants["source_research_evaluation_config_sha256"],
        ),
        "source_lockfile": (invariants["source_lockfile"], invariants["source_lockfile_sha256"]),
        "training_data": (
            invariants["scientific_invariants"]["training_data"]["path"],
            invariants["scientific_invariants"]["training_data"]["file_sha256"],
        ),
        "research_benchmark": (
            invariants["scientific_invariants"]["benchmark"]["path"],
            invariants["scientific_invariants"]["benchmark"]["file_sha256"],
        ),
        "general_control": (
            invariants["scientific_invariants"]["general_capability_control"]["path"],
            invariants["scientific_invariants"]["general_capability_control"]["file_sha256"],
        ),
    }
    for label, (relative_path, expected_hash) in source_files.items():
        path = ROOT / relative_path
        if not path.is_file():
            failures.append(f"{label}: missing file {relative_path}")
            continue
        actual_hash = _sha256(path)
        verified_files[relative_path] = actual_hash
        if actual_hash != expected_hash:
            failures.append(f"{label}: SHA-256 mismatch (expected {expected_hash}, got {actual_hash})")

    manifest_path = ROOT / invariants["source_manifest"]
    config_path = ROOT / invariants["source_training_config"]
    lock_path = ROOT / invariants["source_lockfile"]
    if manifest_path.is_file() and config_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        with config_path.open("rb") as handle:
            raw_config = tomllib.load(handle)
        if manifest.get("experiment_id") != invariants["experiment_id"]:
            failures.append("manifest experiment_id differs from invariant record")
        if manifest.get("training", {}).get("config_sha256") != invariants["source_training_config_sha256"]:
            failures.append("manifest training config hash differs from invariant record")
        if manifest.get("training", {}).get("config") != raw_config:
            failures.append("manifest embedded training config differs from frozen TOML")
        expected_eval_quant = invariants["scientific_invariants"]["evaluation"]["base_and_tuned_model_quantization"]
        if manifest.get("model", {}).get("base_quantization_for_training_and_evaluation") != expected_eval_quant:
            failures.append("manifest base/evaluation quantization differs from invariant record")
        if raw_config != invariants["scientific_invariants"]["training_treatment"]["training_config_values"]:
            failures.append("machine-readable training config values differ from frozen TOML")
        expected_training = invariants["scientific_invariants"]["training_treatment"]
        for key, expected in (
            ("expected_optimizer_steps", expected_training["optimizer_steps"]),
            ("expected_warmup_steps", expected_training["warmup_steps"]),
            ("planned_total_training_tokens", expected_training["planned_training_tokens"]),
        ):
            if manifest.get("training", {}).get(key) != expected:
                failures.append(f"manifest {key} differs from invariant record")

    hypothesis_path = ROOT / invariants["source_hypothesis_config"]
    if hypothesis_path.is_file():
        hypothesis_config = json.loads(hypothesis_path.read_text(encoding="utf-8"))
        primary = [item for item in hypothesis_config.get("hypotheses", []) if item.get("id") == "H1"]
        primary_questions = [
            item for item in hypothesis_config.get("research_questions", []) if item.get("id") == "RQ1"
        ]
        expected_primary = invariants["scientific_invariants"]["evaluation"]["primary_metrics"]
        if len(primary) != 1 or primary[0].get("metrics") != expected_primary:
            failures.append("frozen H1 metrics differ from invariant record")
        if len(primary_questions) != 1 or primary_questions[0].get("primary") is not True:
            failures.append("frozen RQ1 primary designation differs from invariant record")

    data_record = invariants["scientific_invariants"]["training_data"]
    dataset_path = ROOT / data_record["path"]
    if dataset_path.is_file():
        rows = _read_jsonl(dataset_path)
        all_hash = _content_hash(rows)
        counts: dict[str, int] = {}
        split_hashes: dict[str, str] = {}
        for split in ("train", "validation", "test"):
            split_rows = [row for row in rows if row.get("split") == split]
            counts[split] = len(split_rows)
            split_hashes[split] = _content_hash(split_rows)
        if len(rows) != data_record["row_count"]:
            failures.append(f"dataset row count mismatch: expected {data_record['row_count']}, got {len(rows)}")
        if counts != data_record["split_counts"]:
            failures.append(f"dataset split counts mismatch: expected {data_record['split_counts']}, got {counts}")
        if all_hash != data_record["content_sha256"]:
            failures.append(f"dataset content hash mismatch: expected {data_record['content_sha256']}, got {all_hash}")
        if split_hashes != data_record["split_content_sha256"]:
            failures.append("dataset per-split content hashes differ from frozen values")

    for label in ("benchmark", "general_capability_control"):
        record = invariants["scientific_invariants"][label]
        path = ROOT / record["path"]
        if not path.is_file():
            continue
        rows = _read_jsonl(path)
        content_hash = _content_hash(rows)
        if len(rows) != record["case_count"]:
            failures.append(f"{label} case count mismatch: expected {record['case_count']}, got {len(rows)}")
        if content_hash != record["content_sha256"]:
            failures.append(f"{label} canonical content hash mismatch")

    if lock_path.is_file():
        with lock_path.open("rb") as handle:
            lock = tomllib.load(handle)
        locked_versions = {item["name"]: item["version"] for item in lock.get("package", [])}
        package_pins = invariants["execution_backend_details"]["same_version_pins_required_for_case_a"]
        for package, expected in package_pins.items():
            if package == "python":
                continue
            actual = locked_versions.get(package)
            if actual != expected:
                failures.append(f"locked {package} version mismatch: expected {expected}, got {actual}")

    return {
        "status": "passed" if not failures else "failed",
        "experiment_id": invariants["experiment_id"],
        "invariants_path": str(
            invariants_path.relative_to(ROOT) if invariants_path.is_relative_to(ROOT) else invariants_path
        ),
        "verified_files": verified_files,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--invariants", type=Path, default=DEFAULT_INVARIANTS)
    args = parser.parse_args()
    try:
        result = validate(args.invariants)
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        result = {"status": "failed", "failures": [f"{type(exc).__name__}: {exc}"]}
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
