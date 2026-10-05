"""Local first-parent history scanning shared by the two developer scripts."""

import contextlib
import io
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from goodhart.engine import ScanResult, scan
from goodhart.git import InputError, load_git, resolve_ref


@dataclass
class CommitScan:
    sha: str
    subject: str
    result: ScanResult | None
    error: str | None = None
    stderr: str = ""


def commits(repo: Path, count: int, head: str) -> list[tuple[str, str]]:
    """List exactly N first-parent non-merge commits, newest first."""
    resolved = resolve_ref(repo, head)
    process = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "log",
            "--first-parent",
            "--no-merges",
            f"-n{count}",
            "--format=%H%x00%s",
            resolved,
            "--",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if process.returncode:
        raise InputError(process.stderr.strip())
    return [tuple(line.split("\0", 1)) for line in process.stdout.splitlines()]


def scan_commits(repo: Path, count: int, head: str = "HEAD") -> Iterator[CommitScan]:
    """Scan each commit against its first parent; record failures without losing rows."""
    for sha, subject in commits(repo, count, head):
        stderr = io.StringIO()
        result, error = None, None
        with contextlib.redirect_stderr(stderr):
            try:
                result = scan(load_git(base=sha + "~1", head=sha, cwd=repo))
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
        yield CommitScan(sha, subject, result, error, stderr.getvalue())
