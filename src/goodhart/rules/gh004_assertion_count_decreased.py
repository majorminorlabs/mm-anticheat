"""Detect assertion loss per existing test, or per patch hunk."""

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import assertion_line, first_line, is_python


class AssertionCountDecreased(RuleBase):
    id = "GH004"
    name = "assertion-count-decreased"
    default_severity = "medium"
    applies_to = {"test"}
    why_flagged = "Fewer assertions can make a test pass while checking less behavior."
    legit_if = "Redundant checks were removed, or equivalent checks moved into a shared helper."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        removed = "\n".join(line.value for line in change.removed if assertion_line(line.value))
        if ctx.mode == "full":
            lang = python if is_python(change.path) else jsts
            before = {test.name: test for test in lang.tests(change.base_content or "")}
            after = {test.name: test for test in lang.tests(change.head_content or "")}
            return [
                self.finding(
                    change,
                    test.line,
                    f"Assertions decreased in {name}: "
                    f"{before[name].assertions} → {test.assertions}",
                    f"{name}\n{removed}",
                )
                for name, test in after.items()
                if name in before and test.assertions < before[name].assertions
            ]
        findings = []
        for hunk in change.hunks:
            before = [
                line for line in hunk.lines if line.kind == "-" and assertion_line(line.value)
            ]
            after = [line for line in hunk.lines if line.kind == "+" and assertion_line(line.value)]
            if len(before) > len(after):
                line = next((item.new_line for item in hunk.lines if item.new_line), None)
                findings.append(
                    self.finding(
                        change,
                        line or first_line(change),
                        f"Assertions decreased in patch hunk: {len(before)} → {len(after)}",
                        "\n".join(item.value for item in before),
                        reduced=True,
                    )
                )
        return findings
