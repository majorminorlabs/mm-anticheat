#!/usr/bin/env python3
"""Save local high/medium commit candidates for Dippo to label at Gate 2."""

import argparse
import json
import subprocess
from dataclasses import asdict
from pathlib import Path

from history import scan_commits


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("count", type=int)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    if args.count < 1:
        parser.error("count must be positive")
    saved, errors = 0, 0
    for item in scan_commits(args.repo.resolve(), args.count, args.head):
        if item.error:
            print(f"ERROR {item.sha}: {item.error}")
            errors += 1
            continue
        if not any(f.severity in {"high", "medium"} for f in item.result.findings):
            continue
        case = args.output / item.sha
        if case.exists():
            print(f"Existing candidate retained: {case}")
            continue
        case.mkdir(parents=True)
        patch = subprocess.run(
            [
                "git",
                "-C",
                str(args.repo),
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--find-renames",
                item.sha + "~1",
                item.sha,
                "--",
            ],
            capture_output=True,
            check=True,
        ).stdout
        (case / "diff.patch").write_bytes(patch)
        meta = (
            'mode = "full"\nsource = "own-history"\nlabel = "unreviewed"\n'
            f'source_commit = "{item.sha}"\ndescription = {json.dumps(item.subject)}\n'
        )
        (case / "meta.toml").write_text(meta)
        (case / "findings.json").write_text(
            json.dumps([asdict(f) for f in item.result.findings], indent=2) + "\n"
        )
        for change in item.result.data.changes:
            for side, path, content in [
                ("base", change.old_path, change.base_content),
                ("head", change.new_path, change.head_content),
            ]:
                if path is not None and content is not None:
                    target = case / side / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(content)
        for path, content in item.result.data.extra_tests.items():
            target = case / "head" / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content)
        saved += 1
    print(
        f"{saved} candidates saved; {errors} errors. Dippo must label before promoting to fixtures."
    )
    return 3 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
