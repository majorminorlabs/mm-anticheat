"""Parsing diagnostics and incomplete inline allow directives."""

import re

from mm_anticheat.diffmodel import FileChange
from mm_anticheat.engine import ScanContext
from mm_anticheat.rules.base import Finding, RuleBase
from mm_anticheat.util import first_line, visible_comments


def parse_skipped(path: str, reason: str, line: int = 1) -> Finding:
    """Report skipped content without silently hiding lost coverage."""
    return Finding(
        "AC000",
        "parse-skipped",
        "info",
        "normal",
        path,
        max(1, line),
        "Content could not be parsed",
        reason,
        "This content could not be analyzed completely; review it separately.",
        "Binary content, unsupported encoding, or an incomplete patch is intentional.",
    )


class Diagnostics(RuleBase):
    details = (
        "Reports unavailable, binary, oversized or malformed content and caught rule "
        "errors without hiding later findings. Inline directives without a nonempty "
        "quoted reason add a low allow-missing-reason diagnostic. Analysis bounds are 1 "
        "MB per file and 20,000 characters per line."
    )
    id = "AC000"
    name = "parse-skipped / allow-missing-reason"
    default_severity = "info"
    applies_to = {"source", "test", "config", "snapshot", "other"}
    why_flagged = "An inline allow without a reason does not suppress findings."
    legit_if = "Add a specific reason documenting the reviewed exception."

    def check(self, change: FileChange, ctx: ScanContext) -> list[Finding]:
        findings = []
        if change.parse_error:
            findings.append(parse_skipped(change.path, change.parse_error, first_line(change)))
        text = change.head_content if ctx.mode == "full" else None
        lines = (
            list(enumerate(text.splitlines(), 1))
            if text is not None
            else [
                (line.new_line or 1, line.value)
                for hunk in change.hunks
                for line in hunk.lines
                if line.kind != "-"
            ]
        )
        comments = visible_comments(change, ctx.mode == "full")
        for number, line in lines:
            comment = comments.get(number, "")
            reason = re.search(r"\breason\s*=\s*(['\"])(.*?)\1", comment)
            if re.search(r"(?:#|//)\s*anticheat:\s*allow\b", comment) and (
                reason is None or not reason[2].strip()
            ):
                finding = self.finding(
                    change, number, "Allow directive is missing a reason", line, severity="low"
                )
                finding.rule_name = "allow-missing-reason"
                findings.append(finding)
        return findings
