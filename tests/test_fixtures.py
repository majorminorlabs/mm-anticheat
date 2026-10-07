"""Fixture comparisons deliberately ignore evidence prose."""

import json
import tomllib
from pathlib import Path

import pytest

from mm_anticheat.classify import classify
from mm_anticheat.config import Config, parse_config
from mm_anticheat.engine import scan
from mm_anticheat.git import load_patch
from mm_anticheat.rules import all_rules

FIXTURES = Path(__file__).parent / "fixtures"
CASES = sorted(
    path.parent
    for path in FIXTURES.rglob("meta.toml")
    if "real_candidates" not in path.relative_to(FIXTURES).parts
)


def fixture_input(case: Path):
    meta = tomllib.loads((case / "meta.toml").read_text())
    data = load_patch((case / "diff.patch").read_text())
    data.mode = meta["mode"]
    settings = case / "base/.anticheat.toml"
    if data.mode == "full" and settings.exists():
        data.config = parse_config(settings.read_text(), "base:fixture")
    if data.mode == "full":
        for change in data.changes:
            for side, path in (("base", change.old_path), ("head", change.new_path)):
                source = case / side / path if path else None
                content = source.read_text() if source and source.exists() else None
                setattr(change, f"{side}_content", content)
            change.old_kinds = classify(
                change.old_path or change.path, change.base_content, data.config
            )
            change.new_kinds = classify(
                change.new_path or change.path, change.head_content, data.config
            )
        data.extra_tests = {
            path.relative_to(case / "head").as_posix(): path.read_text()
            for path in (case / "head").rglob("*")
            if path.is_file()
            and path.suffix in {".py", ".js", ".ts", ".tsx", ".jsx"}
            and "test"
            in classify(path.relative_to(case / "head").as_posix(), path.read_text(), Config())
        }
    return meta, data


@pytest.mark.parametrize("case", CASES, ids=lambda case: str(case.relative_to(FIXTURES)))
def test_fixture(case):
    meta, data = fixture_input(case)
    if meta.get("source"):
        assert data.changes, "Corpus regression fixtures must exercise a changed file"
    selected = meta.get("rules")
    rules = [rule for rule in all_rules() if selected is None or rule.id in selected]
    result = scan(data, rules=rules)
    expected = json.loads((case / "expected.json").read_text())
    with_allowed = any("allowed" in item for item in expected)
    actual = [
        {
            "rule_id": item.rule_id,
            "file": item.file,
            "line": item.line,
            "severity": item.severity,
            **({"allowed": item.allowed} if with_allowed else {}),
        }
        for item in result.findings
    ]

    def sort_key(item):
        return (item["rule_id"], item["file"], item["line"], item["severity"])

    assert sorted(actual, key=sort_key) == sorted(expected, key=sort_key)
    assert bool(actual) == meta["expect_fire"]
    if "expect_exit" in meta:
        assert result.exit_code() == meta["expect_exit"]
    if data.mode == "patch":
        assert all(
            item.confidence == "reduced"
            for item in result.findings
            if item.rule_id in {"AC002", "AC004"}
        )


def test_fixture_minimums():
    for rule in all_rules():
        cases = [
            tomllib.loads(path.read_text()) for path in (FIXTURES / rule.id).rglob("meta.toml")
        ]
        assert sum(case["expect_fire"] for case in cases) >= 2, rule.id
        assert sum(not case["expect_fire"] for case in cases) >= 2, rule.id
        if rule.supports_patch_mode:
            assert any(case["expect_fire"] and case["mode"] == "patch" for case in cases)
            assert any(not case["expect_fire"] and case["mode"] == "patch" for case in cases)
