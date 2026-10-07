"""Strict extraction of model tool plans from llama.cpp transcript output.

This adapter removes only transport framing (llama transcript markers and a
Markdown JSON fence). It does not repair malformed JSON, rename tools, or
rewrite arguments.
"""
import json
import re

class AdapterError(ValueError):
    pass

def parse_tool_plan(transcript):
    body = transcript.split("> EOF by user", 1)[0]
    found = []
    candidates = []
    for fenced in re.finditer(r"```(?:json)?\s*(.*?)```", body, flags=re.S | re.I):
        candidates.append(fenced.group(1).strip())
    candidates += [body[m.start():] for m in re.finditer(r"\{\s*\"calls\"\s*:", body)]
    for candidate in candidates:
        try:
            value, end = json.JSONDecoder().raw_decode(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict) and isinstance(value.get("calls"), list):
            calls = value["calls"]
        elif isinstance(value, list):
            calls = value
            value = {"calls": calls}
        elif isinstance(value, dict) and isinstance(value.get("tool"), str):
            calls = [value]
            value = {"calls": calls}
        elif isinstance(value, dict) and len(value) == 1 and isinstance(next(iter(value.values())), dict):
            tool, arguments = next(iter(value.items()))
            calls = [{"tool": tool, "arguments": arguments}]
            value = {"calls": calls}
        else:
            continue
        if not all(isinstance(c, dict) and isinstance(c.get("tool"), str) and isinstance(c.get("arguments", {}), dict) for c in calls):
            raise AdapterError("tool_plan_calls_not_canonical")
        found.append(value)
    if not found:
        raise AdapterError("no_valid_tool_plan_json")
    return found[-1]
