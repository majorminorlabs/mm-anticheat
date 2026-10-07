"""Runner detection is high; ordinary CI checks are medium, with string masking."""

import re
from pathlib import PurePosixPath

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.lang import jsts
from mm_anticheat.rules.base import Finding, RuleBase
from mm_anticheat.util import is_python, python_code, without_comments

KEY = r"['\"](?:PYTEST_CURRENT_TEST|JEST_WORKER_ID|VITEST)['\"]"
ENV = r"(?:os\.environ\.get|os\.getenv)\(\s*"
RUNNER = re.compile(
    ENV
    + KEY
    + r"|os\.environ\[\s*"
    + KEY
    + r"|process\.env\.(?:PYTEST_CURRENT_TEST|JEST_WORKER_ID|VITEST)\b"
    + r"|['\"](?:pytest|unittest)['\"]\s+in\s+sys\.modules"
    + r"|sys\.modules\.get\(\s*['\"](?:pytest|unittest)['\"]"
    + r"|['\"]pytest['\"]\s+in\s+sys\.argv\s*\[\s*0\s*\]"
    + r"|(?:process\.env\.NODE_ENV|import\.meta\.env\.MODE)\s*(?:===?|!==?)\s*['\"]test['\"]"
    + r"|import\.meta\.vitest\b|\b(?:PYTEST_CURRENT_TEST|JEST_WORKER_ID|VITEST)\b"
)
CI = re.compile(
    ENV + r"['\"]CI['\"]|os\.environ\[\s*['\"]CI['\"]"
    r"|['\"]CI['\"]\s+in\s+os\.environ|process\.env\.CI\b"
)


class TestEnvironmentDetection(RuleBase):
    details = (
        "Flags source code that detects pytest, unittest, Jest or Vitest runners, "
        "including runner env variables, sys.modules/argv and import.meta. Runner "
        "detection is high; plain CI checks are medium; conventional settings files are "
        "low. Comments and help strings are excluded. Resource isolation and timeout "
        "configuration can be legitimate."
    )
    id = "AC009"
    name = "test-environment-detection"
    default_severity = "high"
    applies_to = {"source"}
    why_flagged = "Source code can alter behavior when it detects a test runner or CI."
    legit_if = (
        "Detection configures isolated resources, timeouts or legitimate environment settings."
    )

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if "test" in change.kinds:
            return []
        name = PurePosixPath(change.path).name
        settings = name == "settings.py" or name.startswith(("config.", "env."))
        added = {line.new_line: line for line in change.added}
        regions = []
        if ctx.mode == "full":
            text = change.head_content or ""
            regions.append((text, list(range(1, len(text.splitlines()) + 1))))
        else:
            for hunk in change.hunks:
                lines = [line for line in hunk.lines if line.kind != "-"]
                regions.append(
                    ("\n".join(line.value for line in lines), [line.new_line for line in lines])
                )
        hits = {}
        for text, coordinates in regions:
            clean = without_comments(text, is_python(change.path))
            shape = python_code(text) if is_python(change.path) else jsts.mask(text, strings=True)
            for pattern, severity in ((CI, "medium"), (RUNNER, "high")):
                for match in pattern.finditer(clean):
                    if not shape[match.start() : match.end()].strip():
                        continue  # The entire hit is inside a string/comment.
                    start = clean.count("\n", 0, match.start())
                    end = clean.count("\n", 0, match.end() - 1)
                    for index in range(start, end + 1):
                        row = coordinates[index]
                        if row in added:
                            hits[row] = "low" if settings else severity
        return [
            self.finding(
                change,
                row or 1,
                "Test/CI environment referenced in source",
                added[row].value,
                severity=severity,
            )
            for row, severity in sorted(hits.items())
        ]
