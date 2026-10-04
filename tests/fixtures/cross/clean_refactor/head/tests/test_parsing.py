from src.parsing import parse

def test_trim():
    assert parse(" a ") == "a"

def test_plain():
    assert parse("b") == "b"
