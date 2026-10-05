"""Human-readable severity groups; ANSI is added only for a requested TTY render."""

from goodhart import TOOL_NAME
from goodhart.engine import ScanResult, file_counts
from goodhart.rules.base import SEVERITY_ORDER

COLORS = {"high": "31", "medium": "33", "low": "36", "info": "90"}


def safe(text: str) -> str:
    """Display control characters visibly, preserving evidence newlines/tabs."""
    return "".join(c if c.isprintable() or c in "\n\t" else f"\\x{ord(c):02x}" for c in text)


def label(result: ScanResult) -> str:
    """Describe the resolved input range."""
    return f"{result.data.base}...{result.data.head}" if result.data.mode == "full" else "patch"


def summary_line(result: ScanResult) -> str:
    """One concise line for quiet output."""
    counts = " | ".join(
        f"{key}: {value}"
        + (
            f" ({count} allowed)"
            if (count := sum(f.allowed and f.severity == key for f in result.findings))
            else ""
        )
        for key, value in result.summary.items()
    )
    allowed = sum(f.allowed for f in result.findings)
    return safe(
        f"{TOOL_NAME} | {label(result)} | config: {result.data.config.source} | "
        f"{result.files_scanned} files | "
        f"{counts} | allowed: {allowed}"
    )


def evidence_lines(text: str, maximum: int) -> list[str]:
    """Limit presentation without modifying the finding or JSON evidence."""
    lines = safe(text).splitlines()
    return lines[:maximum] + (
        [f"… {len(lines) - maximum} more evidence lines"] if len(lines) > maximum else []
    )


def render(
    result: ScanResult, *, color: bool = False, quiet: bool = False, max_evidence_lines: int = 6
) -> str:
    """Render all findings, including reviewed exceptions."""
    lines = [summary_line(result)]
    if quiet:
        return "\n".join(lines) + "\n"
    lines.append(" | ".join(f"{kind}: {count}" for kind, count in file_counts(result.data).items()))
    for severity in SEVERITY_ORDER:
        findings = [f for f in result.findings if f.severity == severity]
        if not findings:
            continue
        heading = severity.upper()
        if color:
            heading = f"\033[{COLORS[severity]}m{heading}\033[0m"
        lines.extend(["", f"{heading} ({len(findings)})"])
        for finding in findings:
            status = " [allowed]" if finding.allowed else ""
            lines.append(
                safe(
                    f"  [{severity}] {finding.rule_id} {finding.file}:{finding.line} "
                    f"{finding.title}{status}"
                )
            )
            lines.extend(
                "    " + line for line in evidence_lines(finding.evidence, max_evidence_lines)
            )
            lines.append("    Why: " + safe(finding.why_flagged))
            lines.append("    Review: " + safe(finding.legit_if))
    return "\n".join(lines) + "\n"
