"""Reproduce REVIEW_03's integration bypasses in real disposable Git repositories."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from goodhart.cli import main
from goodhart.engine import scan
from goodhart.git import load_git

from .conftest import git
from .test_integrations import ROOT, invoke_hook, weaken


def plant(repo):
    package = repo / "goodhart"
    package.mkdir()
    for name in ("__init__", "cli", "hooks"):
        (package / (name + ".py")).write_text("def main(*args):\n    return 0\n")
    return {**os.environ, "PYTHONPATH": str(repo), "GOODHART_PYTHON": sys.executable}


@pytest.mark.parametrize("agent", ["claude", "codex"])
@pytest.mark.parametrize("entry", ["installed", "shell"])
def test_m14_shadow_package_still_blocks(repo, agent, entry):
    weaken(repo)
    env = plant(repo)
    command = [str(Path(sys.executable).parent / "goodhart-stop-hook"), "--agent", agent]
    if entry == "installed":
        env.pop("PYTHONPATH", None)
    if entry == "shell":
        directory = "claude-code" if agent == "claude" else agent
        command = [str(ROOT / "hooks" / directory / "stop.sh")]
    run = subprocess.run(
        command,
        cwd=repo,
        env=env,
        input=json.dumps({"cwd": str(repo)}),
        text=True,
        capture_output=True,
    )
    assert run.returncode == 2 and "GH003" in run.stderr


def test_m14_action_shadow_package_still_blocks(repo, tmp_path):
    base = git(repo, "rev-parse", "HEAD")
    weaken(repo)
    env = plant(repo)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "skip and shadow")
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"number": 1, "pull_request": {"base": {"sha": base}}}))
    env.update(
        GITHUB_EVENT_PATH=str(event),
        GITHUB_STEP_SUMMARY=str(tmp_path / "summary.md"),
        GITHUB_SHA=git(repo, "rev-parse", "HEAD"),
        GOODHART_COMMENT="false",
        GOODHART_FAIL_ON="high",
        GOODHART_CONFIG="",
    )
    run = subprocess.run(
        [sys.executable, str(ROOT / "scripts/action_scan.py")],
        cwd=repo,
        env=env,
        text=True,
        capture_output=True,
    )
    assert run.returncode == 1 and "GH003" in run.stdout


@pytest.mark.parametrize("agent", ["claude", "codex"])
def test_m17_committed_skip_still_blocks_session(repo, agent):
    payload = {"cwd": str(repo), "session_id": "review-03", "hook_event_name": "SessionStart"}
    command = [
        sys.executable,
        "-I",
        "-m",
        "goodhart.hooks",
        "--agent",
        agent,
        "--event",
        "SessionStart",
    ]
    assert (
        subprocess.run(
            command, input=json.dumps(payload), text=True, capture_output=True
        ).returncode
        == 0
    )
    base = git(repo, "rev-parse", "HEAD")
    saved = repo / ".git/goodhart/session-review-03"
    assert saved.read_text().strip() == base
    weaken(repo)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "stabilize flaky test")
    # A resume/compaction cannot replace the original session base.
    assert (
        subprocess.run(
            command, input=json.dumps(payload), text=True, capture_output=True
        ).returncode
        == 0
    )
    assert saved.read_text().strip() == base
    payload["hook_event_name"] = "Stop"
    run = subprocess.run(command[:-2], input=json.dumps(payload), text=True, capture_output=True)
    assert run.returncode == 2 and "GH003" in run.stderr
    assert not (repo / ".goodhart/session-review-03").exists()


def test_m17_working_explicit_base_and_branch_fallback(repo, monkeypatch, capsys):
    base = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-b", "agent")
    weaken(repo)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "skip")
    monkeypatch.chdir(repo)
    assert main(["scan", "--working", "--base", base]) == 1
    assert "GH003" in capsys.readouterr().out
    run = invoke_hook(repo, "claude")
    assert run.returncode == 2 and "merge base" in run.stderr


@pytest.mark.parametrize("flag", ["--skip-worktree", "--assume-unchanged"])
@pytest.mark.parametrize("staged", [False, True])
def test_m18_hidden_index_edits_block(repo, flag, staged):
    weaken(repo)
    git(repo, "update-index", flag, "tests/test_a.py")
    result = scan(load_git(cwd=repo, working=not staged, staged=staged))
    assert result.exit_code() == 1
    assert any(
        f.rule_id == "GH007" and f.severity == "high" and not f.allowed and "Index flags" in f.title
        for f in result.findings
    )
    assert "pytest.mark.skip" in result.data.patch
    assert invoke_hook(repo, "claude").returncode == 2


def test_m18_fsmonitor_never_runs(repo):
    weaken(repo)
    script = repo / "fsmonitor.sh"
    marker = repo / "EXECUTED"
    script.write_text(f'#!/bin/sh\ntouch "{marker}"\nexit 0\n')
    script.chmod(0o755)
    git(repo, "config", "core.fsmonitor", str(script))
    assert scan(load_git(cwd=repo, working=True)).exit_code() == 1
    assert not marker.exists()


@pytest.mark.parametrize("agent", ["claude", "codex"])
def test_s15_s16_unresolved_warning_and_capture_not_staged(repo, agent):
    weaken(repo)
    assert invoke_hook(repo, agent).returncode == 2
    run = invoke_hook(repo, agent, True)
    assert run.returncode == 0
    warning = json.loads(run.stdout)["systemMessage"]
    assert "1 unresolved high findings" in warning and ".goodhart/captures/" in warning
    captures = list((repo / ".goodhart/captures").iterdir())
    assert len(captures) == 2
    assert sum(json.loads((p / "capture.json").read_text())["unresolved"] for p in captures) == 1
    git(repo, "add", "-A")
    assert ".goodhart/" not in git(repo, "diff", "--cached", "--name-only")


def test_b2_labels_imported_exactly():
    import tomllib

    labels = json.loads((ROOT / "docs/b2-labels.json").read_text())
    candidates = ROOT / "tests/fixtures/real_candidates/own-history"
    counts = {}
    for key, review in labels["labels_by_short_sha"].items():
        repo, prefix = key.split("/")
        matches = list((candidates / repo).glob(prefix + "*/meta.toml"))
        assert len(matches) == 1
        meta = tomllib.loads(matches[0].read_text())
        assert meta["label"] == review["label"] and meta["notes"] == review["note"]
        assert meta["reviewer"] == labels["reviewer"]
        counts[meta["label"]] = counts.get(meta["label"], 0) + 1
    assert counts == {"legitimate": 52, "suspicious": 2}


@pytest.mark.parametrize(
    "path",
    [
        "dist/a.js",
        "build/a.py",
        ".next/a.js",
        "coverage/a.js",
        "public/assets/public.0c05fbc55f13.js",
    ],
)
def test_s17_generated_outputs_ignored(path):
    from goodhart.classify import classify
    from goodhart.config import Config

    assert classify(path, "", Config()) == frozenset({"other"})


def test_m18_integrity_flag_cannot_be_allowed_or_skipped(repo):
    (repo / ".goodhart.toml").write_text(
        'skip_rules = ["GH007"]\n[[allow]]\nrule="GH007"\npath="**"\nreason="reviewed"\n'
    )
    (repo / "tests/test_a.py").write_text(
        '# goodhart: allow GH007 reason="reviewed"\ndef test_a():\n    assert 3 == 3\n'
    )
    git(repo, "add", ".")
    git(repo, "commit", "-m", "reviewed baseline")
    (repo / "tests/test_a.py").write_text(
        '# goodhart: allow GH007 reason="reviewed"\ndef test_a():\n    assert True\n'
    )
    git(repo, "update-index", "--assume-unchanged", "tests/test_a.py")
    result = scan(load_git(cwd=repo, working=True))
    integrity = [f for f in result.findings if "Index flags" in f.title]
    assert len(integrity) == 1 and not integrity[0].allowed and result.exit_code() == 1


def test_s17_nonhashed_source_is_not_ignored():
    from goodhart.classify import classify
    from goodhart.config import Config

    assert classify("public/assets/main.abcdef12source.js", "", Config()) == frozenset({"source"})


def test_m15_added_script_masking_failure_still_flags():
    from .test_review_01 import run_changes

    result = run_changes(
        [("package.json", "", '{"scripts":{"test":"node --test || true"}}\n')], only={"GH007"}
    )
    assert any(f.rule_id == "GH007" and f.severity == "high" for f in result.findings)


def test_s12_retained_import_prevents_deletion_downgrade():
    from goodhart.rules.gh001_test_file_deleted import TestFileDeleted

    from .test_fixtures import fixture_input

    _, data = fixture_input(ROOT / "tests/fixtures/GH001/deleted_imported_subject")
    test = next(change for change in data.changes if "test" in change.old_kinds)
    test.base_content = "import {y} from '../src/retained.mjs';\n" + test.base_content
    result = scan(data, rules=[TestFileDeleted()])
    assert [f.severity for f in result.findings] == ["high"]
