@pytest.mark.parametrize("value, expected", [("nested", 4242), ("other", 4343)])
def test_existing(value, expected):
    assert run(value) == expected
