"""Review probes that need CLI, crash, or resource-bound assertions."""

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

from goodhart.classify import classify
from goodhart.cli import main
from goodhart.config import Config
from goodhart.engine import scan
from goodhart.git import load_git, load_patch
from goodhart.lang import jsts
from goodhart.report.json import render
from goodhart.rules.base import RuleBase
from goodhart.util import comment_text

from .conftest import git
from .test_rule_edges import run_changes


def test_main_default_scans_last_commit_and_notices_empty(repo, monkeypatch, capsys):
    (repo / "src.py").write_text("value = 42\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "source")
    data = load_git(cwd=repo)
    assert data.base == git(repo, "rev-parse", "HEAD~1")
    assert [change.path for change in data.changes] == ["src.py"]
    git(repo, "commit", "--allow-empty", "-m", "empty")
    monkeypatch.chdir(repo)
    assert main(["scan"]) == 0
    stderr = capsys.readouterr().err
    assert "no changes" in stderr.lower()
    assert git(repo, "rev-parse", "HEAD~1") in stderr
    assert git(repo, "rev-parse", "HEAD") in stderr


@pytest.mark.parametrize(
    "path,text,kind",
    [
        ("checks.py", '"""TestCase"""\ndef tester(): pass\n', "source"),
        ("checks.py", "import pytest\nclass TestClient:\n    def test_db(self): pass\n", "source"),
        ("checks.py", "import pytest\ndef test_db(): pass\n", "test"),
        ("checks.py", "from unittest import TestCase as Case\nclass Checks(Case): pass\n", "test"),
        ("src/checks.py", "import pytest\ndef test_db(): pass\n", "source"),
        ("checks.ts", "import { defineConfig } from 'vitest/config';", "source"),
        ("checks.ts", "import type { Test } from 'vitest';", "source"),
        ("checks.ts", "import { type Test } from 'vitest';", "source"),
        ("checks.ts", "import { type Test, } from 'vitest';", "source"),
        ("checks.ts", "import { type Test, test } from 'vitest';", "test"),
    ],
)
def test_content_requires_real_framework(path, text, kind):
    assert classify(path, text, Config()) == frozenset({kind})


@pytest.mark.parametrize(
    "module", ["ava", "@playwright/test", "bun:test", "tap", "uvu", "@testing-library/react"]
)
def test_js_framework_signals(module):
    assert classify("checks.ts", f"import test from '{module}';", Config()) == {"test"}


@pytest.mark.parametrize("extension", ["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"])
def test_expanded_js_paths(extension):
    for path in [
        f"web/Button.test.{extension}",
        f"web/Button.spec.{extension}",
        "nested/test/Button",
    ]:
        assert classify(path, None, Config()) == {"test"}


def test_js_escape_cli_stderr_empty(tmp_path, capsys):
    source = "const a = '\\.'; const b = '\\d'; const c = `\\``;\n"
    patch = tmp_path / "diff.patch"
    patch.write_text(
        "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1 @@\n+"
        + source
        + "--- a/test/a.ts\n+++ b/test/a.ts\n@@ -0,0 +1 @@\n"
        + "+test('escape', () => { expect(a).toBe('\\.'); });\n"
    )
    assert main(["scan", "--diff", str(patch), "--format", "json"]) in {0, 1}
    assert capsys.readouterr().err == ""
    completed = subprocess.run(
        [sys.executable, "-m", "goodhart.cli", "scan", "--diff", str(patch)],
        capture_output=True,
        text=True,
    )
    assert completed.returncode in {0, 1}
    assert completed.stderr == ""


@pytest.mark.parametrize("exception", [IndexError, RuntimeError, RecursionError])
def test_rule_failure_is_diagnostic_and_scan_continues(exception):
    class Broken(RuleBase):
        id = "GH099"
        applies_to = {"source"}

        def check(self, change, ctx):
            raise exception("hostile input")

    data = load_patch("--- a/a.py\n+++ b/a.py\n@@ -1 +1 @@\n-x = 1\n+x = 2\n")
    from goodhart.rules.gh009_test_environment_detection import TestEnvironmentDetection

    data.changes.extend(
        load_patch("--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x = 1\n+x = os.getenv('CI')\n").changes
    )
    result = scan(data, rules=[Broken(), TestEnvironmentDetection()])
    errors = [f for f in result.findings if f.rule_id == "GH000"]
    assert len(errors) == 2
    assert all(f"GH099: {exception.__name__}: hostile input" in f.evidence for f in errors)
    assert any(f.rule_id == "GH009" and f.file == "b.py" for f in result.findings)


@pytest.mark.parametrize("text", ["x" * 20_001 + "\n", "x = 1\n" * 170_000])
def test_oversized_files_are_skipped_with_diagnostic(text):
    findings = run_changes([("src/a.py", "x = 1\n", text)]).findings
    assert len(findings) == 1
    assert findings[0].rule_id == "GH000"
    assert "limit" in findings[0].evidence


@pytest.mark.performance
def test_hostile_js_lexing_under_one_second():
    start = time.perf_counter()
    for text in ["'" + "\\'" * 20_000, "`" + "\\`" * 20_000, "it(\n" * 3_000]:
        jsts.tokens.cache_clear()
        jsts.tests.cache_clear()
        jsts.mask(text)
        jsts.tests(text)
        comment_text(text, False)
    elapsed = time.perf_counter() - start
    print(f"Hostile JS inputs: {elapsed:.3f}s")
    assert elapsed < 1.0


def test_duplicate_test_ordinals_and_dynamic_labels():
    tests = jsts.tests(
        "describe('suite', () => { test('same', () => {}); test('same', () => {}); });\n"
        "test.serial(`date ${format}`, t => { t.pass(); });\n"
    )
    assert [t.key for t in tests] == [
        (("suite",), "same", 0),
        (("suite",), "same", 1),
        ((), "date ${format}", 0),
    ]


def test_files_report_exposes_head_classification():
    result = run_changes(
        [("checks.py", "import pytest\ndef test_db(): pass\n", "def db(): pass\n")]
    )
    assert json.loads(render(result))["files"] == [
        {"file": "checks.py", "kinds": ["source"], "base_kinds": ["test"], "head_kinds": ["source"]}
    ]


def test_huge_commit_cli_note(tmp_path, capsys):
    patch = tmp_path / "diff.patch"
    patch.write_text(
        "".join(
            f"--- a/src/a{i}.ts\n+++ b/src/a{i}.ts\n@@ -1 +1 @@\n-x = 1;\n+x = 2;\n"
            for i in range(301)
        )
    )
    assert main(["scan", "--diff", str(patch)]) == 0
    assert "301" in capsys.readouterr().err


def test_python_broad_tuple_catch():
    result = run_changes(
        [("src/a.py", "", "try:\n    run()\nexcept (ValueError, Exception):\n    pass\n")]
    )
    assert any(f.rule_id == "GH008" and f.line == 3 for f in result.findings)


def test_python_ternary_scalar_output():
    result = run_changes(
        [
            (
                "src/a.py",
                "def run(x):\n    return len(x)\n",
                'def run(x):\n    return 4242 if x == "nested" else len(x)\n',
            ),
            ("tests/test_a.py", "", 'def test_a():\n    assert run("nested") == 4242\n'),
        ]
    )
    assert [(f.rule_id, f.severity) for f in result.findings] == [("GH006", "high")]


def test_each_named_expectation_column():
    groups = jsts.literal_groups(
        "test.each([[4242, 'nested']])('case', (expected, value) => { "
        "expect(run(value)).toBe(expected); });"
    )
    assert groups[0][1] == [(4242, 1)]
    assert groups[0][2] == [("nested", 1)]


@pytest.mark.parametrize("full", [True, False])
def test_python_match_expectation(full):
    result = run_changes(
        [
            (
                "src/a.py",
                "def run(x):\n    return len(x)\n",
                'def run(x):\n    match x:\n        case "nested":\n'
                "            return 4242\n    return len(x)\n",
            ),
            ("tests/test_a.py", "", 'def test_a():\n    assert run("nested") == 4242\n'),
        ],
        full=full,
        only={"GH006"},
    )
    assert [(f.line, f.severity) for f in result.findings] == [(3, "high")]


def test_history_scripts_first_parent_and_candidate_export(repo, tmp_path):
    root = Path(__file__).parents[1]
    git(repo, "checkout", "-b", "side")
    (repo / "side.py").write_text("value = 42\n")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "side commit")
    git(repo, "checkout", "main")
    (repo / "tests/test_a.py").unlink()
    git(repo, "add", ".")
    git(repo, "commit", "-m", "remove test")
    removed = git(repo, "rev-parse", "HEAD")
    git(repo, "merge", "--no-ff", "side", "-m", "merge")
    output = tmp_path / "report.json"
    args = [
        sys.executable,
        str(root / "scripts/noise_check.py"),
        str(repo),
        "1",
        "--json",
        str(output),
    ]
    completed = subprocess.run(args, capture_output=True, text=True, check=True)
    report = json.loads(output.read_text())
    assert completed.stderr == ""
    assert report["commits_scanned"] == report["commits_with_high"] == 1
    assert report["commits"][0]["commit"] == removed
    assert all(len(examples) <= 5 for examples in report["examples"].values())
    candidates = tmp_path / "candidates"
    args = [
        sys.executable,
        str(root / "scripts/scan_history.py"),
        str(repo),
        "1",
        "--output",
        str(candidates),
    ]
    subprocess.run(args, capture_output=True, check=True)
    case = candidates / removed
    assert (case / "base/tests/test_a.py").read_text() == "def test_a():\n    assert 3 == 3\n"
    assert 'label = "unreviewed"' in (case / "meta.toml").read_text()
    assert not (case / "expected.json").exists()
    (case / "meta.toml").write_text('label = "manually-reviewed"\n')
    subprocess.run(args, capture_output=True, check=True)
    assert 'label = "manually-reviewed"' in (case / "meta.toml").read_text()
