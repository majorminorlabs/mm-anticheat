#!/usr/bin/env python3
"""Save local high/medium commit candidates for Dippo to label at Gate 2."""

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from history import scan_commits


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("count", type=int)
    parser.add_argument("--head", default="HEAD")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, help="Save scan counts and pinned provenance")
    args = parser.parse_args(argv)
    if args.count < 1:
        parser.error("count must be positive")
    saved, errors, scanned, existing = 0, 0, 0, 0
    failures = []
    for item in scan_commits(args.repo.resolve(), args.count, args.head):
        scanned += 1
        if item.error:
            print(f"ERROR {item.sha}: {item.error}")
            errors += 1
            failures.append({"commit": item.sha, "error": item.error})
            continue
        if not any(f.severity in {"high", "medium"} for f in item.result.findings):
            continue
        case = args.output / item.sha
        if case.exists():
            print(f"Existing candidate retained: {case}")
            existing += 1
            continue
        case.mkdir(parents=True)
        (case / "diff.patch").write_text(item.result.data.patch)
        meta = (
            'mode = "full"\nsource = "own-history"\nlabel = "unreviewed"\n'
            f'source_commit = "{item.sha}"\ndescription = {json.dumps(item.subject)}\n'
            f"source_repository = {json.dumps(str(args.repo.resolve()))}\n"
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
    summary = {
        "repository": str(args.repo.resolve()),
        "head": args.head,
        "requested": args.count,
        "scanned": scanned,
        "saved": saved,
        "existing": existing,
        "errors": errors,
        "failures": failures,
    }
    if args.summary:
        args.summary.parent.mkdir(parents=True, exist_ok=True)
        args.summary.write_text(json.dumps(summary, indent=2) + "\n")
    print(
        f"{scanned} commits scanned; {saved} candidates saved; {existing} retained; "
        f"{errors} errors. Dippo must label before promoting to fixtures."
    )
    return 3 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
