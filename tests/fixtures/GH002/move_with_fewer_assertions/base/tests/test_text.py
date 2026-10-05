def test_slug_basic():
    assert slug("Hello, World!") == "hello-world"
    assert slug("next") == "next"

def test_other():
    assert slug("other") == "other"
