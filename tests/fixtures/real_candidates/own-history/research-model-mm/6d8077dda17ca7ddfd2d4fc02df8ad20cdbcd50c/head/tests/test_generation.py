from research_model.task_generation.generate import generate_scifact_examples


def test_scifact_generation_is_grounded():
    dataset = {"corpus":[{"doc_id":1,"title":"A study","abstract":["Evidence sentence."]}],"train":[{"id":1,"claim":"The study supports the claim.","evidence_doc_id":1,"evidence_label":"SUPPORT","evidence_sentences":[0]}],"dev":[],"test":[]}
    rows = generate_scifact_examples(dataset, max_claims=1)
    assert len(rows) == 4
    assert all("A study" in row["context"] for row in rows)
    assert all(row["expected_output"]["action"] in {"EXTRACT", "SEARCH", "QUESTION", "SYNTHESIZE"} for row in rows)

