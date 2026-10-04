from src.parser import parse

def test_trim():
    assert parse(" a ") == "a"
