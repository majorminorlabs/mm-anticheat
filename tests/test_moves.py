"""Substantive move evidence cannot be supplied by stub or unrelated assertions."""

import pytest

from goodhart.engine import scan

from .test_rule_edges import run_changes


@pytest.mark.parametrize("full", [True, False])
@pytest.mark.parametrize("body", ["pass", "...", '"""assert True"""'])
def test_stub_rejected_and_explained(full, body):
    before = 'def test_slug_basic():\n    assert run("hello") == "world"\n'
    result = run_changes(
        [
            ("tests/test_text.py", before, ""),
            ("tests/test_other.py", "", f"def test_slug_basic():\n    {body}\n"),
        ],
        full=full,
        only={"GH001", "GH002"},
    )
    finding = result.findings[0]
    assert finding.severity == "high"
    assert (
        "moved test has no assertions: tests/test_other.py:test_slug_basic"
        in finding.why_flagged.lower()
    )
    # The same guard applies when the whole source test file was deleted.
    result.data.changes[0].new_path = None
    deleted = scan(result.data)
    assert next(f for f in deleted.findings if f.rule_id == "GH001").severity == "high"


@pytest.mark.parametrize("full", [True, False])
def test_js_stub_cannot_borrow_next_test_assertions(full):
    result = run_changes(
        [
            (
                "test/text.ts",
                "test('slug basic', () => { expect(run('hello')).toBe('world'); });\n",
                "",
            ),
            (
                "test/other.ts",
                "",
                "test('slug basic', () => {});\n"
                "test('unrelated', () => { expect(run('other')).toBe('value'); });\n",
            ),
        ],
        full=full,
        only={"GH002"},
    )
    assert result.findings[0].severity == "high"


def test_existing_same_name_destination_is_not_reused():
    test = 'def test_slug_basic():\n    assert run("hello") == "world"\n'
    result = run_changes(
        [
            ("tests/test_text.py", test, ""),
            ("tests/test_other.py", test, test + "\ndef test_slug_basic():\n    pass\n"),
        ],
        only={"GH002"},
    )
    assert result.findings[0].severity == "high"
