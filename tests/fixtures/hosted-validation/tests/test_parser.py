def test_primary():
    assert parse("nested") == 4242

def test_skip():
    assert parse("flat") == 4343

def test_removed():
    assert parse("other") == 4444
