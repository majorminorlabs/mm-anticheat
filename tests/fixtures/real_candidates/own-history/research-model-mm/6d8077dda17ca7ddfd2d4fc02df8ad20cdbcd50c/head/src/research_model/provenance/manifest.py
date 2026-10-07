from __future__ import annotations

import hashlib
import json
from datetime import date
from pathlib import Path
from typing import Any


def hash_file(path: str | Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while chunk := handle.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def load_manifest(path: str | Path) -> dict[str, Any]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def update_source_record(manifest_path: str | Path, source_id: str, **updates: Any) -> dict[str, Any]:
    path = Path(manifest_path)
    manifest = load_manifest(path)
    manifest["generated_at"] = date.today().isoformat()
    for record in manifest.get("sources", []):
        if record.get("source_id") == source_id:
            record.update(updates)
            break
    else:
        raise KeyError(source_id)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return manifest

