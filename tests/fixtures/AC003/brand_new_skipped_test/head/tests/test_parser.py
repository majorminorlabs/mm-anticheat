def test_a():
    assert parse("nested") == 42

@pytest.mark.skip(reason="future feature")
def test_new():
    assert 4 == 4
