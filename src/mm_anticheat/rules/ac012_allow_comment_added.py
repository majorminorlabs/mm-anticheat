"""Surface allow directives introduced in the scanned diff."""

import re

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.rules.base import Finding, RuleBase
from mm_anticheat.util import added_comments

PATTERN = re.compile(r"(?:#|//)\s*anticheat:\s*allow\b")


class AllowCommentAdded(RuleBase):
    details = (
        "Reports any actual allow comment added in the scanned diff at medium severity. "
        "This finding cannot be allowed inline, including by an inline AC012 directive. "
        "An explicit .anticheat.toml path allowance can mark it allowed. Other findings "
        "may still be allowed inline with a nonempty reason, but AC012 remains visible."
    )
    id = "AC012"
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
