"""Surface allow directives introduced in the scanned diff."""

import re

from goodhart.diffmodel import FileChange
from goodhart.engine import ScanContext
from goodhart.rules.base import Finding, RuleBase
from goodhart.util import added_comments

PATTERN = re.compile(r"(?:#|//)\s*goodhart:\s*allow\b")


class AllowCommentAdded(RuleBase):
    details = (
        "Reports any actual allow comment added in the scanned diff at medium severity. "
        "This finding cannot be allowed inline, including by an inline GH012 directive. "
        "An explicit .goodhart.toml path allowance can mark it allowed. Other findings "
        "may still be allowed inline with a nonempty reason, but GH012 remains visible."
    )
    id = "GH012"
    name = "allow-comment-added"
    default_severity = "medium"
    applies_to = {"source", "test", "config", "snapshot", "other"}
    why_flagged = "An added allow directive can suppress a finding in the same agent-produced diff."
    legit_if = "A reviewer approved the exception and its recorded reason."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        comments = added_comments(change, ctx.mode == "full")
        return [
            self.finding(
                change, line.new_line or 1, "Allow comment added in scanned diff", line.value
            )
            for line in change.added
            if PATTERN.search(comments.get(line.new_line or 1, ""))
        ]
