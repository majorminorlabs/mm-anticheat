from subject import run

def test_value(monkeypatch):
    assert run(17) == 5
