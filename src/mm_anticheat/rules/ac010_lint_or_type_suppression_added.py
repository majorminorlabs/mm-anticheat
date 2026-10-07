"""Group added lint/type suppressions per file."""

import re

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.rules.base import Finding, RuleBase
from mm_anticheat.util import added_comments

PATTERN = re.compile(
    r"#\s*(?:type:\s*ignore|noqa\b|pylint:\s*disable|pyright:\s*ignore)"
    r"|//\s*@ts-(?:ignore|expect-error|nocheck)\b|eslint-disable\b"
)


class LintOrTypeSuppressionAdded(RuleBase):
    details = (
        "Flags newly added Python, JS or TS lint/type suppression directives in actual "
        "comments. Excludes directive-looking strings. Low severity reflects common "
        "legitimate tool limitations; comments require review rather than a verdict."
    )
    id = "AC010"
    name = "lint-or-type-suppression-added"
    default_severity = "low"
    applies_to = {"source", "test"}
    why_flagged = "Suppressions can hide defects instead of addressing the diagnostic."
    legit_if = "The diagnostic is a documented false positive or an intentional typing escape."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        comments = added_comments(change, ctx.mode == "full")
        lines = [
            line for line in change.added if PATTERN.search(comments.get(line.new_line or 1, ""))
        ]
        if not lines:
            return []
        return [
            self.finding(
                change,
                lines[0].new_line or 1,
                f"{len(lines)} lint/type suppression(s) added",
                "\n".join(line.value for line in lines),
            )
        ]
