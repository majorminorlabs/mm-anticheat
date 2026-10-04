from goodhart.cli import main


def test_empty_rules(capsys):
    assert main(["rules"]) == 0
    assert "No rules registered" in capsys.readouterr().out
