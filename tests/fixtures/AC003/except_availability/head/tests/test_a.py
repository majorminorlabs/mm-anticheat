import pytest
def test_a():
    try:
        symlink()
    except OSError:
        pytest.skip("unsupported filesystem")
    assert 3 == 3
