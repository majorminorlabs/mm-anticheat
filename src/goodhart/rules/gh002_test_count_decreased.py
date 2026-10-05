"""Count test definitions on both sides of a change."""

import re
from collections import Counter

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang.moves import destinations, names
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line


class TestCountDecreased(RuleBase):
    details = (
        "Compares per-file test counts, listing removed names. Deleted files belong to "
        "GH001. Full mode counts Python tests with AST and JS/TS calls with lexical "
        "heuristics; patch mode counts visible definitions with reduced confidence. "
        "Added parametrization yields medium. Substantive moves can yield info; weaker "
        "destination assertions yield medium; empty stubs preserve high."
    )
    id = "GH002"
    name = "test-count-decreased"
    default_severity = "high"
    applies_to = {"test"}
    why_flagged = "Fewer test definitions may leave previously checked behavior untested."
    legit_if = "Tests were consolidated into parametrized cases or obsolete behavior was removed."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if change.new_path is None:
            return []  # GH001 covers deleted test files without duplicate findings.
        cache = ctx.cache.setdefault("move_inventories", {})
        if ctx.mode == "full":
            before = names(change, "base", True, cache)
            after = names(change, "head", True, cache)
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
        moves = destinations(removed, change, ctx.changes, ctx.mode == "full", cache)
        severity = "medium" if consolidated and moves.severity == "high" else moves.severity
        why += moves.explanation()
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
