"""Preflight and actual-trace checks for L8's sole training intervention."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from scripts.l4_sampler import EXAMPLES_PER_STEP, SEED, WEIGHTS
from scripts.l8_sampler import CONSTRAINT_FRACTION, exposure, mixed_plan, plan_hash
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json
from scripts.train_l5 import rows
from scripts.train_l6 import L6
from scripts.train_l8 import L8, constraint_rows


def audit(trace_path=None):
    original, constraint = rows('train'), constraint_rows()
    final = json.loads((ROOT / 'corpus/metadata/l8_constraint_final.json').read_text())
    review = json.loads((ROOT / 'corpus/metadata/l8_constraint_review.json').read_text())
    proposals = json.loads((ROOT / 'corpus/metadata/l8_constraint_proposals.json').read_text())
    val_works = {r['work_id'] for r in rows('validation')}
    held_works = {r['work_id'] for r in rows('heldout')}
    errors = []
    if {k: v for k, v in L8.items() if k != 'checkpoints'} != {k: v for k, v in L6.items() if k != 'checkpoints'}:
        errors.append('recipe_changed')
    if len(review['decisions']) != len(proposals):
        errors.append('review_incomplete')
    if len(final) != len(constraint):
        errors.append('final_metadata_mismatch')
    if {r['work_id'] for r in constraint} & (val_works | held_works):
        errors.append('split_leak')
    for meta, row in zip(final, constraint):
        source = original[meta['source_index']]
        if row['id'] != meta['id'] or row['target'] != source['target'] or row['target_sha256'] != source['target_sha256']:
            errors.append(f"target_changed:{meta['id']}")
        if row['prompt'] != meta['constraint_prompt']:
            errors.append(f"prompt_metadata_mismatch:{meta['id']}")
        if not meta['automatic_validation']['passed'] or meta['manual_review_status'] not in ('GOOD', 'REVISE'):
            errors.append(f"unapproved:{meta['id']}")
    plan = mixed_plan(original, constraint)
    actual = None
    if trace_path:
        trace = [json.loads(line) for line in Path(trace_path).read_text().splitlines()]
        flattened = [item for step in trace for item in zip(step['sampled_components'], step['sampled_ids'])]
        expected = [(component, (original if component == 'original' else constraint)[index]['id'])
                    for component, index in plan[:len(flattened)]]
        if flattened != expected or any(len(t['sampled_ids']) != EXAMPLES_PER_STEP for t in trace):
            errors.append('trace_diverged')
        by_component = {'original': {r['id']: r for r in original},
                        'constraint': {r['id']: r for r in constraint}}
        bucket_counts = Counter(by_component[component][identity]['length_bucket']
                                for component, identity in flattened)
        component_buckets = {component: dict(Counter(by_component[component][identity]['length_bucket']
                                                   for observed, identity in flattened if observed == component))
                             for component in ('original', 'constraint')}
        constraint_types = dict(Counter(by_component[component][identity]['constraint_type']
                                        for component, identity in flattened if component == 'constraint'))
        actual = {'steps': len(trace), 'trace_sha256': sha(Path(trace_path).read_bytes()),
                  'exposure': exposure(plan[:len(flattened)]),
                  'unique_constraints': len({identity for component, identity in flattened if component == 'constraint'}),
                  'bucket_counts': dict(bucket_counts), 'bucket_counts_by_component': component_buckets,
                  'constraint_type_draws': constraint_types}
    return {'original_sha256': sha((ROOT / 'data/l5/train.jsonl').read_bytes()),
            'constraint_sha256': sha((ROOT / 'data/l8/constraints.jsonl').read_bytes()),
            'model_and_recipe_unchanged_except_checkpoint_cadence': 'recipe_changed' not in errors,
            'l4_weights': WEIGHTS, 'seed': SEED, 'target_constraint_fraction': CONSTRAINT_FRACTION,
            'full_plan_sha256': plan_hash(plan), 'scheduled_50': exposure(plan[:50 * EXAMPLES_PER_STEP]),
            'constraint_type_counts': dict(Counter(r['constraint_type'] for r in constraint)),
            'proposed': len(proposals), 'final': len(final),
            'review_counts': dict(Counter(d['status'] for d in review['decisions'])),
            'actual': actual, 'errors': errors}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--trace', type=Path)
    p.add_argument('--out', type=Path, default=ROOT / 'corpus/metadata/l8_qa.json')
    args = p.parse_args()
    result = audit(args.trace)
    write_json(args.out, result)
    print(json.dumps(result, indent=2))
    if result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
