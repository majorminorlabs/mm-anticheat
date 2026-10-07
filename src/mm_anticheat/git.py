"""Read Git state with subprocesses; never execute repository code."""

import ast
import difflib
import json
import posixpath
import re
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from mm_anticheat.classify import classify, matches
from mm_anticheat.config import Config, parse_config
from mm_anticheat.diffmodel import FileChange, parse_diff


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
    notices: list[str] = field(default_factory=list)
    config: Config = field(default_factory=Config)
    patch: str = ""
    hidden_paths: list[str] = field(default_factory=list)
    extra_configs: dict[str, str] = field(default_factory=dict)


def _git(root: Path, *args: str, check: bool = True, allow_no_matches: bool = False) -> bytes:
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-C",
            str(root),
            *args,
        ],
        capture_output=True,
        check=False,
    )
    if check and result.returncode and not (allow_no_matches and result.returncode == 1):
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
            merged = _git(root, "merge-base", target, head).decode().strip()
            return resolve_ref(root, f"{head}~1") if merged == head else merged
        except InputError:
            continue
    return resolve_ref(root, f"{head}~1")


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
    config = config or Config()
    return ScanInput("patch", parse_diff(text, config), None, None, config=config, patch=text)


def trusted_config(root: Path, ref: str, source: str) -> Config:
    """Use only the tracked .anticheat.toml on the trusted side, never the worktree."""
    if not _git(root, "ls-tree", "--name-only", ref, "--", ".anticheat.toml").strip():
        return Config()
    return parse_config(_read_content(root, ref, ".anticheat.toml"), source)


def _imports_touched(content: str, path: str, sources: set[str]) -> bool:
    if path.endswith(".py"):
        modules = {
            source.removesuffix(".py").replace("/", ".")
            for source in sources
            if source.endswith(".py")
        }
        modules |= {module.removeprefix("src.") for module in modules}
        try:
            from mm_anticheat.lang import python

            tree = python.parse(content)
        except (SyntaxError, RecursionError, ValueError):
            return False
        for node in ast.walk(tree):
            imported = []
            if isinstance(node, ast.Import):
                imported = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                parent = node.module or ""
                imported = [parent] + [parent + "." + alias.name for alias in node.names]
            if any(module in modules for module in imported):
                return True
        return False
    for module in re.findall(r"(?:from\s*|require\s*\(\s*|import\s*)['\"]([^'\"]+)['\"]", content):
        resolved = (
            posixpath.normpath(posixpath.join(posixpath.dirname(path), module))
            if module.startswith(".")
            else module
        )
        if any(resolved == source or resolved == source.rsplit(".", 1)[0] for source in sources):
            return True
    return False


def _related_tests(
    root: Path,
    head: str,
    changes: list[FileChange],
    config: Config,
) -> tuple[dict[str, str], list[tuple[str, str]]]:
    sources = {change.path for change in changes if "source" in change.new_kinds}
    if not sources:
        return {}, []
    if head in {"INDEX", "WORKTREE"}:
        paths = _git(root, "ls-files", "-z").split(b"\0")
        if head == "WORKTREE":
            paths += _git(root, "ls-files", "--others", "--exclude-standard", "-z").split(b"\0")
    else:
        paths = _git(root, "ls-tree", "-r", "--name-only", "-z", head).split(b"\0")
    changed = {change.path for change in changes}
    candidates = []
    for raw in sorted(set(paths)):
        if not raw:
            continue
        path = raw.decode("utf8", errors="surrogateescape")
        if path in changed or not path.endswith(
            (".py", ".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts")
        ):
            continue
        if classify(path, None, config) == frozenset({"other"}):
            continue
        candidates.append(path)
    from mm_anticheat.lang.branches import branch_literals

    search = sorted(value for value in branch_literals(changes) if "\0" not in value)
    broad = set()
    if search:
        options = ["grep", "--no-textconv", "-F", "-l", "-z"]
        if head == "INDEX":
            options.append("--cached")
        elif head == "WORKTREE":
            options.append("--untracked")
        for value in search:
            options.extend(["-e", value])
        if head not in {"INDEX", "WORKTREE"}:
            options.append(head)
        options.extend(["--", "."])
        hits = _git(root, *options, allow_no_matches=True).split(b"\0")
        for raw in hits:
            path = raw.decode("utf8", errors="surrogateescape")
            if head not in {"INDEX", "WORKTREE"}:
                path = path.removeprefix(head + ":")
            if path in candidates:
                broad.add(path)
    contents, errors = _batch_contents(root, "" if head == "INDEX" else head, candidates)
    result = {}
    diagnostics = [
        (path, reason) for path, reason in errors if "test" in classify(path, None, config)
    ]
    for path, content in contents.items():
        from mm_anticheat.lang import limit_reason

        if reason := limit_reason(content):
            if "test" in classify(path, None, config):
                diagnostics.append((path, reason))
            continue
        if "test" in classify(path, content, config) and (
            path in broad or _imports_touched(content, path, sources)
        ):
            result[path] = content
    return result, diagnostics


