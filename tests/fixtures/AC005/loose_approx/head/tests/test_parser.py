def test_a():
    assert parse("nested") == pytest.approx(42, rel=0.2)
