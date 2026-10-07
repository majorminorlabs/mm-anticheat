"""Informational reminder to review snapshot changes alongside source."""

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.rules.base import Finding, RuleBase
from mm_anticheat.util import first_line


class SnapshotUpdatedWithSource(RuleBase):
    details = (
        "Reports changed snapshot files when source also changes in the same diff. Info "
        "only: check that generated expected output reflects intended behavior. "
        "Test-only or snapshot-only edits do not trigger this cross-file hint."
    )
    id = "AC011"
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
