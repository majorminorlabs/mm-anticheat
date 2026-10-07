@pytest.mark.parametrize("value", [42, 43])
def test_a(value):
    assert parse(value) == value
