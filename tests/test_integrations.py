"""Real subprocess checks for staged gates, Stop protocols, captures and CI reports."""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from goodhart.cli import main

from .conftest import git

ROOT = Path(__file__).resolve().parents[1]


def weaken(repo):
    (repo / "tests/test_a.py").write_text(
        'import pytest\n\n@pytest.mark.skip(reason="blocked")\ndef test_a():\n    assert 3 == 3\n'
    )


def invoke_hook(repo, agent, active=False):
    return subprocess.run(
        [sys.executable, "-m", "goodhart.hooks", "--agent", agent],
        input=json.dumps({"cwd": str(repo), "hook_event_name": "Stop", "stop_hook_active": active}),
        text=True,
        capture_output=True,
    )


@pytest.mark.parametrize("agent", ["claude", "codex"])
def test_stop_blocks_captures_then_passes_after_revert(repo, agent):
    weaken(repo)
    # Include a new source file in the exact captured working diff.
    (repo / "fresh.py").write_text("answer = 42\n")
    run = invoke_hook(repo, agent)
    assert run.returncode == 2 and "GH003" in run.stderr
    assert run.stdout == ""
    capture = next((repo / ".goodhart/captures").iterdir())
    data = json.loads((capture / "findings.json").read_text())
    assert any(f["rule_id"] == "GH003" and not f["allowed"] for f in data["findings"])
    assert "fresh.py" in (capture / "diff.patch").read_text()
    assert ".goodhart/captures/" not in (capture / "diff.patch").read_text()
    if os.name == "posix":
        assert (capture / "findings.json").stat().st_mode & 0o777 == 0o600
    # A loop-protected invocation scans and saves unresolved findings.
    assert invoke_hook(repo, agent, True).returncode == 0
    assert len(list((repo / ".goodhart/captures").iterdir())) == 2
    # Repeated blocks are distinct, and never include old capture contents.
    assert invoke_hook(repo, agent).returncode == 2
    assert len(list((repo / ".goodhart/captures").iterdir())) == 3
    git(repo, "checkout", "--", "tests/test_a.py")
    (repo / "fresh.py").unlink()
    clean = invoke_hook(repo, agent)
    assert clean.returncode == 0
    assert clean.stdout == ("{}\n" if agent == "codex" else "")


def test_capture_preserves_block_when_write_fails(repo, monkeypatch, capsys):
    weaken(repo)
    (repo / ".goodhart").symlink_to(repo / "tests", target_is_directory=True)
    monkeypatch.chdir(repo)
    assert main(["scan", "--working", "--capture-on-block"]) == 1
    assert "must not be a symlink" in capsys.readouterr().err
    assert not (repo / "tests/captures").exists()
    assert invoke_hook(repo, "claude").returncode == 2


def test_staged_hook_ignores_unstaged_revert(repo, monkeypatch):
    weaken(repo)
    git(repo, "add", "tests/test_a.py")
    (repo / "tests/test_a.py").write_text("def test_a():\n    assert 3 == 3\n")
    monkeypatch.chdir(repo)
    assert main(["scan", "--staged"]) == 1
    assert main(["scan", "--working"]) == 0


def test_invalid_hook_payload_is_error_not_block(repo):
    run = subprocess.run(
        [sys.executable, "-m", "goodhart.hooks", "--agent", "codex"],
        input="[]",
        text=True,
        capture_output=True,
        cwd=repo,
    )
    assert run.returncode == 3 and run.stdout == ""
    usage = subprocess.run(
        [sys.executable, "-m", "goodhart.hooks", "--agent", "unknown"],
        text=True,
        capture_output=True,
    )
    assert usage.returncode == 3


def test_action_adapter_summary_and_exit_on_real_pr_range(repo, tmp_path):
    base = git(repo, "rev-parse", "HEAD")
    weaken(repo)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "skip existing test")
    event, summary = tmp_path / "event.json", tmp_path / "summary.md"
    event.write_text(json.dumps({"number": 7, "pull_request": {"base": {"sha": base}}}))
    env = {
        **os.environ,
        "GITHUB_EVENT_PATH": str(event),
        "GITHUB_SHA": git(repo, "rev-parse", "HEAD"),
        "GITHUB_STEP_SUMMARY": str(summary),
        "GOODHART_COMMENT": "false",
        "GOODHART_FAIL_ON": "high",
        "GOODHART_CONFIG": "",
    }
    run = subprocess.run(
        [sys.executable, str(ROOT / "scripts/action_scan.py")],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )
    assert run.returncode == 1
    assert "GH003" in summary.read_text()
    env["GITHUB_SHA"] = base
    run = subprocess.run(
        [sys.executable, str(ROOT / "scripts/action_scan.py")],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )
    assert run.returncode == 0


def action_module():
    spec = importlib.util.spec_from_file_location("action_scan", ROOT / "scripts/action_scan.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_comment_updates_marked_bot_only_and_paginates(monkeypatch):
    module = action_module()
    calls = []
    unrelated = {"user": {"login": "person"}, "body": module.MARKER, "id": 1}

    def fake(api, token, route, body=None, method="GET"):
        calls.append((route, method, body))
        if "&page=1" in route:
            return [unrelated] * 100
        if "&page=2" in route:
            return [{"user": {"login": "github-actions[bot]"}, "body": module.MARKER, "id": 42}]
        return {}

    monkeypatch.setattr(module, "request", fake)
    monkeypatch.setenv("GITHUB_TOKEN", "test-token")
    module.comment("owner/repo", 7, "report")
    assert calls[-1] == (
        "/repos/owner/repo/issues/comments/42",
        "PATCH",
        {"body": module.MARKER + "\nreport"},
    )
    assert len(calls) == 3


def test_root_history_export_and_repeat_preserves_labels(repo, tmp_path):
    (repo / "worker.py").write_text('import os\nci = os.environ.get("CI")\n')
    git(repo, "add", ".")
    git(repo, "commit", "--amend", "--no-edit")
    output, summary = tmp_path / "candidates", tmp_path / "counts.json"
    command = [
        sys.executable,
        str(ROOT / "scripts/scan_history.py"),
        str(repo),
        "300",
        "--output",
        str(output),
        "--summary",
        str(summary),
    ]
    run = subprocess.run(command, text=True, capture_output=True)
    assert run.returncode == 0, run.stderr
    counts = json.loads(summary.read_text())
    assert counts["scanned"] == 1 and counts["errors"] == 0 and counts["saved"] == 1
    case = next(output.iterdir())
    assert "worker.py" in (case / "diff.patch").read_text()
    meta = case / "meta.toml"
    meta.write_text(meta.read_text().replace('label = "unreviewed"', 'label = "unclear"'))
    before = meta.read_bytes()
    assert subprocess.run(command, capture_output=True).returncode == 0
    assert meta.read_bytes() == before
    assert json.loads(summary.read_text())["existing"] == 1
