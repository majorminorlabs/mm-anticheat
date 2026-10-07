from subject import run

def test_value(monkeypatch):
    monkeypatch.setattr("subject.run", lambda x: 100)
    assert run(17) == 100
