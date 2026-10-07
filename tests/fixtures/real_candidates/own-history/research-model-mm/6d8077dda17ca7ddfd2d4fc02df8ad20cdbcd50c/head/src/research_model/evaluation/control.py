"""Frozen general-capability control prompts and lightweight scoring."""

from __future__ import annotations

import re
from typing import Any


CONTROL_CASES: list[dict[str, Any]] = [
    {"control_id": "control-001", "task_type": "instruction_following", "question": "Reply with exactly the single word: BLUE", "context": "", "reference_keywords": ["blue"], "forbidden_keywords": ["red", "green"]},
    {"control_id": "control-002", "task_type": "basic_reasoning", "question": "What is 17 + 25? Give the integer only.", "context": "", "reference_keywords": ["42"]},
    {"control_id": "control-003", "task_type": "basic_reasoning", "question": "A box has 3 rows of 4 coins. How many coins are there?", "context": "", "reference_keywords": ["12"]},
    {"control_id": "control-004", "task_type": "summarization", "question": "Summarize the passage in one sentence.", "context": "A small team measured latency twice. The first measurement used a warm cache; the second used a cold cache. The two measurements answer different operational questions.", "reference_keywords": ["warm", "cold", "latency"]},
    {"control_id": "control-005", "task_type": "summarization", "question": "Summarize the passage without adding facts.", "context": "The report describes one prototype tested in a lab. It does not report field performance or a comparison with another prototype.", "reference_keywords": ["prototype", "lab", "field"]},
    {"control_id": "control-006", "task_type": "technical_explanation", "question": "Explain in plain language why a cache can reduce repeated computation.", "context": "", "reference_keywords": ["store", "reuse"]},
    {"control_id": "control-007", "task_type": "technical_explanation", "question": "Explain the difference between a median and a mean in two sentences.", "context": "", "reference_keywords": ["middle", "average"]},
    {"control_id": "control-008", "task_type": "instruction_following", "question": "List exactly three colors as a numbered list.", "context": "", "reference_keywords": ["1.", "2.", "3."]},
    {"control_id": "control-009", "task_type": "basic_reasoning", "question": "If all A are B and no B are C, can any A be C? Answer yes or no and give a short reason.", "context": "", "reference_keywords": ["no"]},
    {"control_id": "control-010", "task_type": "summarization", "question": "Give the two distinct conditions described in the passage.", "context": "The experiment ran on Tuesday with a public dataset and on Wednesday with a private dataset. Results from the two conditions should not be pooled without checking comparability.", "reference_keywords": ["public", "private"]},
    {"control_id": "control-011", "task_type": "technical_explanation", "question": "What does reproducible software execution require besides source code?", "context": "", "reference_keywords": ["version", "environment"]},
    {"control_id": "control-012", "task_type": "instruction_following", "question": "Answer in lowercase: What is the opposite of hot?", "context": "", "reference_keywords": ["cold"]},
]


def score_control_example(example: dict[str, Any], output: Any) -> dict[str, Any]:
    text = str(output) if output is not None else ""
    lowered = text.lower()
    keywords = [str(item).lower() for item in example.get("reference_keywords", [])]
    present = sum(1 for keyword in keywords if keyword in lowered)
    forbidden = any(str(item).lower() in lowered for item in example.get("forbidden_keywords", []))
    return {"control_id": example["control_id"], "task_type": example["task_type"], "keyword_recall": present / len(keywords) if keywords else 0.0, "forbidden_violation": int(forbidden), "nonempty": int(bool(text.strip())), "raw_output": text}
