"""Source code which detects a test runner or CI environment."""

import re
from pathlib import PurePosixPath

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import code_lines

PATTERN = re.compile(
    r"\bPYTEST_CURRENT_TEST\b|['\"](?:pytest|unittest)['\"]\s+in\s+sys\.modules"
    r"|sys\.modules\.get\(\s*['\"](?:pytest|unittest)['\"]"
    r"|\bJEST_WORKER_ID\b|\bVITEST\b"
    r"|process\.env\.NODE_ENV\s*(?:===?|!==?)\s*['\"]test['\"]"
    r"|os\.environ\.get\(\s*['\"]CI['\"]|process\.env\.CI\b"
)


class TestEnvironmentDetection(RuleBase):
    id = "GH009"
    name = "test-environment-detection"
    default_severity = "high"
    applies_to = {"source"}
    why_flagged = "Source code can alter behavior when it detects tests or CI."
    legit_if = "Test/CI detection configures isolated resources or legitimate environment settings."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if "test" in change.kinds:
            return []
        name = PurePosixPath(change.path).name
        settings = name == "settings.py" or name.startswith(("config.", "env."))
        return [
            self.finding(
                change,
                line.new_line or 1,
                "Test/CI environment referenced in source",
                line.value,
                severity="low" if settings else "high",
            )
            for line in code_lines(change)
            if PATTERN.search(line.value)
        ]
