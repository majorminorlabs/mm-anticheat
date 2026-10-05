"""Count test definitions on both sides of a change."""

import re
from collections import Counter

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang.moves import destinations, names
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line


class TestCountDecreased(RuleBase):
    id = "GH002"
    name = "test-count-decreased"
    default_severity = "high"
    applies_to = {"test"}
    why_flagged = "Fewer test definitions may leave previously checked behavior untested."
    legit_if = "Tests were consolidated into parametrized cases or obsolete behavior was removed."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if change.new_path is None:
            return []  # GH001 covers deleted test files without duplicate findings.
        if ctx.mode == "full":
            before = names(change, "base", True)
            after = names(change, "head", True)
        else:
            from goodhart.lang import jsts, python
            from goodhart.util import is_python

            lang = python if is_python(change.path) else jsts
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
        removed = list((Counter(before) - Counter(after)).elements())
        overlap, targets = destinations(removed, change, ctx.changes, ctx.mode == "full")
        severity = "info" if overlap >= 0.8 else "medium" if overlap > 0 or consolidated else "high"
        if targets:
            why += " Tests appear to have moved to: " + ", ".join(targets) + "."
        return [
            self.finding(
                change,
                first_line(change),
                f"Test count decreased: {len(before)} → {len(after)}",
                "Removed tests: " + ", ".join(removed or before),
                severity=severity,
                reduced=ctx.mode == "patch",
                why=why,
            )
        ]
