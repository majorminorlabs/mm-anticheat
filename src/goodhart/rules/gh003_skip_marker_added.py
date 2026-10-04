"""Skip and exclusive-run markers on existing or newly added tests."""

import re

from goodhart.diffmodel import FileChange, Line
from goodhart.engine import ScanContext
from goodhart.lang import jsts, python
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import is_python, python_code

PATTERN = re.compile(
    r"@pytest\.mark\.(?:skipif|skip|xfail)\b|\bpytest\.skip\s*\("
    r"|@unittest\.skip\w*\b|\bself\.skipTest\s*\("
    r"|\b(?:it|test|describe)\.(?:skip|todo|only)\b|\b(?:xit|xdescribe)\s*\("
)


class SkipMarkerAdded(RuleBase):
    id = "GH003"
    name = "skip-marker-added"
    default_severity = "high"
    applies_to = {"test"}
    why_flagged = (
        "Skip or exclusive-run markers can make the suite pass without exercising behavior."
    )
    legit_if = "The test is flaky or obsolete and the skip is tracked elsewhere."

    def _new_test(self, line: Line, change: FileChange, ctx: ScanContext) -> bool:
        lang = python if is_python(change.path) else jsts
        if change.old_path is None:
            return True
        if ctx.mode == "full":
            old = {test.name for test in lang.tests(change.base_content or "")}
            for test in lang.tests(change.head_content or ""):
                if test.line <= (line.new_line or 1) <= test.end:
                    return test.name not in old
            return False
        old = {name for name, _ in lang.definition_names(change.visible("base"))}
        for hunk in change.hunks:
            current = [item for item in hunk.lines if item.kind != "-"]
            if line not in current:
                continue
            index = current.index(line)
            nearby = current[max(0, index - 3) : index + 4]
            defs = lang.definition_names("\n".join(item.value for item in nearby))
            return bool(defs and defs[0][0] not in old)
        return False

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        findings = []
        if ctx.mode == "full":
            text = change.head_content or ""
            clean = python_code(text) if is_python(change.path) else jsts.mask(text, strings=True)
            clean_lines = clean.splitlines()
        else:
            clean_lines = []
        for line in change.added:
            code = (
                clean_lines[(line.new_line or 1) - 1]
                if clean_lines and (line.new_line or 1) <= len(clean_lines)
                else line.value
            )
            if code.lstrip().startswith(("#", "//")) or not PATTERN.search(code):
                continue
            new = self._new_test(line, change, ctx)
            findings.append(
                self.finding(
                    change,
                    line.new_line or 1,
                    "Skip/exclusive marker added to "
                    + ("a new test" if new else "an existing test"),
                    line.value,
                    severity="low" if new else "high",
                )
            )
        return findings
