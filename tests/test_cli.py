from goodhart.cli import main


def test_rules(capsys):
    assert main(["rules"]) == 0
    assert "GH001" in capsys.readouterr().out
