"""Informational reminder to review snapshot changes alongside source."""

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import first_line


class SnapshotUpdatedWithSource(RuleBase):
    id = "GH011"
    name = "snapshot-updated-with-source"
    default_severity = "info"
    applies_to = {"snapshot"}
    why_flagged = "Review that snapshot changes reflect intended behavior."
    legit_if = "The reviewed source change intentionally changes this snapshot output."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        sources = [item.path for item in ctx.changes if "source" in item.kinds]
        if not sources:
            return []
        return [
            self.finding(
                change,
                first_line(change),
                "Snapshot changed alongside source",
                "Source files: " + ", ".join(sources),
            )
        ]
