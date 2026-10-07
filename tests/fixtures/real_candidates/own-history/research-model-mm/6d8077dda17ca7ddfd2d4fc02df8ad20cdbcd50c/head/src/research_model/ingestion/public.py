"""Public data acquisition with safe extraction and provenance updates."""

from __future__ import annotations

import json
import shutil
import tarfile
import urllib.request
from pathlib import Path
from typing import Any

from ..provenance.manifest import hash_file, update_source_record

SCIFACT_URL = "https://scifact.s3-us-west-2.amazonaws.com/release/latest/data.tar.gz"
ALLOWED_SCIFACT_FILES = {"corpus.jsonl", "claims_train.jsonl", "claims_dev.jsonl", "claims_test.jsonl"}


def _download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "research-model/0.1"})
    with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def _safe_extract(archive: Path, destination: Path) -> list[str]:
    destination.mkdir(parents=True, exist_ok=True)
    extracted: list[str] = []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            name = Path(member.name).name
            if name not in ALLOWED_SCIFACT_FILES or not member.isfile():
                continue
            target = destination / name
            source = tar.extractfile(member)
            if source is None:
                continue
            with target.open("wb") as output:
                shutil.copyfileobj(source, output)
            extracted.append(name)
    return sorted(extracted)


def acquire_scifact(root: str | Path = "data", manifest_path: str | Path = "data/manifests/public_sources.json") -> dict[str, Any]:
    root = Path(root)
    archive = root / "raw" / "scifact-data.tar.gz"
    extracted_dir = root / "raw" / "scifact"
    if not archive.exists():
        _download(SCIFACT_URL, archive)
    extracted = _safe_extract(archive, extracted_dir)
    if set(extracted) != ALLOWED_SCIFACT_FILES:
        raise RuntimeError(f"SciFact archive missing expected files: {sorted(ALLOWED_SCIFACT_FILES - set(extracted))}")
    update_source_record(manifest_path, "scifact", retrieval_date=__import__("datetime").date.today().isoformat(), retrieved_files=[str(extracted_dir / name) for name in extracted], archive_sha256=hash_file(archive), version_or_date="latest release archive; pinned by recorded SHA-256")
    return {"archive": str(archive), "data_dir": str(extracted_dir), "files": extracted, "sha256": hash_file(archive)}


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def read_scifact(data_dir: str | Path = "data/raw/scifact") -> dict[str, list[dict[str, Any]]]:
    data_dir = Path(data_dir)
    return {"corpus": _read_jsonl(data_dir / "corpus.jsonl"), "train": _read_jsonl(data_dir / "claims_train.jsonl"), "dev": _read_jsonl(data_dir / "claims_dev.jsonl"), "test": _read_jsonl(data_dir / "claims_test.jsonl")}

