"""Append-only experiment manifests and reproducibility checks.

The experiment directory is deliberately separate from generated model and
prediction files.  A manifest is written once; later corrections are recorded
as a new manifest or an explicit invalidation note rather than an in-place
rewrite of the old evidence.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import platform
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .manifest import hash_file

EXPERIMENT_SCHEMA_VERSION = "1.0"
EXPERIMENT_ID_RE = re.compile(r"^E[0-9]{3,}_[a-z0-9][a-z0-9_-]*$")
INDEX_NAME = "index.json"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _package_version(name: str) -> str | None:
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None


def collect_environment() -> dict[str, Any]:
    """Collect only locally observable environment metadata.

    Missing GPU/VRAM information remains null.  The collector does not infer
    hardware from a model name or from an expected machine configuration.
    """

    ram_gb: float | None = None
    try:
        if platform.system() == "Darwin":
            raw = subprocess.check_output(["sysctl", "-n", "hw.memsize"], text=True, timeout=2).strip()
            ram_gb = round(int(raw) / (1024**3), 2)
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    packages = {
        key: value
        for key, value in {
            "torch": _package_version("torch"),
            "transformers": _package_version("transformers"),
            "peft": _package_version("peft"),
            "mlx": _package_version("mlx"),
            "mlx-lm": _package_version("mlx-lm"),
            "datasets": _package_version("datasets"),
            "trl": _package_version("trl"),
        }.items()
        if value is not None
    }
    return {
        "machine": {
            "hostname": platform.node() or None,
            "os": f"{platform.system()} {platform.release()}".strip(),
            "architecture": platform.machine() or None,
            "cpu": platform.processor() or None,
            "gpu": None,
            "gpu_count": None,
            "vram_gb": None,
            "ram_gb": ram_gb,
            "hardware_probe_note": "GPU and VRAM are null unless explicitly measured by the run.",
        },
        "software": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "packages": packages,
            "cuda": None,
        },
    }


def _read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def load_experiment_index(root: str | Path = ".") -> dict[str, Any]:
    return _read_json(Path(root) / "experiments" / INDEX_NAME, {"index_version": "1.0", "experiments": []})


def experiment_manifests(root: str | Path = ".") -> list[Path]:
    base = Path(root) / "experiments"
    return sorted(base.glob("E*/manifest.json")) if base.exists() else []


def validate_manifest(manifest: dict[str, Any], root: str | Path = ".") -> dict[str, Any]:
    """Validate manifest structure and referenced immutable artifacts."""

    root = Path(root)
    errors: list[str] = []
    warnings: list[str] = []
    required = {
        "experiment_schema_version", "experiment_id", "title", "status",
        "metadata_status", "manifest_created_at", "research_question",
        "hypothesis", "experiment_type", "git", "environment", "dataset",
        "benchmark", "model", "training", "execution", "artifacts",
        "results", "interpretation", "limitations", "conclusion",
    }
    missing = sorted(required - set(manifest))
    if missing:
        errors.append("missing fields: " + ", ".join(missing))
    experiment_id = manifest.get("experiment_id")
    if not isinstance(experiment_id, str) or not EXPERIMENT_ID_RE.fullmatch(experiment_id):
        errors.append("invalid experiment_id; expected E###_slug")
    if manifest.get("metadata_status") not in {"recorded_contemporaneously", "reconstructed_after_fact", "partially_reconstructed"}:
        errors.append("invalid metadata_status")
    if manifest.get("status") not in {"planned", "running", "completed", "invalidated", "failed"}:
        errors.append("invalid status")
    if manifest.get("status") == "invalidated" and not manifest.get("invalidation"):
        errors.append("invalidated experiment needs invalidation details")
    missing_metadata = manifest.get("missing_metadata", [])
    if not isinstance(missing_metadata, list):
        errors.append("missing_metadata must be a list")
    elif missing_metadata and manifest.get("metadata_status") == "recorded_contemporaneously":
        warnings.append("recorded contemporaneously but missing_metadata is non-empty")
    if manifest.get("manifest_created_at") is None:
        errors.append("manifest_created_at is required")
    if not isinstance(manifest.get("artifacts"), dict):
        errors.append("artifacts must be an object")

    artifact_paths: list[tuple[str, str, str | None]] = []
    for section_name in ("dataset", "benchmark", "training", "execution", "artifacts", "results"):
        section = manifest.get(section_name)
        if not isinstance(section, dict):
            continue
        for key, value in section.items():
            if key not in {"path", "config_path", "command_path", "manifest_path", "log_path", "prediction_path", "metrics_path", "checkpoint_path", "adapter_path", "summary_path"}:
                continue
            if isinstance(value, str):
                artifact_paths.append((section_name, key, value))
            elif isinstance(value, dict) and isinstance(value.get("path"), str):
                artifact_paths.append((section_name, key, value["path"]))
    missing_artifacts: list[str] = []
    hash_mismatches: list[str] = []
    for section_name, key, raw_path in artifact_paths:
        path = Path(raw_path)
        if not path.is_absolute():
            path = root / path
        if not path.exists():
            missing_artifacts.append(f"{section_name}.{key}: {raw_path}")
            continue
        expected_hash = None
        section = manifest.get(section_name)
        if isinstance(section, dict):
            hash_key = {"path": "sha256", "config_path": "config_sha256", "prediction_path": "prediction_sha256", "metrics_path": "metrics_sha256", "checkpoint_path": "checkpoint_sha256", "adapter_path": "adapter_sha256"}.get(key)
            if hash_key:
                expected_hash = section.get(hash_key)
        if expected_hash and path.is_file() and hash_file(path) != expected_hash:
            hash_mismatches.append(f"{section_name}.{key}: {raw_path}")
    if missing_artifacts:
        warnings.append(f"missing referenced artifacts: {len(missing_artifacts)}")
    if hash_mismatches:
        errors.append("artifact hash mismatch: " + ", ".join(hash_mismatches))
    reproducibility = check_reproducibility(manifest, root)
    warnings.extend(reproducibility["warnings"])
    return {
        "experiment_id": experiment_id,
        "valid": not errors,
        "errors": sorted(set(errors)),
        "warnings": sorted(set(warnings)),
        "missing_artifacts": missing_artifacts,
        "hash_mismatches": hash_mismatches,
        "reproducible": reproducibility["reproducible"],
    }


def check_reproducibility(manifest: dict[str, Any], root: str | Path = ".") -> dict[str, Any]:
    root = Path(root)
    warnings: list[str] = []
    required_reproduction = ["git.commit", "dataset.path", "dataset.sha256", "execution.command"]
    values = {
        "git.commit": manifest.get("git", {}).get("commit") if isinstance(manifest.get("git"), dict) else None,
        "dataset.path": manifest.get("dataset", {}).get("path") if isinstance(manifest.get("dataset"), dict) else None,
        "dataset.sha256": manifest.get("dataset", {}).get("sha256") if isinstance(manifest.get("dataset"), dict) else None,
        "execution.command": manifest.get("execution", {}).get("command") if isinstance(manifest.get("execution"), dict) else None,
    }
    missing = [key for key in required_reproduction if not values.get(key)]
    if missing:
        warnings.append("reproduction metadata missing: " + ", ".join(missing))
    dataset_path = values.get("dataset.path")
    dataset_hash = values.get("dataset.sha256")
    if dataset_path and dataset_hash:
        path = Path(dataset_path)
        if not path.is_absolute():
            path = root / path
        if path.exists() and path.is_file() and hash_file(path) != dataset_hash:
            warnings.append("dataset hash does not match the referenced path")
    return {"reproducible": not missing and not any("does not match" in item for item in warnings), "warnings": warnings}


def append_experiment_manifest(manifest: dict[str, Any], root: str | Path = ".") -> Path:
    """Write a new immutable manifest and append one entry to the index."""

    root = Path(root)
    result = validate_manifest(manifest, root)
    if not result["valid"]:
        raise ValueError("invalid experiment manifest: " + "; ".join(result["errors"]))
    experiment_id = manifest["experiment_id"]
    index = load_experiment_index(root)
    if any(item.get("experiment_id") == experiment_id for item in index.get("experiments", [])):
        raise FileExistsError(f"experiment id already exists: {experiment_id}")
    directory = root / "experiments" / experiment_id
    manifest_path = directory / "manifest.json"
    if manifest_path.exists():
        raise FileExistsError(f"manifest already exists: {manifest_path}")
    manifest = dict(manifest)
    manifest.setdefault("experiment_schema_version", EXPERIMENT_SCHEMA_VERSION)
    _write_json(manifest_path, manifest)
    index.setdefault("index_version", "1.0")
    index.setdefault("experiments", []).append({
        "experiment_id": experiment_id,
        "title": manifest.get("title"),
        "status": manifest.get("status"),
        "metadata_status": manifest.get("metadata_status"),
        "manifest_path": str(manifest_path),
        "manifest_sha256": hash_file(manifest_path),
        "indexed_at": utc_now(),
    })
    _write_json(root / "experiments" / INDEX_NAME, index)
    return manifest_path
