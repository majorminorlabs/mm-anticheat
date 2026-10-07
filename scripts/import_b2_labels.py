#!/usr/bin/env python3
"""Import independent B2 labels by repository and unambiguous commit prefix."""

import argparse
import json
import re
import tomllib
from pathlib import Path


def import_labels(labels: Path, candidates: Path) -> int:
    """Validate the entire mapping before changing any metadata."""
    content = json.loads(labels.read_text())
    updates = []
    for key, review in content["labels_by_short_sha"].items():
        repo, prefix = key.split("/", 1)
        if not re.fullmatch(r"[\w-]+", repo) or not re.fullmatch(r"[0-9a-f]{8,40}", prefix):
            raise ValueError("Invalid repository/commit key: " + key)
        matches = list((candidates / repo).glob(prefix + "*/meta.toml"))
        if len(matches) != 1:
            raise ValueError(f"{key}: expected one candidate, found {len(matches)}")
        label = review["label"]
        if label not in {"cheat", "suspicious", "legitimate", "unclear"}:
            raise ValueError("Unknown reviewer label: " + label)
        meta = matches[0]
        data = tomllib.loads(meta.read_text())
        if not data["source_commit"].startswith(prefix):
            raise ValueError("Commit provenance mismatch: " + key)
        values = {
            "label": label,
            "notes": review["note"],
            "reviewer": content["reviewer"],
            "review_date": content["date"],
        }
        text = meta.read_text()
        for field, value in values.items():
            line = field + " = " + json.dumps(value, ensure_ascii=False)
            pattern = rf"^{field}\s*=.*$"
            text = (
                re.sub(pattern, lambda _: line, text, flags=re.M)
                if re.search(pattern, text, re.M)
                else text.rstrip() + "\n" + line + "\n"
            )
        tomllib.loads(text)
        updates.append((meta, text))
    for meta, text in updates:
        meta.write_text(text)
    return len(updates)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("labels", type=Path)
    parser.add_argument("candidates", type=Path)
    args = parser.parse_args()
    print(f"Imported {import_labels(args.labels, args.candidates)} independent labels")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
