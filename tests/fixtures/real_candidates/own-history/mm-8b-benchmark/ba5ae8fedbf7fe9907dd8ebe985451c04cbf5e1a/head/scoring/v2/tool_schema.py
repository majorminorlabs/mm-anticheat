"""Q05 tool contracts for future V2 collection; other tasks retain V1 schema."""


def tool_defs_v2(fixture):
    descriptions = {
        "get_workers": "Return current worker loads and GPU capability. Refresh after get_queue before moving jobs.",
        "get_queue": "Inspect one worker queue. First inspection changes worker loads; inspect workers again afterward.",
        "pause_queue": "Pause source queue before moving jobs.",
        "resume_queue": "Resume source queue after safe movement.",
        "move_jobs": "Move job IDs from node-a to a named destination. Requires pause, fresh worker loads, load below 90, and compatible GPU affinity.",
        "get_job": "Inspect one job by ID.",
    }
    parameters = {
        "get_workers": {"type": "object", "properties": {}, "additionalProperties": False},
        "get_queue": {"type": "object", "properties": {"worker": {"type": "string", "enum": ["node-a", "node-b", "node-c"]}}, "additionalProperties": False},
        "pause_queue": {"type": "object", "properties": {}, "additionalProperties": False},
        "resume_queue": {"type": "object", "properties": {}, "additionalProperties": False},
        "move_jobs": {"type": "object", "properties": {"ids": {"type": "array", "items": {"type": "string"}, "minItems": 1}, "destination": {"type": "string", "enum": ["node-b", "node-c"]}}, "required": ["ids", "destination"], "additionalProperties": False},
        "get_job": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"], "additionalProperties": False},
    }
    return [{"type": "function", "function": {
        "name": name,
        "description": descriptions.get(name, f"Deterministic simulator tool {name}. Use only when needed for the stated objective."),
        "parameters": parameters.get(name, {"type": "object", "properties": {}, "additionalProperties": True}),
    }} for name in fixture["available_tools"]]
