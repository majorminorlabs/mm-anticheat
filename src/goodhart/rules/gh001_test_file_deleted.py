"""Deleted tests and renames away from test paths."""

from pathlib import PurePosixPath

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line


class TestFileDeleted(RuleBase):
    id = "GH001"
    name = "test-file-deleted"
    default_severity = "high"
    applies_to = {"test"}
    why_flagged = "Removing a test file can remove coverage of behavior that still exists."
    legit_if = "The code under test was also deleted, or coverage moved to another test file."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        if "test" not in change.old_kinds or (
            change.new_path is not None and "test" in change.new_kinds
        ):
            return []
        stem = PurePosixPath(change.old_path or change.path).stem
        subject = stem.removeprefix("test_").removesuffix("_test")
        subject = subject.removesuffix(".test").removesuffix(".spec")
        matching = [
            item.path
            for item in ctx.changes
            if item.new_path is None
            and "source" in item.old_kinds
            and PurePosixPath(item.path).stem == subject
        ]
        why = self.why_flagged
        if matching:
            why += " Matching source was also deleted: " + ", ".join(matching) + "."
        return [
            self.finding(
                change,
                first_line(change),
                "Test file removed from the suite",
                change.old_path or change.path,
                severity="low" if matching else "high",
                why=why,
            )
        ]
