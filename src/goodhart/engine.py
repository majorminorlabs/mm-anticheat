"""Scanner orchestration. Rules are added in subsequent phases."""

from dataclasses import dataclass, field

from goodhart.classify import matches
from goodhart.config import Config, apply_allows
from goodhart.diffmodel import FileChange
from goodhart.git import ScanInput
from goodhart.rules.base import SEVERITY_ORDER, Finding, Rule


@dataclass
class ScanContext:
    """Read-only scan-wide inputs accessible to each rule."""

    mode: str
    changes: list[FileChange]
    config: Config
    extra_tests: dict[str, str] = field(default_factory=dict)
    cache: dict[str, object] = field(default_factory=dict)


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


def scan(
    data: ScanInput,
    config: Config | None = None,
    rules: list[Rule] | None = None,
) -> ScanResult:
    """Run applicable rules and sort findings deterministically."""
    from goodhart.lang import limit_reason, python
    from goodhart.rules import all_rules
    from goodhart.rules.gh000_diagnostics import parse_skipped
    from goodhart.util import is_python

    config = config or data.config
    data.config = config
    ctx = ScanContext(data.mode, data.changes, config, data.extra_tests)
    findings = [parse_skipped(path, reason) for path, reason in data.diagnostics]
    active = all_rules() if rules is None else rules
    for change in data.changes:
        paths = [path for path in (change.old_path, change.new_path) if path]
        control_change = ".goodhart.toml" in paths
        if (
            paths
            and not control_change
            and all(any(matches(path, glob) for glob in config.ignore_globs) for path in paths)
        ):
            continue
        contents = [
            change.base_content or change.visible("base"),
            change.head_content or change.visible("head"),
        ]
        oversized = next(
            (reason for content in contents if (reason := limit_reason(content))), None
        )
        if oversized:
            findings.append(parse_skipped(change.path, oversized))
            continue
        syntax_error = None
        if data.mode == "full" and is_python(change.path) and not change.parse_error:
            for side, content in (("base", change.base_content), ("head", change.head_content)):
                if content is not None:
                    try:
                        python.parse(content)
                    except Exception as exc:
                        syntax_error = f"{side}: {type(exc).__name__}: {exc}"
        if syntax_error:
            findings.append(parse_skipped(change.path, syntax_error))
        diagnosed = bool(change.parse_error or syntax_error)
        for rule in active:
            if change.parse_error and rule.id not in {"GH000", "GH012"}:
                continue
            if change.kinds & rule.applies_to and (
                rule.id not in config.skip_rules or (control_change and rule.id == "GH007")
            ):
                try:
                    findings.extend(rule.check(change, ctx))
                except Exception as exc:
                    if not (diagnosed and isinstance(exc, SyntaxError)):
                        findings.append(
                            parse_skipped(
                                change.path,
                                f"{rule.id}: {type(exc).__name__}: {exc}",
                            )
                        )
    apply_allows(findings, data.changes, config, data.mode == "full")
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
