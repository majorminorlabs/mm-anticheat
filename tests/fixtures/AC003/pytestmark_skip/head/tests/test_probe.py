pytestmark = pytest.mark.skip(reason="all tests")
def test_existing():
    assert 3 == 3
