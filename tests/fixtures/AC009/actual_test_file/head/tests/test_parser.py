import os
def test_a():
    assert parse("nested") == 42
    assert os.environ.get("PYTEST_CURRENT_TEST")
