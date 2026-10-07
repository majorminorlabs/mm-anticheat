"""JSON v3 compatibility contract and human-report presentation boundaries."""

import json
from pathlib import Path

import pytest

from mm_anticheat.config import Allow, Config
from mm_anticheat.engine import scan
from mm_anticheat.report import json as json_report
from mm_anticheat.report import markdown, text
from mm_anticheat.report.rules import catalog, explain
from mm_anticheat.rules import all_rules

from .test_rule_edges import run_changes


@pytest.fixture
def result():
    return run_changes(
        [("src/a.py", "", 'flag = os.getenv("PYTEST_CURRENT_TEST")\nx = 3 # noqa\n')]
    )


@pytest.mark.parametrize("full", [True, False])
def test_json_v2_preserves_v1_fields_and_adds_config_source(full):
    result = run_changes([("src/a.py", "", 'flag = os.getenv("PYTEST_CURRENT_TEST")\n')], full=full)
    result = scan(result.data, Config(allows=[Allow("AC009", "src/**", "Reviewed runner probe")]))
    payload = json.loads(json_report.render(result))
    assert set(payload) == {
        "schema_version",
        "tool",
        "tool_version",
        "mode",
        "range",
        "summary",
        "files",
        "findings",
        "config",
    }
    assert payload["schema_version"] == "3" and payload["tool"] == "mm-anticheat"
    assert payload["config"] == {"source": "defaults"}
    assert isinstance(payload["tool_version"], str)
    assert payload["mode"] == ("full" if full else "patch")
    assert set(payload["range"]) == {"base", "head"}
    assert all(value is None or isinstance(value, str) for value in payload["range"].values())
    assert payload["summary"] == {"high": 1, "medium": 0, "low": 0, "info": 0, "files_scanned": 1}
    assert payload["files"] == [
        {
            "file": "src/a.py",
            "kinds": ["source"],
            "base_kinds": ["source"],
            "head_kinds": ["source"],
        }
    ]
    finding = payload["findings"][0]
    string_fields = {
        "rule_id",
        "rule_name",
        "severity",
        "confidence",
        "file",
        "title",
        "evidence",
        "why_flagged",
        "legit_if",
    }
    assert set(finding) == string_fields | {"line", "allowed"}
    assert all(isinstance(finding[key], str) for key in string_fields)
    assert finding["severity"] == "high" and finding["confidence"] == "normal"
    assert type(finding["line"]) is int and finding["line"] >= 1
    assert finding["allowed"] is True
    assert result.exit_code() == 0


def test_reports_sorted_grouped_safe_and_deterministic(result):
    first = text.render(result)
    assert first == text.render(result)
    assert first.index("HIGH (1)") < first.index("LOW (1)")
    assert "Why:" in first and "Review:" in first and "\x1b" not in first
    result.findings[0].title = "Unsafe\x1b[31m control"
    assert "\\x1b[31m" in text.render(result)
    assert "\x1b" not in markdown.render(result)
    assert (
        json.loads(json_report.render(result))["findings"][0]["title"] == result.findings[0].title
    )


@pytest.mark.parametrize("renderer", [text.render, markdown.render])
def test_default_evidence_cap_and_allowed_visibility(result, renderer):
    finding = result.findings[0]
    finding.evidence = "\n".join(f"row{i}" for i in range(9))
    finding.allowed = True
    output = renderer(result)
    assert "row5" in output and "row6" not in output
    assert "3 more evidence lines" in output and "[allowed]" in output
    assert "allowed: 1" in output
    assert "high: 1 (1 allowed)" in renderer(result, quiet=True)
    assert finding.evidence.endswith("row8")
    assert "row8" in renderer(result, max_evidence_lines=9)


def test_markdown_fences_and_html_escape(result):
    finding = result.findings[0]
    finding.title = "Review <script> & quote"
    finding.file = "src/<probe>.py"
    finding.evidence = "```\n</details><script>\n````"
    output = markdown.render(result)
    assert "<summary>[high] AC009 Review &lt;script&gt; &amp; quote</summary>" in output
    assert "src/&lt;probe&gt;.py" in output
    assert "`````text\n```\n</details><script>\n````\n`````" in output
    assert output.count("<details>") == len(result.findings)


def test_rule_catalog_is_generated_and_metadata_complete():
    root = Path(__file__).resolve().parents[1]
    assert (root / "docs/rules.md").read_text() == catalog()
    for rule in all_rules():
        assert rule.details and rule.why_flagged and rule.legit_if
        assert rule.id in explain(rule) and rule.details in explain(rule)
