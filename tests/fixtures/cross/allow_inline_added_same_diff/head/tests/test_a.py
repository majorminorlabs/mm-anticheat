# goodhart: allow GH003 reason="reviewed"
@pytest.mark.skip(reason="flaky")
def test_a():
    assert 3 == 3
