"""Small, dependency-free process/resource sampler for server integration runs."""

from __future__ import annotations

import os
import time
from typing import Any


def _meminfo() -> dict[str, int]:
    values: dict[str, int] = {}
    with open("/proc/meminfo", encoding="utf-8") as handle:
        for line in handle:
            key, _, rest = line.partition(":")
            if key in {"MemAvailable", "SwapTotal", "SwapFree"}:
                values[key] = int(rest.strip().split()[0]) * 1024
    values["SwapUsed"] = values.get("SwapTotal", 0) - values.get("SwapFree", 0)
    return values


def _rss(pid: int) -> int | None:
    try:
        with open(f"/proc/{pid}/status", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1]) * 1024
    except (FileNotFoundError, PermissionError):
        return None
    return None


def sample(pid: int | None = None, *, phase: str = "sample") -> dict[str, Any]:
    result: dict[str, Any] = {
        "timestamp_monotonic": time.monotonic(),
        "timestamp_epoch": time.time(),
        "phase": phase,
        "pid": pid,
        "self_pid": os.getpid(),
        "mem": _meminfo(),
    }
    if pid is not None:
        result["server_rss_bytes"] = _rss(pid)
    return result
