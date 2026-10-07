"""Local first-parent history scanning shared by the two developer scripts."""

import contextlib
import io
import subprocess
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from mm_anticheat.classify import classify
from mm_anticheat.engine import ScanResult, scan
from mm_anticheat.git import InputError, ScanInput, load_git, load_patch, resolve_ref


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
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
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
                parents = subprocess.run(
                    [
                        "git",
                        "-c",
                        "core.fsmonitor=false",
                        "-c",
                        "core.untrackedCache=false",
                        "-C",
                        str(repo),
                        "rev-list",
                        "--parents",
                        "-n1",
                        sha,
                    ],
                    capture_output=True,
                    text=True,
                    check=True,
                ).stdout.split()
                data = (
                    load_git(base=sha + "~1", head=sha, cwd=repo)
                    if len(parents) > 1
                    else initial_commit(repo, sha)
                )
                result = scan(data)
            except Exception as exc:
                error = f"{type(exc).__name__}: {exc}"
        yield CommitScan(sha, subject, result, error, stderr.getvalue())


def initial_commit(repo: Path, sha: str) -> ScanInput:
    """Scan a root commit against the empty tree, retaining full head contents."""
    patch = subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-C",
            str(repo),
            "diff-tree",
            "--root",
            "--no-commit-id",
            "-p",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            sha,
            "--",
        ],
        capture_output=True,
        check=True,
    ).stdout.decode("utf8", errors="replace")
    data = load_patch(patch)
    data.mode, data.head, data.repository = "full", sha, repo
    for change in data.changes:
        if change.is_binary or change.parse_error or change.new_path is None:
            continue
        raw = subprocess.run(
            [
                "git",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-C",
                str(repo),
                "show",
                f"{sha}:{change.new_path}",
            ],
            capture_output=True,
            check=True,
        ).stdout
        try:
            if b"\0" in raw:
                raise ValueError("Binary content")
            change.head_content = raw.decode("utf8")
            change.new_kinds = classify(change.new_path, change.head_content, data.config)
        except (UnicodeError, ValueError) as exc:
            change.parse_error = str(exc)
    return data
