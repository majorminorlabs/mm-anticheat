import json
from collections import Counter

import pytest

from scripts.modeling import ROOT, format_prompt
from scripts.train_l3 import L3, prepare


class TinyTokenizer:
    eos_token_id = 0

    def __call__(self, text, add_special_tokens=False):
        return {'input_ids': [ord(char) + 1 for char in text]}


def test_l3_completion_mask_and_single_terminal_eos():
    tokenizer = TinyTokenizer()
    row = {'id': 'example', 'prompt': 'write about a locked room',
           'length_control': None, 'target': 'A door is closed\nThe light gets in'}
    prepared = prepare(tokenizer, row)
    prefix = format_prompt(row['prompt'])
    prefix_size = len(tokenizer(prefix)['input_ids'])
    assert 'length:' not in prefix
    assert prepared['labels'][:prefix_size] == [-100] * prefix_size
    assert prepared['labels'][prefix_size:-1] == tokenizer(row['target'])['input_ids']
    assert prepared['labels'][-1] == tokenizer.eos_token_id
    assert prepared['input_ids'].count(tokenizer.eos_token_id) == 1
    assert prepared['input_ids'][-1] == tokenizer.eos_token_id
    assert prepared['attention_mask'] == [1] * len(prepared['input_ids'])
    row['target'] = 'x' * L3['max_sequence_length']
    with pytest.raises(ValueError, match='would truncate'):
        prepare(tokenizer, row)


def test_l3_review_and_work_split():
    metadata = json.loads((ROOT / 'corpus/metadata/l3_review_summary.json').read_text())
    assert metadata['checked'] >= 60
    assert metadata['good'] + metadata['revised'] + metadata['rejected'] == metadata['checked']
    manifest = {r['work_id']: r for r in json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())}
    splits = {split: [json.loads(line) for line in (ROOT / 'data/l3' / f'{split}.jsonl').read_text().splitlines()]
              for split in ('train', 'validation', 'heldout')}
    assert {r['work_id'] for r in splits['train']} == {wid for wid, m in manifest.items() if m['split'] == 'train'}
    assert not ({r['work_id'] for r in splits['train']} & {r['work_id'] for r in splits['validation'] + splits['heldout']})
    counts = Counter(r['length_bucket'] for r in splits['train'])
    assert counts['longer'] >= 20 and counts['medium'] >= 65
    assert any(r['length_mode'] == 'none' for r in splits['train'])
