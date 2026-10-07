"""Acquisition and parsing for the public QASPER train/dev archive."""

from __future__ import annotations

import json
import shutil
import tarfile
from pathlib import Path
from typing import Any

from .public import _download
from ..provenance.manifest import hash_file, update_source_record

QASPER_URL = "https://qasper-dataset.s3-us-west-2.amazonaws.com/qasper-train-dev-v0.1.tgz"
ALLOWED_QASPER_FILES = {"qasper-train-v0.1.json", "qasper-dev-v0.1.json", "README.md"}


def _safe_extract_qasper(archive: Path, destination: Path) -> list[str]:
    destination.mkdir(parents=True, exist_ok=True)
    extracted: list[str] = []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            name = Path(member.name).name
            if name not in ALLOWED_QASPER_FILES or not member.isfile():
                continue
            source = tar.extractfile(member)
            if source is None:
                continue
            target = destination / name
            with target.open("wb") as output:
                shutil.copyfileobj(source, output)
            extracted.append(name)
    return sorted(extracted)


def acquire_qasper(root: str | Path = "data", manifest_path: str | Path = "data/manifests/public_sources.json") -> dict[str, Any]:
    root = Path(root)
    archive = root / "raw" / "qasper" / "qasper-train-dev-v0.1.tgz"
    extracted_dir = root / "raw" / "qasper"
    if not archive.exists():
        _download(QASPER_URL, archive)
    extracted = _safe_extract_qasper(archive, extracted_dir)
    required = {"qasper-train-v0.1.json", "qasper-dev-v0.1.json"}
    if not required.issubset(extracted):
        raise RuntimeError(f"QASPER archive missing expected files: {sorted(required - set(extracted))}")
    update_source_record(
        manifest_path,
        "qasper",
        retrieval_date=__import__("datetime").date.today().isoformat(),
        retrieved_files=[str(extracted_dir / name) for name in extracted],
        archive_sha256=hash_file(archive),
        version_or_date="qasper-train-dev-v0.1 archive; pinned by recorded SHA-256",
    )
    return {"archive": str(archive), "data_dir": str(extracted_dir), "files": extracted, "sha256": hash_file(archive)}


def _read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _rows(path: Path, split: str) -> list[dict[str, Any]]:
    payload = _read_json(path)
    rows: list[dict[str, Any]] = []
    for paper_id, value in payload.items():
        row = dict(value)
        row["paper_id"] = str(paper_id)
        row["source_split"] = split
        rows.append(row)
    return rows


def read_qasper(data_dir: str | Path = "data/raw/qasper") -> dict[str, list[dict[str, Any]]]:
    data_dir = Path(data_dir)
    return {
        "train": _rows(data_dir / "qasper-train-v0.1.json", "train"),
        "dev": _rows(data_dir / "qasper-dev-v0.1.json", "dev"),
    }
