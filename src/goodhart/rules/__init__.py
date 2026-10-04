"""Deterministically ordered rule registry."""

from goodhart.rules.base import Rule


def all_rules() -> list[Rule]:
    """Load rules lazily to avoid a runtime cycle with ScanContext."""
    from goodhart.rules.gh000_diagnostics import Diagnostics
    from goodhart.rules.gh001_test_file_deleted import TestFileDeleted
    from goodhart.rules.gh002_test_count_decreased import TestCountDecreased
    from goodhart.rules.gh003_skip_marker_added import SkipMarkerAdded
    from goodhart.rules.gh004_assertion_count_decreased import AssertionCountDecreased
    from goodhart.rules.gh005_assertion_weakened import AssertionWeakened
    from goodhart.rules.gh006_hardcoded_test_expectation import HardcodedTestExpectation
    from goodhart.rules.gh007_test_config_tampered import TestConfigTampered
    from goodhart.rules.gh008_exception_swallowed import ExceptionSwallowed
    from goodhart.rules.gh009_test_environment_detection import TestEnvironmentDetection
    from goodhart.rules.gh010_lint_or_type_suppression_added import LintOrTypeSuppressionAdded
    from goodhart.rules.gh011_snapshot_updated_with_source import SnapshotUpdatedWithSource
    from goodhart.rules.gh012_allow_comment_added import AllowCommentAdded

    return [
        Diagnostics(),
        TestFileDeleted(),
        TestCountDecreased(),
        SkipMarkerAdded(),
        AssertionCountDecreased(),
        AssertionWeakened(),
        HardcodedTestExpectation(),
        TestConfigTampered(),
        ExceptionSwallowed(),
        TestEnvironmentDetection(),
        LintOrTypeSuppressionAdded(),
        SnapshotUpdatedWithSource(),
        AllowCommentAdded(),
    ]
