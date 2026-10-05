#!/usr/bin/env python3
"""Reproduce noise measurements on local repository history; no clone/network calls."""

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path

from history import scan_commits

from goodhart.git import resolve_ref


def measure(repo: Path, count: int, head: str = "HEAD") -> dict:
    """Return per-rule/severity counts, all highs and five examples per rule."""
    tally, examples, rows = Counter(), defaultdict(list), []
    for item in scan_commits(repo, count, head):
        findings = [asdict(f) for f in item.result.findings] if item.result else []
        tally.update((f["rule_id"], f["severity"]) for f in findings)
        for finding in findings:
            if len(examples[finding["rule_id"]]) < 5:
                examples[finding["rule_id"]].append(
                    {"commit": item.sha, "subject": item.subject, **finding}
                )
        rows.append(
            {
                "commit": item.sha,
                "subject": item.subject,
                "findings": findings,
                "error": item.error,
                "stderr": item.stderr,
            }
        )
    return {
        "repository": repo.name,
        "head": resolve_ref(repo, head),
        "requested_commits": count,
        "commits_scanned": len(rows),
        "commits_with_high": sum(
            any(f["severity"] == "high" for f in row["findings"]) for row in rows
        ),
        "commits_with_high_or_medium": sum(
            any(f["severity"] in {"high", "medium"} for f in row["findings"]) for row in rows
        ),
        "counts": [
            {"rule_id": key[0], "severity": key[1], "count": value}
            for key, value in sorted(tally.items())
        ],
        "examples": dict(sorted(examples.items())),
        "errors": sum(row["error"] is not None for row in rows),
        "stderr_lines": sum(len(row["stderr"].splitlines()) for row in rows),
        "rule_errors": sum(
            f["rule_id"] == "GH000" and bool(re.match(r"GH\d{3}: \w+Error:", f["evidence"]))
            for row in rows
            for f in row["findings"]
        ),
        "commits": rows,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repo", type=Path)
    parser.add_argument("count", type=int)
    parser.add_argument(
        "--head", default="HEAD", help="Pinned commit/ref (does not change checkout)"
    )
    parser.add_argument(
        "--json", type=Path, help="Save complete measurements, examples and high findings"
    )
    args = parser.parse_args(argv)
    if args.count < 1:
        parser.error("count must be positive")
    report = measure(args.repo.resolve(), args.count, args.head)
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, indent=2) + "\n")
    print(
        f"{report['repository']} {report['head']}: {report['commits_scanned']} commits; "
        f"{report['commits_with_high']} with high, "
        f"{report['commits_with_high_or_medium']} with high/medium"
    )
    for row in report["counts"]:
        print(f"{row['rule_id']} {row['severity']}: {row['count']}")
    for rule, examples in report["examples"].items():
        for example in examples:
            print(
                f"  {rule} {example['commit'][:8]} {example['severity']} "
                f"{example['file']}:{example['line']} {example['title']}"
            )
    print(
        f"errors: {report['errors']}; rule errors: {report['rule_errors']}; "
        f"stderr lines: {report['stderr_lines']}"
    )
    for row in report["commits"]:
        if row["stderr"]:
            print(row["stderr"], file=sys.stderr, end="")
        if row["error"]:
            print(f"ERROR {row['commit']}: {row['error']}")
    return (
        3
        if report["errors"] or report["rule_errors"] or report["commits_scanned"] != args.count
        else 0
    )


if __name__ == "__main__":
    raise SystemExit(main())
