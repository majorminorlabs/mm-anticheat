from research_model.validation.validators import validate_output_against_example


def example():
    return {"source_ids": ["S1"], "context": "A sentence.", "task_type": "evidence_extraction"}


def output():
    return {"state":"evidence_review","action":"EXTRACT","query":None,"source_ids":["S1"],"claims":[],"evidence":[{"source_id":"S1","text":"A sentence."}],"gaps":[],"confidence":"high","next_action":"SYNTHESIZE"}


def test_evidence_must_be_in_context():
    assert validate_output_against_example(example(), output()) == []
    bad = dict(output()); bad["evidence"] = [{"source_id":"S1","text":"Not present"}]
    assert "evidence text is not present in supplied context" in validate_output_against_example(example(), bad)

