#!/usr/bin/env python3
"""Read-only status and health queries for a small heterogeneous node set.

This is intentionally separate from the E014 training controller. It discovers
and queries nodes but does not provision, wake, suspend, reboot, or mutate them.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "configs" / "compute_nodes.json"


def load_nodes(path: Path = DEFAULT_CONFIG) -> dict[str, dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    nodes = document.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("compute node configuration must contain a non-empty nodes list")
    result: dict[str, dict[str, Any]] = {}
    for node in nodes:
        node_id = node.get("id")
        if not isinstance(node_id, str) or not node_id or node_id in result:
            raise ValueError(f"invalid or duplicate node id: {node_id!r}")
        result[node_id] = node
    return result


def _ssh_probe(node: dict[str, Any]) -> dict[str, Any]:
    transport = node["transport"]
    command = [
        "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
        "-o", "ServerAliveInterval=3", "-o", "ServerAliveCountMax=1",
        transport["alias"], transport["probe_command"],
    ]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=15, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"reachable": False, "error": str(exc)}
    result: dict[str, Any] = {
        "reachable": completed.returncode == 0,
        "returncode": completed.returncode,
    }
    if completed.stdout.strip():
        result["probe"] = completed.stdout.strip()
        for line in completed.stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                result[key.strip()] = value.strip()
    if completed.stderr.strip():
        result["stderr"] = completed.stderr.strip()[-1000:]
    return result


def _http_get(url: str) -> tuple[bool, Any, str | None]:
    try:
        with urllib.request.urlopen(url, timeout=3) as response:
            body = response.read().decode("utf-8", errors="replace")
            try:
                return True, json.loads(body), None
            except json.JSONDecodeError:
                return True, body, None
    except (OSError, urllib.error.URLError, TimeoutError) as exc:
        return False, None, str(exc)


def _inference_status(node: dict[str, Any]) -> dict[str, Any]:
    inference = node.get("inference", {})
    base_url = inference.get("base_url")
    if not base_url:
        return {"state": "not-installed" if inference.get("backend") == "none-installed" else "not-configured",
                "backend": inference.get("backend")}
    health_url = base_url.rstrip("/") + inference.get("health_path", "/health")
    healthy, health, error = _http_get(health_url)
    result: dict[str, Any] = {
        "state": "healthy" if healthy else "unreachable",
        "backend": inference.get("backend"),
        "endpoint": base_url,
        "health": health,
    }
    if error:
        result["error"] = error
    models_path = inference.get("models_path")
    if healthy and models_path:
        models_ok, models, models_error = _http_get(base_url.rstrip("/") + models_path)
        result["models"] = models if models_ok else None
        if models_error:
            result["models_error"] = models_error
    return result


def status_node(node: dict[str, Any]) -> dict[str, Any]:
    probe = _ssh_probe(node)
    return {
        "id": node["id"],
        "display_name": node.get("display_name"),
        "os": node.get("os"),
        "hardware": node.get("hardware"),
        "ssh_alias": node["transport"].get("alias"),
        "reachable": probe.get("reachable", False),
        "cpu": probe.get("cpu"),
        "ram_available_bytes": _coerce_int(probe.get("ram_available_bytes")),
        "probe": probe,
        "inference": _inference_status(node),
        "power": node.get("power", {}),
        "dispatch": node.get("dispatch", {}),
    }


def _coerce_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("list", "status"))
    parser.add_argument("node", nargs="?", help="node id; status defaults to all nodes")
    parser.add_argument("--config", type=Path, default=Path(os.environ.get("COMPUTE_NODES_CONFIG", DEFAULT_CONFIG)))
    args = parser.parse_args(argv)
    nodes = load_nodes(args.config)
    if args.node and args.node not in nodes:
        parser.error(f"unknown node {args.node!r}; choose from {', '.join(nodes)}")
    selected = [nodes[args.node]] if args.node else list(nodes.values())
    if args.command == "list":
        payload = [{"id": node["id"], "display_name": node.get("display_name"), "os": node.get("os")} for node in selected]
    else:
        payload = [status_node(node) for node in selected]
    print(json.dumps(payload if len(payload) != 1 or not args.node else payload[0], indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
