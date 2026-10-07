"""Verify L10 source isolation, packing, and frozen L6 behavioral inputs."""
from __future__ import annotations

import json
import random
from pathlib import Path

from scripts.build_l10_cpt import SPLITS, raw_writing
from scripts.l4_sampler import sample_plan
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import parse, sha, write_json
from scripts.train_l5 import rows


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def check(root: Path = ROOT):
    from transformers import AutoTokenizer
    token = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    metadata_path = root / 'corpus/metadata/l10_cpt_dataset.json'
    metadata = json.loads(metadata_path.read_text())
    manifest = json.loads((root / 'corpus/metadata/manifest.json').read_text())
    result = {'base_revision': CONFIG['model_revision'], 'cpt_metadata_sha256': sha(metadata_path.read_bytes()),
              'source_split_counts': {}, 'packed_hashes': {}, 'behavioral_data_hashes': {}}
    all_owners = set()
    for split in SPLITS:
        source = [r for r in manifest if r['split'] == split]
        docs_path = root / f'data/l10/raw-{split}.jsonl'
        packed_path = root / f'data/l10/packed-{split}.jsonl'
        docs, packed = read_jsonl(docs_path), read_jsonl(packed_path)
        expected_order = sorted(r['work_id'] for r in source)
        if split == 'train':
            random.Random(CONFIG['seed'] + 10).shuffle(expected_order)
        if [r['work_id'] for r in docs] != expected_order:
            raise ValueError(f'{split} source work assignment changed')
        if {r['work_id'] for r in docs} & all_owners:
            raise ValueError('A work appears in multiple CPT splits')
        all_owners.update(r['work_id'] for r in docs)
        if sha(docs_path.read_bytes()) != metadata['splits'][split]['raw_docs_sha256'] or \
           sha(packed_path.read_bytes()) != metadata['splits'][split]['packed_sha256']:
            raise ValueError(f'{split} generated file hash changed')
        expected = []
        by_source_id = {r['work_id']: r for r in source}
        for doc in docs:
            row = by_source_id[doc['work_id']]
            raw, _ = raw_writing(parse(root / row['source_path'])['body'])
            if doc['text'] != raw or doc['source_sha256'] != row['source_sha256']:
                raise ValueError(f'{split} raw source mismatch')
            expected.extend(token(raw, add_special_tokens=False)['input_ids'] + [token.eos_token_id])
        actual_ids = [item for chunk in packed for item in chunk['input_ids']]
        if actual_ids != expected:
            raise ValueError(f'{split} packing does not reconstruct original document stream')
        if sum(chunk['input_ids'].count(token.eos_token_id) for chunk in packed) != len(source):
            raise ValueError(f'{split} has missing or extra EOS boundaries')
        owners = {w for chunk in packed for w in chunk['work_ids']}
        if owners != {r['work_id'] for r in source}:
            raise ValueError(f'{split} packed work ownership changed')
        if split != 'train' and any(len(chunk['work_ids']) != 1 for chunk in packed):
            raise ValueError(f'{split} evaluation documents crossed boundaries')
        result['source_split_counts'][split] = len(source)
        result['packed_hashes'][split] = sha(packed_path.read_bytes())
    train_rows = rows('train')
    plan = sample_plan(train_rows)
    result['l6_sample_plan_sha256'] = sha(json.dumps(plan, separators=(',', ':')).encode())
    for split in SPLITS:
        path = root / ('data/l5' if split == 'train' else 'data/l3') / f'{split}.jsonl'
        result['behavioral_data_hashes'][split] = sha(path.read_bytes())
    if len(all_owners) != 106 or result['source_split_counts'] != {
            'train': 84, 'validation': 11, 'heldout': 11}:
        raise ValueError('Unexpected corpus split')
    result['status'] = 'passed'
    return result


if __name__ == '__main__':
    report = check()
    write_json(ROOT / 'corpus/metadata/l10_preflight.json', report)
    print(json.dumps(report, indent=2))
