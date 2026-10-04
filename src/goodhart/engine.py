"""Scanner orchestration. Rules are added in subsequent phases."""

from dataclasses import dataclass, field

from goodhart.config import Config
from goodhart.diffmodel import FileChange
from goodhart.git import ScanInput
from goodhart.rules.base import SEVERITY_ORDER, Finding


@dataclass
class ScanContext:
    """Read-only scan-wide inputs accessible to each rule."""

    mode: str
    changes: list[FileChange]
    config: Config
    extra_tests: dict[str, str] = field(default_factory=dict)


@dataclass
class ScanResult:
    data: ScanInput
    findings: list[Finding]

    @property
    def files_scanned(self) -> int:
        return sum(change.kinds != frozenset({"other"}) for change in self.data.changes)

    @property
    def summary(self) -> dict[str, int]:
        return {
            severity: sum(item.severity == severity for item in self.findings)
            for severity in SEVERITY_ORDER
        }

    def exit_code(self, fail_on: str = "high") -> int:
        if fail_on == "never":
            return 0
        return int(
            any(
                not item.allowed and SEVERITY_ORDER[item.severity] <= SEVERITY_ORDER[fail_on]
                for item in self.findings
            )
        )


def scan(data: ScanInput, config: Config | None = None, rules: list | None = None) -> ScanResult:
    """Run applicable rules and sort findings deterministically."""
    from goodhart.rules import all_rules

    config = config or Config()
    ctx = ScanContext(data.mode, data.changes, config, data.extra_tests)
    findings = []
    for change in data.changes:
        if change.parse_error:
            continue  # GH000 diagnostics arrive in Phase 3.
        for rule in all_rules() if rules is None else rules:
            if change.kinds & rule.applies_to and rule.id not in config.skip_rules:
                findings.extend(rule.check(change, ctx))
    findings.sort(
        key=lambda item: (
            SEVERITY_ORDER[item.severity],
            item.file,
            item.line,
            item.rule_id,
            item.title,
        )
    )
    return ScanResult(data, findings)


def file_counts(data: ScanInput) -> dict[str, int]:
    """Count files by kind; conftest is included in both test and config."""
    return {
        kind: sum(kind in change.kinds for change in data.changes)
        for kind in ("test", "source", "config", "snapshot", "other")
    }
