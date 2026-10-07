"""Native session and Stop protocols, using the already imported installed scanner."""

import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

from mm_anticheat.capture import save
from mm_anticheat.cli import Parser
from mm_anticheat.engine import scan
from mm_anticheat.git import InputError, _git, load_git, repository_root, resolve_ref
from mm_anticheat.report.text import render


def session_file(root: Path, session_id: object) -> Path | None:
    """Use a validated session identifier under this worktree's actual Git directory."""
    if session_id is None:
        return None
    if not isinstance(session_id, str) or not re.fullmatch(r"[\w-]{1,200}", session_id):
        raise ValueError("Invalid session_id")
    git_dir = Path(_git(root, "rev-parse", "--absolute-git-dir").decode().strip())
    directory = git_dir / "anticheat"
    if directory.is_symlink():
        raise ValueError("Session directory must not be a symlink")
    path = directory / ("session-" + session_id)
    if path.is_symlink():
        raise ValueError("Session base must not be a symlink")
    return path


def hook_base(root: Path, saved: Path | None, alerts: list[str] | None = None) -> str:
    """Cover the session's commits, then fall back to an upstream/default merge base."""
    alerts = alerts if alerts is not None else []
    if saved and saved.exists():
        try:
            record = json.loads(saved.read_text())
            anchor_path = saved.with_suffix(".start")
            if anchor_path.is_symlink():
                raise ValueError("Session anchor must not be a symlink")
            anchor = json.loads(anchor_path.read_text())
            base = resolve_ref(root, record["base"])
            start = datetime.fromisoformat(anchor["started_at"]).timestamp()
            recorded_start = datetime.fromisoformat(record["started_at"]).timestamp()
            if not isinstance(record["base"], str) or start > datetime.now(UTC).timestamp():
                raise ValueError("Invalid session time/base")
            # The original record is a tripwire anchor, not a security boundary.
            # Commit seconds have one-second precision; exclude the original base.
            commits = (
                _git(root, "log", "--first-parent", "--format=%H %ct", f"{anchor['base']}..HEAD")
                .decode()
                .splitlines()
            )
            recent = [
                (sha, int(date))
                for sha, date in (line.split() for line in commits)
                if int(date) >= int(start) and sha != anchor["base"]
            ]
            crossed = any(
                _git(root, "merge-base", sha, base).decode().strip() == sha for sha, _ in recent
            )
            moved_time = recent and int(recorded_start) > min(date for _, date in recent)
            if record != anchor or crossed or moved_time:
                alerts.append("Session base moved past session commits")
                # Do not trust a rewritten base: scan from the original anchor too.
                base = resolve_ref(root, anchor["base"])
            print(f"mm-anticheat: using session base {base}", file=sys.stderr)
            return base
        except (OSError, ValueError, KeyError, TypeError) as exc:
            alerts.append("Session base moved past session commits")
            print(
                f"mm-anticheat: invalid session record ({exc}); using branch fallback",
                file=sys.stderr,
            )
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
            print(f"anticheat: using merge base with {candidate}: {base}", file=sys.stderr)
            return base
        except InputError:
            continue
    print(
        "anticheat: using HEAD fallback; committed changes are not covered; install SessionStart",
        file=sys.stderr,
    )
    return head


def main(argv: list[str] | None = None) -> int:
    """Record session bases; block high findings and warn on unresolved continuations."""
    parser = Parser(prog="mm-anticheat-hook")
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
                    record = (
                        json.dumps(
                            {
                                "base": resolve_ref(root, "HEAD"),
                                "started_at": datetime.now(UTC).isoformat(),
                            }
                        )
                        + "\n"
                    )
                    handle.write(record)
                saved.with_suffix(".start").write_text(record)
                saved.with_suffix(".start").chmod(0o600)
                saved.chmod(0o600)
            except FileExistsError:
                alerts = []
                hook_base(root, saved, alerts)
                if alerts:
                    raise ValueError("Existing session record failed integrity check")
            if args.agent == "codex":
                print("{}")
            return 0
        alerts = []
        base = hook_base(root, saved, alerts)
        result = scan(load_git(working=True, base=base, cwd=root))
        from mm_anticheat.rules.base import Finding

        for title in alerts:
            result.findings.append(
                Finding(
                    "AC007",
                    "test-config-tampered",
                    "high",
                    "normal",
                    str(saved.relative_to(root))
                    if saved and saved.is_relative_to(root)
                    else ".git/anticheat/session",
                    1,
                    title,
                    "Session base/start record changed or became invalid.",
                    "A changed session base can hide work committed by the agent.",
                    "Start a new session after human review; local records are not a sandbox.",
                )
            )
        for notice in result.data.notices:
            print(f"anticheat: {notice}", file=sys.stderr)
        blocked = result.exit_code("high") == 1
        active = payload.get("stop_hook_active", False)
        if blocked:
            print(render(result, color=False), end="", file=sys.stderr)
            location = "capture unavailable"
            try:
                capture = save(result, unresolved=active)
                location = str(capture.relative_to(root))
                print(f"anticheat: blocked scan saved to {capture}", file=sys.stderr)
            except OSError as exc:
                print(f"anticheat: capture failed; scan remains blocked: {exc}", file=sys.stderr)
            if active:
                count = sum(f.severity == "high" and not f.allowed for f in result.findings)
                print(
                    json.dumps(
                        {
                            "systemMessage": (
                                f"anticheat: {count} unresolved high findings, see {location}"
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
        print(f"mm-anticheat hook: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
