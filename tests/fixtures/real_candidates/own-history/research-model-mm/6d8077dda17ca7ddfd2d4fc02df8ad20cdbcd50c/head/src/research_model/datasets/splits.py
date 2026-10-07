from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any


def dataset_hash(rows: list[dict[str, Any]]) -> str:
    payload = "\n".join(json.dumps(row, ensure_ascii=False, sort_keys=True) for row in rows).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def assign_source_group_splits(rows: list[dict[str, Any]], seed: int = 17, train_ratio: float = 0.8, validation_ratio: float = 0.1) -> list[dict[str, Any]]:
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        ids = row.get("source_ids") or row.get("provenance", {}).get("source_record_ids") or [row["example_id"]]
        groups["|".join(sorted(map(str, ids)))].append(row)
    ordered = sorted(groups, key=lambda key: hashlib.sha256(f"{seed}:{key}".encode()).hexdigest())
    total = len(rows); train_target = total * train_ratio; validation_target = total * (train_ratio + validation_ratio)
    output: list[dict[str, Any]] = []; count = 0
    for group in ordered:
        split = "train" if count < train_target else "validation" if count < validation_target else "test"
        for row in groups[group]:
            copy = dict(row); copy["split"] = split; output.append(copy)
        count += len(groups[group])
    return sorted(output, key=lambda row: row["example_id"])

