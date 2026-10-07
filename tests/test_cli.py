"""Exercise the public commands, every scan option and exit codes 0/1/3."""

import difflib
import io
import json
from pathlib import Path

import pytest

from goodhart.cli import main

from .conftest import git


def patch(path, before, after):
    return "".join(
        difflib.unified_diff(
            before.splitlines(True), after.splitlines(True), "a/" + path, "b/" + path
        )
    )


@pytest.fixture
def ci_patch(tmp_path):
    path = tmp_path / "ci.patch"
    path.write_text(patch("src/a.py", "flag = False\n", 'flag = os.getenv("CI")\n'))
    return str(path)


@pytest.mark.parametrize("threshold,code", [("high", 0), ("medium", 1), ("low", 1), ("never", 0)])
def test_fail_threshold(ci_patch, threshold, code, capsys):
    assert main(["scan", "--diff", ci_patch, "--fail-on", threshold]) == code
    output = capsys.readouterr()
    assert "GH009" in output.out and not output.err


def test_rule_selection_and_skip(ci_patch, capsys):
    assert main(["scan", "--diff", ci_patch, "--rules", "GH009", "--fail-on", "medium"]) == 1
    assert "GH009" in capsys.readouterr().out
    assert main(["scan", "--diff", ci_patch, "--rules", "GH008"]) == 0
    assert "GH009" not in capsys.readouterr().out
    assert main(["scan", "--diff", ci_patch, "--skip-rules", "GH009"]) == 0
    assert "GH009" not in capsys.readouterr().out


@pytest.mark.parametrize(
    "args",
    [
        [],
        ["unknown"],
        ["explain", "GH999"],
        ["scan", "--rules", "GH999"],
        ["scan", "--rules", ""],
        ["scan", "--skip-rules", "GH999"],
        ["scan", "--fail-on", "info"],
        ["scan", "--format", "yaml"],
        ["scan", "--max-evidence-lines", "0"],
        ["scan", "--max-evidence-lines", "-1"],
        ["scan", "--max-evidence-lines", "bad"],
        ["scan", "--working", "--staged"],
        ["scan", "--diff", "-", "--head", "HEAD"],
        ["scan", "--working", "--head", "HEAD"],
        ["scan", "--unknown"],
    ],
)
def test_usage_errors_never_exit_two(args, capsys):
    with pytest.raises(SystemExit) as error:
        main(args)
    assert error.value.code == 3
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("args", [["--help"], ["scan", "--help"], ["--version"]])
def test_help_and_version(args, capsys):
    with pytest.raises(SystemExit) as result:
        main(args)
    assert result.value.code == 0
    assert "goodhart" in capsys.readouterr().out


def test_rules_and_explain(capsys):
    assert main(["rules"]) == 0
    output = capsys.readouterr().out
    assert len(output.splitlines()) == 13
    assert "GH000" in output and "GH012" in output
    assert main(["explain", "GH005"]) == 0
    output = capsys.readouterr().out
    for part in ["assertion-weakened", "Default severity:", "How checked:", "Legitimate when:"]:
        assert part in output


def test_default_config_root_cli_override_and_skip_clear(repo, monkeypatch, capsys):
    (repo / ".goodhart.toml").write_text('fail_on = "medium"\nskip_rules = ["GH009"]\n')
    git(repo, "add", ".goodhart.toml")
    git(repo, "commit", "-m", "trusted config")
    (repo / "src").mkdir()
    (repo / "src/a.py").write_text('flag = os.getenv("CI")\n')
    monkeypatch.chdir(repo / "src")
    assert main(["scan", "--working"]) == 0
    assert "GH009" not in capsys.readouterr().out
    assert main(["scan", "--working", "--skip-rules", ""]) == 1
    assert "GH009" in capsys.readouterr().out
    assert main(["scan", "--working", "--skip-rules", "", "--fail-on", "high"]) == 0
    assert "GH009" in capsys.readouterr().out


def test_explicit_config_outside_git(ci_patch, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / ".goodhart.toml").write_text('fail_on = "medium"\n')
    (tmp_path / "custom.toml").write_text('fail_on = "never"\n')
    assert main(["scan", "--diff", ci_patch]) == 0
    capsys.readouterr()
    assert main(["scan", "--diff", ci_patch, "--config", "custom.toml"]) == 0
    assert not capsys.readouterr().err
    assert main(["scan", "--working"]) == 3
    assert "error:" in capsys.readouterr().err


