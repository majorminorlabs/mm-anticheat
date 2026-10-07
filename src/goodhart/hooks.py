"""Native session and Stop protocols, using the already imported installed scanner."""

import json
import re
import sys
from pathlib import Path

from goodhart.capture import save
from goodhart.cli import Parser
from goodhart.engine import scan
from goodhart.git import InputError, _git, load_git, repository_root, resolve_ref
from goodhart.report.text import render


def session_file(root: Path, session_id: object) -> Path | None:
    """Use a validated session identifier under this worktree's actual Git directory."""
    if session_id is None:
        return None
    if not isinstance(session_id, str) or not re.fullmatch(r"[\w-]{1,200}", session_id):
        raise ValueError("Invalid session_id")
    git_dir = Path(_git(root, "rev-parse", "--absolute-git-dir").decode().strip())
    directory = git_dir / "goodhart"
    if directory.is_symlink():
        raise ValueError("Session directory must not be a symlink")
    path = directory / ("session-" + session_id)
    if path.is_symlink():
        raise ValueError("Session base must not be a symlink")
    return path


def hook_base(root: Path, saved: Path | None) -> str:
    """Cover the session's commits, then fall back to an upstream/default merge base."""
    if saved and saved.exists():
        base = resolve_ref(root, saved.read_text().strip())
        print(f"goodhart: using session base {base}", file=sys.stderr)
        return base
    head = resolve_ref(root, "HEAD")
    for candidate in (
        "@{upstream}",
        "refs/remotes/origin/HEAD",
        "refs/remotes/origin/main",
        "refs/remotes/origin/master",
        "refs/heads/main",
        "refs/heads/master",
    ):
        try:
            target = resolve_ref(root, candidate)
            # The current default branch cannot cover commits made on itself.
            if target == head:
                continue
            base = _git(root, "merge-base", target, head).decode().strip()
            print(f"goodhart: using merge base with {candidate}: {base}", file=sys.stderr)
            return base
        except InputError:
            continue
    print(
        "goodhart: using HEAD fallback; committed changes are not covered; install SessionStart",
        file=sys.stderr,
    )
    return head


def main(argv: list[str] | None = None) -> int:
    """Record session bases; block high findings and warn on unresolved continuations."""
    parser = Parser(prog="goodhart-stop-hook")
    parser.add_argument("--agent", choices=("claude", "codex"), required=True)
    parser.add_argument("--event", choices=("Stop", "SessionStart"), default="Stop")
    args = parser.parse_args(argv)
    try:
        raw = sys.stdin.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("Hook input exceeds 1 MB")
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("Hook input must be a JSON object")
        if payload.get("hook_event_name", args.event) != args.event:
            raise ValueError(f"This wrapper accepts only {args.event} events")
        if not isinstance(payload.get("stop_hook_active", False), bool):
            raise ValueError("stop_hook_active must be a boolean")
        cwd = payload.get("cwd", str(Path.cwd()))
        if not isinstance(cwd, str):
            raise ValueError("cwd must be a path string")
        root = repository_root(Path(cwd))
        saved = session_file(root, payload.get("session_id"))
        if args.event == "SessionStart":
            if saved is None:
                raise ValueError("SessionStart requires session_id")
            saved.parent.mkdir(mode=0o700, exist_ok=True)
            # Resume/compact must retain the original base, not hide prior commits.
            try:
                with saved.open("x", encoding="utf8") as handle:
                    handle.write(resolve_ref(root, "HEAD") + "\n")
                saved.chmod(0o600)
            except FileExistsError:
                resolve_ref(root, saved.read_text().strip())
            if args.agent == "codex":
                print("{}")
            return 0
        result = scan(load_git(working=True, base=hook_base(root, saved), cwd=root))
        for notice in result.data.notices:
            print(f"goodhart: {notice}", file=sys.stderr)
        blocked = result.exit_code("high") == 1
        active = payload.get("stop_hook_active", False)
        if blocked:
            print(render(result, color=False), end="", file=sys.stderr)
            location = "capture unavailable"
            try:
                capture = save(result, unresolved=active)
                location = str(capture.relative_to(root))
                print(f"goodhart: blocked scan saved to {capture}", file=sys.stderr)
            except OSError as exc:
                print(f"goodhart: capture failed; scan remains blocked: {exc}", file=sys.stderr)
            if active:
                count = sum(f.severity == "high" and not f.allowed for f in result.findings)
                print(
                    json.dumps(
                        {
                            "systemMessage": (
                                f"goodhart: {count} unresolved high findings, see {location}"
                            )
                        }
                    )
                )
                return 0
            return 2
        if args.agent == "codex":
            print("{}")
        return 0
    except (OSError, ValueError) as exc:
        print(f"goodhart hook: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
