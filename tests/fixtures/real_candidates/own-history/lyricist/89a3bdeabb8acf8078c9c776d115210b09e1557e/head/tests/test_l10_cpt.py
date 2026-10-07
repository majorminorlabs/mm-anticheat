"""L10 raw-CPT data contracts, using synthetic writing only."""
from scripts.build_l10_cpt import checkpoint_steps, pack_documents, raw_writing


def test_raw_text_keeps_refrains_and_stanza_breaks():
    text, removed = raw_writing('[Verse 1]\nFirst line  \nAgain\n\n[Chorus]\nAgain\nAgain')
    assert text == 'First line  \nAgain\n\nAgain\nAgain'
    assert removed == 2


def test_packing_keeps_every_token_and_document_eos():
    docs = [
        {'work_id': 'a', 'input_ids': [10, 11, 99]},
        {'work_id': 'b', 'input_ids': [20, 21, 22, 99]},
        {'work_id': 'c', 'input_ids': [30, 99]},
    ]
    packed = pack_documents(docs, 4, cross_documents=True)
    assert [token for row in packed for token in row['input_ids']] == [10, 11, 99, 20, 21, 22, 99, 30, 99]
    assert all(2 <= len(row['input_ids']) <= 4 for row in packed)
    assert any(len(row['work_ids']) > 1 for row in packed)
    separate = pack_documents(docs, 4, cross_documents=False)
    assert all(len(row['work_ids']) == 1 for row in separate)


def test_schedule_uses_token_exposure_and_one_pass():
    chunks = [{'input_ids': list(range(512))} for _ in range(42)] + [{'input_ids': list(range(358))}]
    schedule = checkpoint_steps(chunks)
    assert [row['step'] for row in schedule] == [1, 3, 4, 6]
    assert [row['target_pass'] for row in schedule] == [.25, .5, .75, 1.0]
    assert schedule[-1]['effective_supervised_passes'] == 1.0
    assert schedule[0]['effective_supervised_passes'] < .25
