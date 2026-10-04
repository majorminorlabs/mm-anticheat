"""Deterministically ordered rule registry."""


def all_rules() -> list:
    """Load rules lazily to avoid a runtime cycle with ScanContext."""
    from goodhart.rules.gh001_test_file_deleted import TestFileDeleted
    from goodhart.rules.gh002_test_count_decreased import TestCountDecreased
    from goodhart.rules.gh003_skip_marker_added import SkipMarkerAdded
    from goodhart.rules.gh004_assertion_count_decreased import AssertionCountDecreased

    return [TestFileDeleted(), TestCountDecreased(), SkipMarkerAdded(), AssertionCountDecreased()]
