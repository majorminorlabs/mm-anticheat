"""Start or verify the detached AMD003 E014 runner."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


SESSION_NAME = "e014-amd003"
TERMINAL_STATES = {"COMPLETE", "FAILED"}


def runner_command(session_root: Path, repo_root: Path, resume: bool) -> list[str]:
    command = [
        sys.executable,
        str(repo_root / "scripts/run_e014_remote.py"),
        "run",
        "--session-root",
        str(session_root),
    ]
    if resume:
        command.append("--resume")
    return command


def tmux_command(session_name: str, session_root: Path, repo_root: Path, resume: bool) -> list[str]:
    command = runner_command(session_root, repo_root, resume)
    shell_command = f"cd {shlex.quote(str(repo_root))} && exec {shlex.join(command)}"
    return ["tmux", "new-session", "-d", "-s", session_name, "--", "bash", "-lc", shell_command]


def _read_status(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def _tmux_alive(session_name: str) -> bool:
    if shutil.which("tmux") is None:
        return False
    return subprocess.run(
        ["tmux", "has-session", "-t", session_name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def verify(session_root: Path, repo_root: Path, session_name: str = SESSION_NAME) -> dict[str, Any]:
    status = _read_status(session_root / "status.json")
    launch = _read_status(session_root / "runtime/launch.json")
    alive = _tmux_alive(session_name) if launch.get("mechanism") == "tmux" else _pid_alive(launch.get("runner_pid"))
    if not alive:
        alive = _tmux_alive(session_name) or _pid_alive(status.get("runner_pid"))
    state = status.get("state", "STARTING")
    return {
        "state": state,
        "detached": alive or state in TERMINAL_STATES,
        "process_alive": alive,
        "runner_pid": status.get("runner_pid") or launch.get("runner_pid"),
        "tmux_session": session_name if _tmux_alive(session_name) else None,
        "session_root": str(session_root),
        "repo_root": str(repo_root),
    }


def start(session_root: Path, repo_root: Path, resume: bool) -> int:
    status_path = session_root / "status.json"
    status = _read_status(status_path)
    current_state = status.get("state")
    existing = verify(session_root, repo_root)
    if current_state == "COMPLETE":
        print(json.dumps(existing, indent=2))
        print("E014 AMD003 ALREADY COMPLETE")
        return 0
    if current_state == "FAILED" and not resume:
        print("AMD003 is FAILED; use the explicit resume command to retry from the latest valid checkpoint.", file=sys.stderr)
        return 2
    if current_state == "RUNNING" and existing["process_alive"]:
        print(json.dumps(existing, indent=2))
        print("E014 AMD003 ALREADY RUNNING")
        print("REMOTE JOB IS DETACHED")
        return 0
    if current_state == "RUNNING" and not resume and status:
        print("AMD003 has a stale RUNNING marker; use the explicit resume command.", file=sys.stderr)
        return 2

    session_root.mkdir(parents=True, exist_ok=True)
    log_root = session_root / "runtime/logs"
    log_root.mkdir(parents=True, exist_ok=True)
    runner = runner_command(session_root, repo_root, resume)
    mechanism: str
    runner_pid: int | None = None
    if shutil.which("tmux"):
        command = tmux_command(SESSION_NAME, session_root, repo_root, resume)
        subprocess.run(command, cwd=repo_root, check=True)
        mechanism = "tmux"
    else:
        stdout = (log_root / "runner.stdout.log").open("ab")
        stderr = (log_root / "runner.stderr.log").open("ab")
        try:
            process = subprocess.Popen(
                runner,
                cwd=repo_root,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
        finally:
            stdout.close()
            stderr.close()
        runner_pid = process.pid
        mechanism = "nohup-start_new_session"
    launch = {
        "mechanism": mechanism,
        "runner_pid": runner_pid,
        "tmux_session": SESSION_NAME if mechanism == "tmux" else None,
        "command": runner,
    }
    launch_path = session_root / "runtime/launch.json"
    launch_path.parent.mkdir(parents=True, exist_ok=True)
    launch_path.write_text(json.dumps(launch, indent=2) + "\n", encoding="utf-8")
    time.sleep(1)
    result = verify(session_root, repo_root)
    if not result["detached"] or result["state"] == "FAILED":
        print(json.dumps(result, indent=2), file=sys.stderr)
        return 1
    print("E014 AMD003 STARTED")
    print("REMOTE JOB IS DETACHED")
    print("SAFE TO DISCONNECT SSH")
    print(json.dumps(result, indent=2))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-root", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        result = verify(args.session_root, args.repo_root)
        print(json.dumps(result, indent=2))
        return 0 if result["detached"] else 1
    return start(args.session_root, args.repo_root, args.resume)


if __name__ == "__main__":
    raise SystemExit(main())

