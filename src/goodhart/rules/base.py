"""Rule contract and review findings."""

from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal, Protocol

from goodhart.classify import FileKind
from goodhart.diffmodel import FileChange

if TYPE_CHECKING:
    from goodhart.engine import ScanContext

Severity = Literal["high", "medium", "low", "info"]
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2, "info": 3}


@dataclass
class Finding:
    """Evidence to review, never a verdict about intent."""

    rule_id: str
    rule_name: str
    severity: Severity
    confidence: str
    file: str
    line: int
    title: str
    evidence: str
    why_flagged: str
    legit_if: str
    allowed: bool = False


class Rule(Protocol):
    """Metadata and deterministic per-file check."""

    id: str
    name: str
    default_severity: Severity
    applies_to: set[FileKind]
    supports_patch_mode: bool
    why_flagged: str
    legit_if: str
    details: str

    def check(self, change: FileChange, ctx: "ScanContext") -> list[Finding]: ...


class RuleBase:
    """Shared finding construction; individual rules own their matching logic."""

    id: str
    name: str
    default_severity: Severity
    applies_to: set[FileKind]
    supports_patch_mode = True
    why_flagged: str
    legit_if: str
    details = ""

    def finding(
        self,
        change: FileChange,
        line: int,
        title: str,
        evidence: str,
        *,
        severity: Severity | None = None,
        reduced: bool = False,
        why: str | None = None,
    ) -> Finding:
        return Finding(
            self.id,
            self.name,
            severity or self.default_severity,
            "reduced" if reduced else "normal",
            change.path,
            max(line, 1),
            title,
            evidence,
            why or self.why_flagged,
            self.legit_if,
        )
