"""Fail closed on L11 split, source, sampler, and exposure boundaries."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from scripts.l4_sampler import BUCKETS, EXAMPLES_PER_STEP, SEED, WEIGHTS, sample_plan
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, write_json
from scripts.train_l3 import prepare
from scripts.train_l6 import L6
from scripts.train_l11 import L11

MIN_BUCKET_TARGETS = {'very_short': 5, 'short': 15, 'medium': 15, 'longer': 8}


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def qa() -> dict:
    from transformers import AutoTokenizer

    source_path = ROOT/'data/l5/train.jsonl'
    curated_path = ROOT/'data/l11/train.jsonl'
    original = {r['id']: r for r in read_jsonl(source_path)}
    selected = read_jsonl(curated_path)
    selection = json.loads((ROOT/'corpus/metadata/l11_selection.json').read_text())
    exposure = json.loads((ROOT/'corpus/metadata/l11_exposure.json').read_text())
    target_scores = json.loads((ROOT/'corpus/metadata/l11_target_scores.json').read_text())
    review_path = ROOT/'outputs/l11-candidates/manual_review.json'
    review = json.loads(review_path.read_text())
    scored = {r['id']: r for r in target_scores['rows']}
    manifest = {r['work_id']: r for r in json.loads((ROOT/'corpus/metadata/manifest.json').read_text())}
    eval_prompts = {r['prompt'] for r in json.loads((ROOT/'data/eval/prompts.json').read_text())}
    if (len(selected) != selection['selected_count'] or
        selection['manual_reviewed_selected_count'] != len(selected) or
        not 70 <= len(selected) <= 120):
        raise ValueError('Curated target count outside approved range')
    if sha(curated_path.read_bytes()) != selection['train_jsonl_sha256'] or \
       sha(source_path.read_bytes()) != selection['original_l5_train_sha256'] or \
       exposure['curated_l11']['train_jsonl_sha256'] != selection['train_jsonl_sha256'] or \
       sha(review_path.read_bytes()) != selection['manual_review_sha256'] or \
       sha((ROOT/'corpus/metadata/l11_target_scores.json').read_bytes()) != selection['target_scores_sha256']:
        raise ValueError('Curated source or exposure hash changed')
    if len({r['id'] for r in selected}) != len(selected) or \
       len({r['target_sha256'] for r in selected}) != len(selected):
        raise ValueError('Duplicate curated ID or target')
    for row in selected:
        old = original[row['id']]
        scored_row = scored[row['id']]
        work = manifest[row['work_id']]
        expected_prompt = review.get('prompt_overrides', {}).get(row['id'], old['prompt'])
        if (row['split'] != 'train' or work['split'] != 'train' or
            row['target'] != old['target'] or
            row['target_sha256'] != old['target_sha256'] or
            sha(row['target'].encode()) != row['target_sha256'] or
            row['prompt'] != expected_prompt or
            sha(row['prompt'].encode()) != selection['selected_prompt_hashes'][row['id']] or
            row['target_sha256'] != selection['selected_target_hashes'][row['id']] or
            row['prompt'] in eval_prompts or
            not scored_row['audit']['natural_source_end_boundary_proxy']):
            raise ValueError(f'Curated source, target, prompt, or boundary failed: {row["id"]}')
        if (row['length_bucket'] != old['length_bucket'] or
            row['length_control'] != old['length_control'] or
            row['length_mode'] != old['length_mode']):
            raise ValueError('Length convention changed')
    by_work = Counter(r['work_id'] for r in selected)
    for index, left in enumerate(selected):
        for right in selected[index + 1:]:
            if (left['work_id'] == right['work_id'] and
                max(left['source_line_start'], right['source_line_start']) <=
                min(left['source_line_end'], right['source_line_end'])):
                raise ValueError('Overlapping selected passages repeat source lines')
    anchor_works = {r['work_id'] for r in selected if manifest[r['work_id']]['style_anchor']}
    anchor_targets = sum(manifest[r['work_id']]['style_anchor'] for r in selected)
    buckets = Counter(r['length_bucket'] for r in selected)
    if len(by_work) < 50 or max(by_work.values()) > 3 or anchor_targets / len(selected) > .15:
        raise ValueError('Source-work or anchor concentration excessive')
    if any(buckets[b] < MIN_BUCKET_TARGETS[b] for b in BUCKETS):
        raise ValueError('Curated length-bucket coverage insufficient')
    plan_a, plan_b = sample_plan(selected), sample_plan(selected)
    if plan_a != plan_b or len(plan_a) < 50 * EXAMPLES_PER_STEP:
        raise ValueError('Curated sampler is not deterministic')
    plan_hash = sha(json.dumps(plan_a, separators=(',', ':')).encode())
    if plan_hash != exposure['curated_l11']['plan_indices_sha256']:
        raise ValueError('Curated sampler plan changed')
    e = exposure['curated_l11']
    if not .85 <= e['target_token_exposure_ratio_to_l6'] <= 1.15 or \
       e['max_draws_per_target'] > 10:
        raise ValueError('Token exposure mismatch or excessive target repetition; do not train')
    tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer.pad_token = tokenizer.eos_token
    sequence_max = 0
    for row in selected:
        prepared = prepare(tokenizer, row)
        sequence_max = max(sequence_max, len(prepared['input_ids']))
        if len(prepared['input_ids']) > 384 or \
           prepared['labels'][-1] != tokenizer.eos_token_id or \
           prepared['labels'][0] != -100 or \
           all(label == -100 for label in prepared['labels']):
            raise ValueError('Sequence length, terminal EOS, or prompt mask failed')
    fixed_core = {key: value for key, value in L6.items() if key != 'checkpoints'}
    current_core = {key: value for key, value in L11.items() if key != 'checkpoints'}
    if fixed_core != current_core or WEIGHTS != {'very_short': .5, 'short': .75, 'medium': 1.5, 'longer': 2.5}:
        raise ValueError('L6 core configuration or L4 weights changed')
    report = {
        'status': 'passed', 'base_revision': CONFIG['model_revision'],
        'train_count': len(selected), 'train_work_count': len(by_work),
        'style_anchor_work_count': len(anchor_works),
        'style_anchor_target_count': anchor_targets,
        'all_selected_targets_manually_reviewed': True,
        'bucket_counts': {b: buckets[b] for b in BUCKETS},
        'longest_prepared_sequence': sequence_max,
        'train_jsonl_sha256': sha(curated_path.read_bytes()),
        'selected_prompt_hashes_verified': True,
        'sampler_plan_sha256': plan_hash,
        'l6_core_config_unchanged': True,
        'l4_sampler_seed': SEED,
        'l6_target_tokens_at_50': exposure['baseline_l6']['target_tokens_seen_at_step']['50'],
        'l11_target_tokens_at_50': e['target_tokens_seen_at_step']['50'],
        'exposure_ratio': e['target_token_exposure_ratio_to_l6'],
        'max_target_draws': e['max_draws_per_target'],
        'train_only_and_targets_unchanged': True,
        'evaluation_prompt_exact_overlap': 0,
    }
    write_json(ROOT/'corpus/metadata/l11_qa.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.parse_args()
    print(json.dumps(qa(), indent=2))
