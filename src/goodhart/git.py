"""Read Git state with subprocesses; never execute repository code."""

import difflib
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from goodhart.classify import classify
from goodhart.config import Config
from goodhart.diffmodel import FileChange, parse_diff


class InputError(ValueError):
    """Invalid input or Git state."""


@dataclass
class ScanInput:
    """Resolved scan input passed to the engine."""

    mode: Literal["full", "patch"]
    changes: list[FileChange]
    base: str | None
    head: str | None
    repository: Path | None = None
    extra_tests: dict[str, str] = field(default_factory=dict)
    diagnostics: list[tuple[str, str]] = field(default_factory=list)


def _git(root: Path, *args: str, check: bool = True) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True,
        check=False,
    )
    if check and result.returncode:
        raise InputError(result.stderr.decode("utf8", errors="replace").strip())
    return result.stdout if result.returncode == 0 else b""


def repository_root(cwd: Path | None = None) -> Path:
    """Resolve the containing Git repository."""
    return Path(_git(cwd or Path.cwd(), "rev-parse", "--show-toplevel").decode().strip())


def resolve_ref(root: Path, ref: str) -> str:
    """Resolve a user ref to a commit, protecting against option injection."""
    return (
        _git(root, "rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}")
        .decode()
        .strip()
    )


def default_base(root: Path, head: str) -> str:
    """Find the upstream/main/master merge base, falling back to HEAD~1."""
    candidates = [
        "@{upstream}",
        "refs/heads/main",
        "refs/heads/master",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
    ]
    for candidate in candidates:
        try:
            target = resolve_ref(root, candidate)
            return _git(root, "merge-base", target, head).decode().strip()
        except InputError:
            continue
    return resolve_ref(root, "HEAD~1")


def _decode(raw: bytes, path: str) -> str:
    if b"\0" in raw:
        raise InputError(f"Binary content in {path}")
    try:
        return raw.decode("utf8")
    except UnicodeDecodeError as exc:
        raise InputError(f"Non-UTF-8 content in {path}: {exc}") from exc


def _read_content(root: Path, ref: str, path: str) -> str:
    if ref == "WORKTREE":
        target = root / path
        if target.is_symlink():
            raise InputError("Working-tree symlink content is not parsed")
        try:
            return _decode(target.read_bytes(), path)
        except OSError as exc:
            raise InputError(f"Cannot read {path}: {exc}") from exc
    # A ref:path argument is one argument; path cannot become a Git option.
    return _decode(_git(root, "show", f"{ref}:{path}"), path)


def load_patch(text: str, config: Config | None = None) -> ScanInput:
    """Load a standalone patch without accessing repository content."""
    return ScanInput("patch", parse_diff(text, config), None, None)


def load_git(
    *,
    base: str | None = None,
    head: str = "HEAD",
    working: bool = False,
    staged: bool = False,
    cwd: Path | None = None,
    config: Config | None = None,
) -> ScanInput:
    """Load a range, working tree, or index with both sides' file contents."""
    config = config or Config()
    root = repository_root(cwd)
    if working or staged:
        base_sha = resolve_ref(root, "HEAD")
        head_label = "WORKTREE" if working else "INDEX"
        args = ["--cached"] if staged else ["HEAD"]
    else:
        head_label = resolve_ref(root, head)
        requested = resolve_ref(root, base) if base else default_base(root, head_label)
        base_sha = _git(root, "merge-base", requested, head_label).decode().strip()
        args = [f"{base_sha}...{head_label}"]
    raw = _git(
        root,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--find-renames",
        "--no-color",
        "--unified=3",
        *args,
        "--",
    )
    text = raw.decode("utf8", errors="replace")
    diagnostics: list[tuple[str, str]] = []
    if working:
        untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
        for item in untracked.split(b"\0"):
            if not item:
                continue
            path = item.decode("utf8", errors="surrogateescape")
            if classify(path, None, config) == frozenset({"other"}):
                continue
            try:
                content = _read_content(root, "WORKTREE", path)
            except InputError as exc:
                diagnostics.append((path, str(exc)))
                continue
            text += "".join(
                difflib.unified_diff(
                    [],
                    content.splitlines(keepends=True),
                    fromfile="/dev/null",
                    tofile=f"b/{path}",
                )
            )
            if content and not content.endswith("\n"):
                text += "\n"
    changes = parse_diff(text, config)
    for change in changes:
        if change.is_binary or change.parse_error:
            continue
        for side, ref, path in (
            ("base", base_sha, change.old_path),
            ("head", head_label, change.new_path),
        ):
            if path is None:
                content = None
            else:
                try:
                    content = _read_content(root, "" if ref == "INDEX" else ref, path)
                except InputError as exc:
                    change.parse_error = str(exc)
                    content = None
            setattr(change, f"{side}_content", content)
        change.old_kinds = classify(
            change.old_path or change.path,
            change.base_content,
            config,
        )
        change.new_kinds = classify(
            change.new_path or change.path,
            change.head_content,
            config,
        )
    return ScanInput("full", changes, base_sha, head_label, root, diagnostics=diagnostics)
