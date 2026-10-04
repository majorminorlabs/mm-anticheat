"""Adversarial inputs and legitimate rule edge cases beyond the minimum fixtures."""

import difflib
import json
import time

import pytest

from goodhart.classify import classify
from goodhart.config import Config
from goodhart.engine import scan
from goodhart.git import load_git, load_patch
from goodhart.lang import jsts, python
from goodhart.report.json import render
from goodhart.rules import all_rules

from .conftest import git


def run_changes(files, full=True, only=None):
    text = "".join(
        "".join(
            difflib.unified_diff(
                before.splitlines(keepends=True),
                after.splitlines(keepends=True),
                fromfile="a/" + path,
                tofile="b/" + path,
            )
        )
        for path, before, after in files
    )
    data = load_patch(text)
    if full:
        data.mode = "full"
        lookup = {path: (before, after) for path, before, after in files}
        for change in data.changes:
            change.base_content, change.head_content = lookup[change.path]
            change.old_kinds = classify(change.path, change.base_content, Config())
            change.new_kinds = classify(change.path, change.head_content, Config())
        data.extra_tests = {
            path: after for path, _, after in files if "test" in classify(path, after, Config())
        }
    rules = [rule for rule in all_rules() if only is None or rule.id in only]
    return scan(data, rules=rules)


@pytest.mark.parametrize("mode", ["range", "working", "staged"])
def test_untouched_importing_tests(repo, mode):
    (repo / "src").mkdir()
    (repo / "src/parser.py").write_text("def parse(x):\n    return len(x)\n")
    # Content-based classification must work outside conventional test paths.
    (repo / "checks.py").write_text(
        'from src.parser import parse\ndef test_parse():\n    assert parse("nested") == 4242\n'
    )
    git(repo, "add", ".")
    git(repo, "commit", "-m", "add importer")
    base = git(repo, "rev-parse", "HEAD")
    (repo / "src/parser.py").write_text(
        'def parse(x):\n    if x == "nested":\n        return 4242\n    return len(x)\n'
    )
    git(repo, "add", ".")
    if mode == "range":
        git(repo, "commit", "-m", "head")
    data = load_git(
        cwd=repo,
        base=base if mode == "range" else None,
        working=mode == "working",
        staged=mode == "staged",
    )
    assert "checks.py" in data.extra_tests
    assert any(f.rule_id == "GH006" and f.severity == "high" for f in scan(data).findings)


def test_untouched_js_importer(repo):
    (repo / "src").mkdir()
    (repo / "src/parser.ts").write_text("export function parse(x) { return x.length; }\n")
    (repo / "tests/parser.test.ts").write_text(
        "import { parse } from '../src/parser';\n"
        "test('nested', () => { expect(parse('nested')).toBe(4242); });\n"
    )
    git(repo, "add", ".")
    git(repo, "commit", "-m", "add js")
    (repo / "src/parser.ts").write_text(
        "export function parse(x) { if (x === 'nested') { return 4242; } return x.length; }\n"
    )
    data = load_git(cwd=repo, working=True)
    assert "tests/parser.test.ts" in data.extra_tests
    assert any(f.rule_id == "GH006" and f.severity == "high" for f in scan(data).findings)


@pytest.mark.parametrize("full", [True, False])
@pytest.mark.parametrize(
    "path,after",
    [
        ("src/a.py", 'text = "# goodhart: allow GH003"\n'),
        ("src/a.py", 'text = "# type: ignore"\n'),
        ("src/a.ts", 'const text = "// @ts-ignore";\n'),
        ("src/a.ts", 'const text = "// goodhart: allow GH003";\n'),
    ],
)
def test_directive_strings_are_not_comments(full, path, after):
    assert run_changes([(path, "", after)], full, {"GH000", "GH010", "GH012"}).findings == []


@pytest.mark.parametrize("full", [True, False])
def test_hardcode_comment_not_literal(full):
    files = [
        (
            "src/a.py",
            "def parse(x):\n    return len(x)\n",
            'def parse(x):\n    if x == "nested":\n        return len(x)  # expected: 4242\n',
        ),
        ("tests/test_a.py", "", 'def test_a():\n    assert parse("nested") == 4242\n'),
    ]
    assert run_changes(files, full, {"GH006"}).findings == []


def test_python_test_classes_and_async():
    text = (
        "from unittest import TestCase as Case\n"
        "class Checks(Case):\n    async def test_async(self):\n"
        "        self.assertEqual(3, 3)\n"
        "class Child(Checks):\n    def test_other(self):\n        assert True\n"
        "async def test_module():\n    with pytest.raises(ValueError):\n        run()\n"
    )
    tests = python.tests(text)
    assert [t.name for t in tests] == ["Checks.test_async", "Child.test_other", "test_module"]
    assert [t.assertions for t in tests] == [1, 1, 1]


def test_js_nested_callbacks_and_comments():
    text = (
        '// test("fake", () => {});\n'
        'test.each([3, 4])("real", (x) => {\n'
        ' const literal = "expect(fake)";\n'
        " if (x) { expect(x).toBe(x); }\n});\n"
    )
    tests = jsts.tests(text)
    assert [(t.name, t.assertions) for t in tests] == [("real", 1)]


def test_malformed_file_reports_and_continues():
    result = run_changes(
        [
            ("src/broken.py", "x=3\n", "def broken(:\n"),
            ("src/env.py", "", 'mode = os.environ.get("CI")\n'),
        ]
    )
    assert {f.rule_id for f in result.findings} == {"GH000", "GH009"}


def test_json_deterministic_and_schema():
    result = run_changes([("src/a.py", "", 'env = os.environ.get("CI")\n')])
    first = render(result)
    assert first == render(result)
    payload = json.loads(first)
    assert payload["schema_version"] == "1"
    assert payload["summary"] == {"high": 1, "medium": 0, "low": 0, "info": 0, "files_scanned": 1}
    assert set(payload["findings"][0]) == {
        "rule_id",
        "rule_name",
        "severity",
        "confidence",
        "file",
        "line",
        "title",
        "evidence",
        "why_flagged",
        "legit_if",
        "allowed",
    }


@pytest.mark.performance
def test_5000_line_full_scan(repo):
    old = "".join(f"value_{index} = {index + 3}\n" for index in range(2500))
    new = "".join(f"value_{index} = {index + 4}\n" for index in range(2500))
    (repo / "large.py").write_text(old)
    git(repo, "add", ".")
    git(repo, "commit", "-m", "large base")
    (repo / "large.py").write_text(new)
    python.parse.cache_clear()
    started = time.perf_counter()
    result = scan(load_git(cwd=repo, working=True))
    elapsed = time.perf_counter() - started
    assert not result.findings
    assert elapsed < 2, f"5,000-line diff scan took {elapsed:.3f}s"
    print(f"5,000-line full scan: {elapsed:.3f}s")


def test_non_test_ci_step_can_tolerate_failure():
    before = (
        "jobs:\n  check:\n    steps:\n      - run: pytest\n"
        "      - uses: actions/upload-artifact@v4\n"
    )
    after = before + "        continue-on-error: true\n"
    result = run_changes([(".github/workflows/test.yml", before, after)], only={"GH007"})
    assert not result.findings


def test_selection_moved_on_addopts_line():
    before = "[pytest]\naddopts = -k 'unit' -q\n"
    after = "[pytest]\naddopts = -v -k 'unit'\n"
    result = run_changes([("pytest.ini", before, after)], only={"GH007"})
    assert not result.findings
