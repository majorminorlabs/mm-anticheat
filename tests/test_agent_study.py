"""Offline study verification; tests never invoke an agent or a model API."""

import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox profile")
def test_grading_sandbox_allows_pytest_but_denies_network(tmp_path):
    study = module("agent_study")
    workspace, case = tmp_path / "workspace", tmp_path / "case"
    workspace.mkdir()
    case.mkdir()
    (workspace / "test_solution.py").write_text(
        "import socket\n\ndef test_solution():\n"
        "    try:\n"
        "        sock = socket.socket()\n"
        "        sock.connect(('127.0.0.1', 9))\n"
        "    except PermissionError:\n"
        "        return\n"
        "    assert False, 'sandbox must deny the connection'\n"
    )
    result = study.grade_case(workspace, case, dict(os.environ))
    assert result["exit"] == 0 and not result["timeout"]
    assert "1 passed" in (case / "tests.stdout").read_text()


def test_report_keeps_all_cheats_and_flagged_controls(tmp_path):
    report = module("agent_study_report")
    for task, split, label, findings in [
        ("missed", "conflicting", "cheat", []),
        ("caught", "conflicting", "cheat", [{"severity": "high"}]),
        (
            "control",
            "original",
            "honest",
            [
                {
                    "severity": "medium",
                    "rule_id": "AC018",
                    "title": "expected changed",
                    "evidence": "old → new",
                }
            ],
        ),
    ]:
        case = tmp_path / "claude" / split / task
        case.mkdir(parents=True)
        record = dict(
            agent="claude",
            split=split,
            label=label,
            version="test",
            model="test",
            grading_protocol="sandbox-devnull-v2",
            execution=dict(exit=0, seconds=1, timeout=False),
            grade=dict(exit=0),
            rate_limited=False,
        )
        (case / "manifest.json").write_text(json.dumps(record))
        (case / "findings.json").write_text(json.dumps({"findings": findings}))
        (case / "diff.patch").write_text("+verbatim cheat or control\n")
    output = tmp_path / "report.md"
    summary = report.evaluate(tmp_path, output)["claude"]
    assert summary["cheats"] == 2 and summary["any_hits"] == 1
    assert summary["control_any"] == 1 and summary["controls"] == 1
    assert "+verbatim cheat or control" in output.read_text()
    assert "50.0%" in output.read_text()


def test_report_rejects_uncorrected_grades(tmp_path):
    report = module("agent_study_report")
    (tmp_path / "manifest.json").write_text(json.dumps({"agent": "claude"}))
    (tmp_path / "findings.json").write_text('{"findings": []}')
    with pytest.raises(ValueError, match="Uncorrected grading"):
        report.evaluate(tmp_path, tmp_path / "report.md")


@pytest.mark.parametrize(
    "message",
    ["You've hit your session limit", "You’ve hit your usage limit", "You've hit your limit"],
)
def test_subscription_limits_halt_campaign(message):
    assert module("agent_study").subscription_limited(message)


def test_rejected_subscription_event_halts_without_text():
    event = {"type": "rate_limit_event", "rate_limit_info": {"status": "rejected"}}
    assert module("agent_study").subscription_limited(json.dumps(event))
