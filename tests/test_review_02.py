"""Trusted policy and mapped inline approval regressions from REVIEW_02."""

import json

import pytest

from goodhart.cli import main
from goodhart.config import parse_config
from goodhart.engine import scan
from goodhart.git import load_git, load_patch

from .conftest import git
from .test_rule_edges import run_changes

TEST = "def test_a():\n    assert 3 == 3\n"
SKIPPED = '@pytest.mark.skip(reason="flaky")\n' + TEST
ALLOW = '[[allow]]\nrule = "GH003"\npath = "**"\nreason = "known flaky"\n'


@pytest.mark.parametrize("mode", ["range", "working", "staged", "patch"])
def test_untrusted_policy_cannot_hide_skip_in_any_mode(repo, monkeypatch, capsys, mode):
    base = git(repo, "rev-parse", "HEAD")
    (repo / ".goodhart.toml").write_text('fail_on = "never"\n' + ALLOW)
    (repo / "tests/test_a.py").write_text(SKIPPED)
    git(repo, "add", ".")
    args = ["--working"]
    if mode == "range":
        git(repo, "commit", "-m", "untrusted policy")
        args = ["--base", base, "--head", "HEAD"]
    elif mode == "staged":
        args = ["--staged"]
    elif mode == "patch":
        diff = repo / "change.patch"
        diff.write_text(git(repo, "diff", "--cached") + "\n")
        args = ["--diff", str(diff)]
    monkeypatch.chdir(repo)
    assert main(["scan", *args, "--format", "json"]) == 1
    output = capsys.readouterr()
    payload = json.loads(output.out)
    assert payload["config"] == {"source": "defaults"}
    assert {f["rule_id"] for f in payload["findings"] if f["severity"] == "high"} == {
        "GH003",
        "GH007",
    }
    assert not any(f["allowed"] for f in payload["findings"])
    if mode != "patch":
        assert "using base-side config; .goodhart.toml changed in this diff" in output.err


@pytest.mark.parametrize("mode", ["range", "working", "staged", "patch"])
def test_config_provenance_and_preexisting_allow(repo, monkeypatch, capsys, mode):
    (repo / ".goodhart.toml").write_text(ALLOW)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "trusted approval")
    base = git(repo, "rev-parse", "HEAD")
    (repo / "tests/test_a.py").write_text(SKIPPED)
    git(repo, "add", ".")
    source, code, allowed = "HEAD", 0, True
    if mode == "range":
        git(repo, "commit", "-m", "skip")
        args, source = ["--base", base], "base:" + base
    elif mode == "patch":
        diff = repo / "change.patch"
        diff.write_text(git(repo, "diff", "--cached") + "\n")
        args, source, code, allowed = ["--diff", str(diff)], "defaults", 1, False
    else:
        args = ["--" + mode]
    monkeypatch.chdir(repo / "tests")
    assert main(["scan", *args, "--format", "json"]) == code
    payload = json.loads(capsys.readouterr().out)
    assert payload["config"] == {"source": source}
    assert payload["findings"][0]["allowed"] is allowed


def test_range_uses_merge_base_not_requested_base_or_checkout(repo):
    (repo / ".goodhart.toml").write_text('fail_on = "high"\n')
    git(repo, "add", ".")
    git(repo, "commit", "-m", "policy base")
    trusted = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-b", "feature")
    (repo / "tests/test_a.py").write_text(SKIPPED)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "skip")
    git(repo, "checkout", "main")
    (repo / ".goodhart.toml").write_text('fail_on = "never"\n')
    git(repo, "add", ".")
    git(repo, "commit", "-m", "different checkout policy")
    data = load_git(cwd=repo, base="main", head="feature")
    assert data.config.source == "base:" + trusted
    assert scan(data).exit_code(data.config.fail_on) == 1


@pytest.mark.parametrize("full", [True, False])
def test_existing_allow_maps_across_inserted_lines(full):
    comment = '# goodhart: allow GH003 reason="reviewed"\n'
    before = "# heading\n" * 12 + comment + TEST
    after = "# new heading\n" * 5 + before.replace(TEST, SKIPPED)
    result = run_changes([("tests/test_a.py", before, after)], full=full)
    assert result.findings[0].rule_id == "GH003" and result.findings[0].allowed
    assert result.exit_code() == 0


def test_preexisting_same_line_comment_checks_full_base_not_added_patch():
    comment = ' # goodhart: allow GH009 reason="runner integration"\n'
    before = "flag = False" + comment
    after = 'flag = os.getenv("PYTEST_CURRENT_TEST")' + comment
    for full in (True, False):
        result = run_changes([("src/a.py", before, after)], full=full)
        target = next(f for f in result.findings if f.rule_id == "GH009")
        assert target.allowed is full
        assert result.exit_code() == (0 if full else 1)


def test_control_policy_audit_cannot_silence_itself():
    before = (
        'skip_rules = ["GH007"]\n[paths]\nignore_globs = [".goodhart.toml"]\n'
        '[[allow]]\nrule = "GH007"\npath = "**"\nreason = "reviewed"\n'
    )
    data = run_changes([(".goodhart.toml", before, 'fail_on = "never"\n' + before)]).data
    result = scan(data, parse_config(before))
    assert result.findings[0].rule_id == "GH007" and not result.findings[0].allowed
    assert result.exit_code() == 1


@pytest.mark.parametrize(
    "before,after,flag",
    [
        ('fail_on = "low"', 'fail_on = "high"', True),
        ('fail_on = "high"', 'fail_on = "medium"', False),
        (ALLOW, ALLOW.replace('path = "**"', 'path = "tests/**"'), False),
        (ALLOW.replace('path = "**"', 'path = "tests/**"'), ALLOW, True),
        (ALLOW, ALLOW.replace("known flaky", "new reason"), False),
        ('[paths]\nignore_globs = ["tests/**"]', "[paths]\nignore_globs = []", False),
    ],
)
def test_scanner_policy_tightening_and_widening(before, after, flag):
    result = run_changes([(".goodhart.toml", before + "\n", after + "\n")])
    assert bool(result.findings) is flag
    if flag:
        assert result.findings[0].rule_id == "GH007" and result.findings[0].severity == "high"


def test_patch_config_not_read_from_current_directory(tmp_path, monkeypatch, capsys):
    (tmp_path / ".goodhart.toml").write_text('fail_on = "never"\n' + ALLOW)
    import difflib

    diff = tmp_path / "change.patch"
    diff.write_text(
        "".join(
            difflib.unified_diff(
                TEST.splitlines(True),
                SKIPPED.splitlines(True),
                "a/tests/test_a.py",
                "b/tests/test_a.py",
            )
        )
    )
    monkeypatch.chdir(tmp_path)
    assert main(["scan", "--diff", str(diff)]) == 1
    assert "config: defaults" in capsys.readouterr().out
    assert main(["scan", "--diff", str(diff), "--config", str(tmp_path / ".goodhart.toml")]) == 0
    assert "config: --config " in capsys.readouterr().out


def test_malformed_head_config_has_both_diagnostics():
    data = load_patch(
        '--- a/.goodhart.toml\n+++ b/.goodhart.toml\n@@ -1 +1 @@\n-fail_on = "high"\n+fail_on = [\n'
    )
    result = scan(data)
    assert {(f.rule_id, f.severity) for f in result.findings} == {
        ("GH007", "medium"),
        ("GH000", "info"),
    }
