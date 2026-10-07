"""Deterministically ordered rule registry."""

from mm_anticheat.rules.base import Rule


def all_rules() -> list[Rule]:
    """Load rules lazily to avoid a runtime cycle with ScanContext."""
    from mm_anticheat.rules.ac000_diagnostics import Diagnostics
    from mm_anticheat.rules.ac001_test_file_deleted import TestFileDeleted
    from mm_anticheat.rules.ac002_test_count_decreased import TestCountDecreased
    from mm_anticheat.rules.ac003_skip_marker_added import SkipMarkerAdded
    from mm_anticheat.rules.ac004_assertion_count_decreased import AssertionCountDecreased
    from mm_anticheat.rules.ac005_assertion_weakened import AssertionWeakened
    from mm_anticheat.rules.ac006_hardcoded_test_expectation import HardcodedTestExpectation
    from mm_anticheat.rules.ac007_test_config_tampered import TestConfigTampered
    from mm_anticheat.rules.ac008_exception_swallowed import ExceptionSwallowed
    from mm_anticheat.rules.ac009_test_environment_detection import TestEnvironmentDetection
    from mm_anticheat.rules.ac010_lint_or_type_suppression_added import LintOrTypeSuppressionAdded
    from mm_anticheat.rules.ac011_snapshot_updated_with_source import SnapshotUpdatedWithSource
    from mm_anticheat.rules.ac012_allow_comment_added import AllowCommentAdded
    from mm_anticheat.rules.ac013_test_short_circuited import Detector as Rule013
    from mm_anticheat.rules.ac014_assertion_error_swallowed import Detector as Rule014
    from mm_anticheat.rules.ac015_collection_or_exit_hook import Detector as Rule015
    from mm_anticheat.rules.ac016_always_equal_override import Detector as Rule016
    from mm_anticheat.rules.ac017_unit_under_test_mocked import Detector as Rule017
    from mm_anticheat.rules.ac018_expectation_rewritten import Detector as Rule018

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
        Rule013(),
        Rule014(),
        Rule015(),
        Rule016(),
        Rule017(),
        Rule018(),
    ]
