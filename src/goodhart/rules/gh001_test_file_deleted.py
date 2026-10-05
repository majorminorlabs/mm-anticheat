"""Deleted tests and renames away from test paths."""

from pathlib import PurePosixPath

from goodhart.classify import matches
from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.lang.moves import destinations, names
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line


class TestFileDeleted(RuleBase):
    details = (
        "Flags deletion or renaming out of the suite only when the base defines tests. "
        "Same-path classification changes never count as deletion. Matching source "
        "deletion lowers severity to low. Name-matched moves require substantive "
        "assertions: complete moves covering at least 80% are info; partial or weakened "
        "moves are medium; empty destinations do not corroborate movement."
    )
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
        if change.old_path == change.new_path:
            return []  # A content-only classification change is not a deletion.
        if change.new_path and not any(
            matches(change.old_path or "", glob) for glob in ctx.config.test_globs
        ):
            return []
        cache = ctx.cache.setdefault("move_inventories", {})
        removed = names(change, "base", ctx.mode == "full", cache)
        if not removed:
            return []
        moves = destinations(removed, change, ctx.changes, ctx.mode == "full", cache)
        severity = moves.severity
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
        why = self.why_flagged + moves.explanation()
        if matching:
            severity = "low" if severity != "info" else severity
            why += " Matching source was also deleted: " + ", ".join(matching) + "."
        return [
            self.finding(
                change,
                first_line(change),
                "Test file removed from the suite",
                change.old_path or change.path,
                severity=severity,
                why=why,
            )
        ]