def _batch_contents(
    root: Path,
    ref: str,
    paths: list[str],
) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """Read related-file candidates in one Git process for large repositories."""
    contents, errors = {}, []
    if not paths:
        return contents, errors
    if ref == "WORKTREE":
        for path in paths:
            try:
                contents[path] = _read_content(root, ref, path)
            except InputError as exc:
                errors.append((path, str(exc)))
        return contents, errors
    safe = [path for path in paths if "\n" not in path and "\r" not in path]
    query = "".join(f"{ref}:{path}\n" for path in safe).encode("utf8", errors="surrogateescape")
    result = subprocess.run(
        [
            "git",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-C",
            str(root),
            "cat-file",
            "--batch",
        ],
        input=query,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise InputError(result.stderr.decode("utf8", errors="replace"))
    raw, offset = result.stdout, 0
    for path in safe:
        end = raw.find(b"\n", offset)
        header = raw[offset:end].split()
        offset = end + 1
        if not header or header[-1] == b"missing":
            errors.append((path, "Content is unavailable at the scanned head"))
            continue
        size = int(header[-1])
        body = raw[offset : offset + size]
        offset += size + 1
        try:
            contents[path] = _decode(body, path)
        except InputError as exc:
            errors.append((path, str(exc)))
    for path in set(paths) - set(safe):
        try:
            contents[path] = _read_content(root, ref, path)
        except InputError as exc:
            errors.append((path, str(exc)))
    return contents, errors


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
    root = repository_root(cwd)
    if working or staged:
        base_sha = resolve_ref(root, base or "HEAD")
        head_label = "WORKTREE" if working else "INDEX"
        args = ["--cached"] if staged else [base_sha]
    else:
        head_label = resolve_ref(root, head)
        requested = resolve_ref(root, base) if base else default_base(root, head_label)
        base_sha = _git(root, "merge-base", requested, head_label).decode().strip()
        args = [f"{base_sha}...{head_label}"]
    config = config or trusted_config(
        root, base_sha, "HEAD" if (working or staged) and base is None else f"base:{base_sha}"
    )
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
        ".",
        ":(exclude).anticheat/captures/**",
    )
    text = raw.decode("utf8", errors="replace")
    diagnostics: list[tuple[str, str]] = []
    if working:
        untracked = _git(root, "ls-files", "--others", "--exclude-standard", "-z")
        for item in untracked.split(b"\0"):
            if not item:
                continue
            path = item.decode("utf8", errors="surrogateescape")
            if path.startswith(".anticheat/captures/"):
                continue
            if any(matches(path, pattern) for pattern in config.ignore_globs):
                continue
            try:
                content = _read_content(root, "WORKTREE", path)
            except InputError as exc:
                diagnostics.append((path, str(exc)))
                continue
            old_name, new_name = json.dumps("a/" + path), json.dumps("b/" + path)
            text += f"diff --git {old_name} {new_name}\nnew file mode 100644\n"
            text += "".join(
                difflib.unified_diff(
                    [],
                    [line + "\n" for line in content.splitlines()],
                    fromfile="/dev/null",
                    tofile=new_name,
                )
            )
    hidden_paths = []
    if working or staged:
        # Read flagged files ourselves: Git deliberately omits their worktree edits.
        flagged = {}
        for entry in _git(root, "ls-files", "-v", "-z").split(b"\0"):
            if not entry or not (entry[:1] in {b"S", b"s"} or entry[:1].islower()):
                continue
            path = entry[2:].decode("utf8", errors="surrogateescape")
            try:
                indexed = _read_content(root, "", path)
                target = root / path
                current = _read_content(root, "WORKTREE", path) if target.exists() else None
            except InputError as exc:
                diagnostics.append((path, str(exc)))
                hidden_paths.append(path)
                continue
            if current == indexed:
                continue
            hidden_paths.append(path)
            try:
                previous = _read_content(root, base_sha, path)
            except InputError:
                previous = ""
            old_name, new_name = json.dumps("a/" + path), json.dumps("b/" + path)
            flagged[path] = f"diff --git {old_name} {new_name}\n" + "".join(
                difflib.unified_diff(
                    previous.splitlines(True),
                    (current or "").splitlines(True),
                    fromfile=old_name,
                    tofile=new_name if current is not None else "/dev/null",
                )
            )
        if flagged:
            parts = re.split(r"(?=^diff --git )", text, flags=re.M)
            text = "".join(
                part
                for part in parts
                if not any(change.path in flagged for change in parse_diff(part, config))
            ) + "".join(flagged.values())
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
                    content = _read_content(
                        root,
                        "WORKTREE"
                        if side == "head" and path in hidden_paths
                        else ""
                        if ref == "INDEX"
                        else ref,
                        path,
                    )
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
    if any(
        change.old_path
        and change.new_path
        and change.old_path != change.new_path
        and "test" in change.old_kinds
        for change in changes
    ):
        from mm_anticheat.lang.collection import runner_patterns

        paths = ["pytest.ini", "setup.cfg", "tox.ini", "pyproject.toml"]
        paths += [
            raw.decode()
            for raw in _git(root, "ls-tree", "-r", "--name-only", "-z", base_sha).split(b"\0")
            if raw and re.search(rb"(?:jest|vitest)\.config\.", raw)
        ]
        contents = {
            path: _git(root, "show", f"{base_sha}:{path}", check=False).decode(
                "utf8", errors="replace"
            )
            for path in paths
        }
        runner_patterns(config, contents)
    extra_configs = {}
    config_errors = []
    if any(
        not c.path.endswith(".py") and any("process.exit" in line.value for line in c.added)
        for c in changes
    ):
        if head_label in {"INDEX", "WORKTREE"}:
            config_paths = _git(root, "ls-files", "-z").split(b"\0")
            if head_label == "WORKTREE":
                config_paths += _git(
                    root, "ls-files", "--others", "--exclude-standard", "-z"
                ).split(b"\0")
        else:
            config_paths = _git(root, "ls-tree", "-r", "--name-only", "-z", head_label).split(b"\0")
        config_paths = [
            raw.decode("utf8", errors="surrogateescape")
            for raw in config_paths
            if re.search(rb"(?:jest|vitest)\.config\.", raw)
        ]
        extra_configs, config_errors = _batch_contents(
            root, "" if head_label == "INDEX" else head_label, config_paths
        )
    related, errors = _related_tests(root, head_label, changes, config)
    notices = [f"No changes in resolved range {base_sha}...{head_label}"] if not changes else []
    if any(".anticheat.toml" in {change.old_path, change.new_path} for change in changes):
        notices.append(
            "using base-side config; .anticheat.toml changed in this diff"
            if not config.source.startswith("--config ")
            else "using explicit config; .anticheat.toml changed in this diff"
        )
    return ScanInput(
        "full",
        changes,
        base_sha,
        head_label,
        root,
        extra_tests=related,
        diagnostics=diagnostics + errors + config_errors,
        extra_configs=extra_configs,
        notices=notices,
        config=config,
        patch=text,
        hidden_paths=hidden_paths,
    )