@pytest.mark.parametrize("mode", ["patch", "working"])
def test_custom_path_globs_and_ignore(repo, monkeypatch, mode, capsys):
    config = repo / "custom.toml"
    config.write_text('[paths]\ntest_globs = ["qa/**"]\nignore_globs = ["src/**"]\n')
    after = '@pytest.mark.skip(reason="new")\ndef test_a():\n    assert 3 == 3\n'
    before = "def test_a():\n    assert 3 == 3\n"
    (repo / "qa").mkdir()
    (repo / "qa/check.py").write_text(before)
    (repo / "src").mkdir()
    (repo / "src/a.py").write_text("flag = False\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "prepare")
    (repo / "qa/check.py").write_text(after)
    (repo / "src/a.py").write_text('flag = os.getenv("PYTEST_CURRENT_TEST")\n')
    monkeypatch.chdir(repo)
    args = ["--working"]
    if mode == "patch":
        diff = repo / "change.patch"
        diff.write_text(git(repo, "diff") + "\n")
        args = ["--diff", str(diff)]
    assert main(["scan", *args, "--config", str(config), "--format", "json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert {f["rule_id"] for f in payload["findings"]} == {"GH003"}
    assert next(f for f in payload["files"] if f["file"] == "qa/check.py")["kinds"] == ["test"]
    assert next(f for f in payload["files"] if f["file"] == "src/a.py")["kinds"] == ["other"]


@pytest.mark.parametrize("mode", ["working", "staged", "range"])
def test_git_mode_flags_and_json_range(repo, monkeypatch, mode, capsys):
    base = git(repo, "rev-parse", "HEAD")
    (repo / "tests/test_a.py").unlink()
    args = ["--working"]
    expected_head = "WORKTREE"
    if mode in {"staged", "range"}:
        git(repo, "add", ".")
        args, expected_head = ["--staged"], "INDEX"
    if mode == "range":
        git(repo, "commit", "-m", "remove test")
        expected_head = git(repo, "rev-parse", "HEAD")
        args = ["--base", base, "--head", expected_head]
    monkeypatch.chdir(repo)
    assert main(["scan", *args, "--format", "json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["mode"] == "full"
    assert payload["range"] == {"base": base, "head": expected_head}
    assert {f["rule_id"] for f in payload["findings"]} == {"GH001"}


def test_stdin_and_path_allow_visible(ci_patch, tmp_path, monkeypatch, capsys):
    config = tmp_path / "config.toml"
    config.write_text(
        'fail_on = "medium"\n[[allow]]\nrule = "GH009"\npath = "src/**"\nreason = "CI timeout"\n'
    )
    monkeypatch.setattr("sys.stdin", io.StringIO(Path(ci_patch).read_text()))
    assert main(["scan", "--diff", "-", "--config", str(config), "--format", "json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["range"] == {"base": None, "head": None}
    assert payload["findings"][0]["allowed"] is True
    assert payload["summary"]["medium"] == 1


@pytest.mark.parametrize("fmt", ["text", "markdown"])
def test_quiet_and_format(ci_patch, fmt, capsys):
    assert main(["scan", "--diff", ci_patch, "--format", fmt, "--quiet"]) == 0
    output = capsys.readouterr().out
    assert len(output.splitlines()) == 1
    assert "medium: 1" in output and "GH009" not in output
    assert main(["scan", "--diff", ci_patch, "--format", fmt]) == 0
    output = capsys.readouterr().out
    assert "GH009" in output
    assert ("<details>" in output) == (fmt == "markdown")


def test_evidence_limit_and_json_not_truncated(tmp_path, capsys):
    diff = tmp_path / "suppressions.patch"
    diff.write_text(patch("src/a.py", "x = 3\n", "".join(f"x = {i} # noqa\n" for i in range(8))))
    assert main(["scan", "--diff", str(diff), "--max-evidence-lines", "1"]) == 0
    output = capsys.readouterr().out
    assert "7 more evidence lines" in output and "x = 7 # noqa" not in output
    assert (
        main(
            [
                "scan",
                "--diff",
                str(diff),
                "--format",
                "json",
                "--quiet",
                "--max-evidence-lines",
                "1",
            ]
        )
        == 0
    )
    finding = json.loads(capsys.readouterr().out)["findings"][0]
    assert len(finding["evidence"].splitlines()) == 8


@pytest.mark.parametrize(
    "tty,no_color,colored", [(True, False, True), (True, True, False), (False, False, False)]
)
def test_tty_colors(ci_patch, monkeypatch, capsys, tty, no_color, colored):
    monkeypatch.setattr("sys.stdout.isatty", lambda: tty)
    args = ["--no-color"] if no_color else []
    assert main(["scan", "--diff", ci_patch, *args]) == 0
    assert ("\x1b[" in capsys.readouterr().out) == colored


def test_bad_files_config_and_internal_error(ci_patch, tmp_path, monkeypatch, capsys):
    assert main(["scan", "--diff", str(tmp_path / "absent.patch")]) == 3
    assert "error:" in capsys.readouterr().err
    invalid = tmp_path / "invalid.toml"
    invalid.write_text('fail_on = "typo"')
    assert main(["scan", "--diff", ci_patch, "--config", str(invalid)]) == 3
    assert "fail_on" in capsys.readouterr().err
    assert main(["scan", "--diff", ci_patch, "--config", str(tmp_path / "absent.toml")]) == 3
    capsys.readouterr()

    def broken(*args):
        raise RuntimeError("injected crash")

    monkeypatch.setattr("goodhart.cli.run_scan", broken)
    assert main(["scan", "--diff", ci_patch]) == 3
    assert "internal error: RuntimeError: injected crash" in capsys.readouterr().err
