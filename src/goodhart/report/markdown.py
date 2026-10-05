"""PR-ready Markdown with escaped summaries and safely fenced evidence."""

import html
import re

from goodhart.engine import ScanResult, file_counts
from goodhart.report.text import evidence_lines, safe, summary_line


def render(result: ScanResult, *, quiet: bool = False, max_evidence_lines: int = 6) -> str:
    """Produce collapsible details without modifying complete JSON findings."""
    lines = [html.escape(summary_line(result))]
    if quiet:
        return "\n".join(lines) + "\n"
    lines.extend(
        ["", " | ".join(f"{kind}: {count}" for kind, count in file_counts(result.data).items())]
    )
    for finding in result.findings:
        status = " [allowed]" if finding.allowed else ""
        title = html.escape(safe(f"[{finding.severity}] {finding.rule_id} {finding.title}{status}"))
        evidence = "\n".join(evidence_lines(finding.evidence, max_evidence_lines))
        runs = [len(match[0]) for match in re.finditer(r"`+", evidence)]
        fence = "`" * max(3, max(runs, default=0) + 1)
        lines.extend(
            [
                "",
                "<details>",
                f"<summary>{title}</summary>",
                "",
                f"<code>{html.escape(safe(finding.file))}:{finding.line}</code>",
                "",
                fence + "text",
                evidence,
                fence,
                "",
                "Why: " + html.escape(safe(finding.why_flagged)),
                "",
                "Review: " + html.escape(safe(finding.legit_if)),
                "",
                "</details>",
            ]
        )
    return "\n".join(lines) + "\n"
