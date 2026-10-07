from __future__ import annotations

import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import node_control


def test_registry_contains_heterogeneous_nodes() -> None:
    nodes = node_control.load_nodes()
    assert set(nodes) == {"rtx3070", "thinkpad"}
    assert nodes["thinkpad"]["transport"]["alias"] == "thinkpad"
    assert nodes["rtx3070"]["inference"]["base_url"].endswith(":8080")


def test_status_keeps_inference_and_transport_independent(monkeypatch) -> None:
    node = node_control.load_nodes()["thinkpad"]
    monkeypatch.setattr(node_control, "_ssh_probe", lambda _: {"reachable": True, "cpu": "Ryzen", "ram_available_bytes": "123"})
    monkeypatch.setattr(node_control, "_http_get", lambda _: (False, None, "connection refused"))
    status = node_control.status_node(node)
    assert status["reachable"] is True
    assert status["cpu"] == "Ryzen"
    assert status["ram_available_bytes"] == 123
    assert status["inference"]["state"] == "not-installed"


def test_ssh_probe_parses_linux_key_values(monkeypatch) -> None:
    class Completed:
        returncode = 0
        stdout = "hostname=pop-os\ncpu=AMD Ryzen 7 PRO 5850U\nram_available_bytes=987\n"
        stderr = ""

    monkeypatch.setattr(node_control.subprocess, "run", lambda *args, **kwargs: Completed())
    probe = node_control._ssh_probe(node_control.load_nodes()["thinkpad"])
    assert probe["reachable"] is True
    assert probe["cpu"] == "AMD Ryzen 7 PRO 5850U"
    assert probe["ram_available_bytes"] == "987"
