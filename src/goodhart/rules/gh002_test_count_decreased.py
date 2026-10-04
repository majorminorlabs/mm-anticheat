"""Count test definitions on both sides of a change."""

import re

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line, is_python


class TestCountDecreased(RuleBase):
    id = "GH002"
    name = "test-count-decreased"
    default_severity = "high"
    applies_to = {"test"}
    why_flagged = "Fewer test definitions may leave previously checked behavior untested."
    legit_if = "Tests were consolidated into parametrized cases or obsolete behavior was removed."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        lang = python if is_python(change.path) else jsts
        if ctx.mode == "full":
            before = [test.name for test in lang.tests(change.base_content or "")]
            after = [test.name for test in lang.tests(change.head_content or "")]
        else:
            before = [
                name
                for name, _ in lang.definition_names(
                    "\n".join(line.value for line in change.removed)
                )
            ]
            after = [
                name
                for name, _ in lang.definition_names("\n".join(line.value for line in change.added))
            ]
        if len(after) >= len(before):
            return []
        consolidated = any(
            re.search(r"\bparametrize\b|\.(?:each)\b", line.value) for line in change.added
        )
        why = self.why_flagged + (
            " Parametrization was added in this file." if consolidated else ""
        )
        removed = [name for name in before if name not in after]
        return [
            self.finding(
                change,
                first_line(change),
                f"Test count decreased: {len(before)} → {len(after)}",
                "Removed tests: " + ", ".join(removed or before),
                severity="medium" if consolidated else "high",
                reduced=ctx.mode == "patch",
                why=why,
            )
        ]
