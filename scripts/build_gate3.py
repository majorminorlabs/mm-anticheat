#!/usr/bin/env python3
"""Build the review ZIP exclusively from the clean, committed source tree."""

import argparse
import io
import json
import subprocess
import zipfile
from datetime import UTC, datetime
from pathlib import Path


def git(*args: str) -> bytes:
    """Disable repository performance hooks for every build-time Git read."""
    return subprocess.check_output(
        ["git", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", *args]
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("dist/mm-anticheat-holdout.zip"))
    parser.add_argument("--tests-passed", type=int, required=True)
    args = parser.parse_args()
    if args.tests_passed < 1:
        parser.error("--tests-passed must be positive")
    if git("status", "--porcelain").strip():
        parser.error("Commit all source changes before building")
    commit = git("rev-parse", "HEAD").decode().strip()
    payload = git("archive", "--format=zip", "--prefix=mm-anticheat/", commit)
    buffer = io.BytesIO(payload)
    noise = [json.loads(path.read_text()) for path in Path("docs/noise-results").glob("*.json")]
    history = json.loads(Path("docs/b2-rescan-review04.json").read_text())
    metadata = {
        "source_commit": commit,
        "built_at": datetime.now(UTC).isoformat(),
        "gate": "REVIEW_04 / awaiting holdout and GO",
        "tests_passed": args.tests_passed,
        "noise_commits": sum(row["commits_scanned"] for row in noise),
        "noise_high_commits": sum(row["commits_with_high"] for row in noise),
        "noise_ac006_high": sum(
            count["count"]
            for row in noise
            for count in row["counts"]
            if count["rule_id"] == "AC006" and count["severity"] == "high"
        ),
        "b2_commits": sum(row["scanned"] for row in history),
        "b2_high_commits": sum(row["high"] for row in history),
        "b1": "invalid; retained and not rerun",
        "hosted_action": "clean PR passes; classic cheat PR scanner fails",
        "branch_protection": "blocked: GitHub Pro required for private repository",
        "criteria_through_step3_met": False,
        "study": json.loads(Path("docs/agent-study-summary.json").read_text()),
        "publication": "not authorized until Dippo replies GO",
    }
    with zipfile.ZipFile(buffer, "a", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mm-anticheat/BUILD_INFO.json", json.dumps(metadata, indent=2) + "\n")
        bad = archive.testzip()
        if bad:
            raise ValueError("ZIP integrity failure: " + bad)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(buffer.getvalue())
    print(f"{args.output}: {args.output.stat().st_size} bytes; source {commit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
