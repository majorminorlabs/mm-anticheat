from research_model.research_protocol.protocol import build_prompt, validate_protocol_output


def test_protocol_prompt_is_provider_neutral_and_json_oriented():
    prompt = build_prompt("Does X work?", "S1: evidence", "evidence_verification")
    assert "SEARCH" in prompt and "Do not invent" in prompt


def test_protocol_validation():
    valid = {"state":"planning","action":"SEARCH","query":"x","source_ids":[],"claims":[],"evidence":[],"gaps":[],"confidence":"unknown","next_action":"READ"}
    assert validate_protocol_output(valid) == []
    assert validate_protocol_output({"action":"BAD"})

