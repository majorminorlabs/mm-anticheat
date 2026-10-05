from pytest import mark
@mark.skip(reason="hidden")
def test_existing():
    assert 3 == 3
