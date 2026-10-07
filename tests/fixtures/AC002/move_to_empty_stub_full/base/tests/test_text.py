def test_slug_basic():
    assert slug("Hello, World!") == "hello-world"

def test_other():
    assert slug("other") == "other"
