"""Preflight and actual-trace audit for L9's replacement auxiliary dataset."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from scripts.build_l9 import shared_phrase_words
from scripts.l4_sampler import EXAMPLES_PER_STEP, SEED, WEIGHTS
from scripts.l9_sampler import CONSTRAINT_FRACTION, CONSTRAINT_SEED, exposure, mixed_plan, plan_hash
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, write_json
from scripts.train_l5 import rows
from scripts.train_l6 import L6
from scripts.train_l9 import L9, constraint_rows


def class_draws(plan, constraints):
    return dict(Counter(constraints[index]['constraint_type']
                        for component, index in plan if component == 'constraint'))


def audit(trace_path=None):
    original, variants = rows('train'), constraint_rows()
    proposals = json.loads((ROOT / 'corpus/metadata/l9_constraint_proposals.json').read_text())
    review = json.loads((ROOT / 'corpus/metadata/l9_constraint_review.json').read_text())['decisions']
    final = json.loads((ROOT / 'corpus/metadata/l9_constraint_final.json').read_text())
    val_works = {row['work_id'] for row in rows('validation')}
    held_works = {row['work_id'] for row in rows('heldout')}
    fixed_path = ROOT / 'data/eval/prompts.json'
    novel_path = ROOT / 'corpus/metadata/l8_novel_prompts.json'
    eval_prompts = {r['prompt'] for r in json.loads(fixed_path.read_text()) + json.loads(novel_path.read_text())}
    errors = []
    if {key: value for key, value in L9.items() if key != 'checkpoints'} != {key: value for key, value in L6.items() if key != 'checkpoints'}:
        errors.append('recipe_changed')
    if L9['checkpoints'] != [25, 35, 40]:
        errors.append('checkpoint_cadence_changed')
    if len(proposals) != len(review) or {p['id'] for p in proposals} != {d['id'] for d in review}:
        errors.append('review_incomplete')
    if len(final) != len(variants):
        errors.append('final_dataset_count_mismatch')
    if {r['work_id'] for r in variants} & (val_works | held_works):
        errors.append('nontrain_work_used')
    if len({r['source_target_id'] for r in final}) != len(final):
        errors.append('target_reused')
    if any(r['prompt'] in eval_prompts for r in variants):
        errors.append('eval_prompt_used_for_training')
    max_eval_prompt_overlap = max(shared_phrase_words(r['prompt'], prompt)
                                  for r in variants for prompt in eval_prompts)
    if max_eval_prompt_overlap >= 5:
        errors.append('near_copy_of_eval_prompt')
    provenance_fields = ('source_index', 'source_work', 'source_target_id', 'source_target_sha256',
                         'source_path', 'source_line_numbers', 'original_prompt', 'constraint_prompt',
                         'constraint_type', 'intended_constraint', 'evidence_summary',
                         'possible_ambiguity', 'automatic_validation', 'manual_review_status')
    provenance_complete = 0
    lexical_checked = relation_checked = exclusion_checked = 0
    for meta, variant in zip(final, variants):
        if all(meta.get(field) is not None for field in provenance_fields):
            provenance_complete += 1
        source = original[meta['source_index']]
        if (variant['target'] != source['target'] or variant['target_sha256'] != source['target_sha256']
                or variant['work_id'] != source['work_id'] or variant['length_control'] != source['length_control']):
            errors.append(f'target_or_base_fields_changed:{meta["id"]}')
        if (variant['prompt'] != meta['constraint_prompt'] or variant['id'] != meta['id']
                or meta['source_work'] != source['work_id'] or meta['source_target_id'] != source['id']):
            errors.append(f'provenance_mismatch:{meta["id"]}')
        check = meta['automatic_validation']
        if not check['lexical_forms_absent'] or not check['prompt_differs_from_fixed_and_novel_eval']:
            errors.append(f'lexical_or_prompt_validation_failed:{meta["id"]}')
        if check['prompt_target_longest_shared_phrase_words'] > 4:
            errors.append(f'distinctive_source_phrase_in_prompt:{meta["id"]}')
        if meta['constraint_type'] in ('lexical_prohibition', 'indirect_exclusion', 'mixed'):
            lexical_checked += 1
            if 'forbidden_forms' not in meta['intended_constraint']:
                errors.append(f'missing_exclusion_forms:{meta["id"]}')
        if meta['constraint_type'] in ('spatial_relation', 'mixed'):
            relation_checked += 1
            if (not check['relation_markers_present'] or
                    not all(meta['intended_constraint']['relation'].get(k)
                            for k in ('subject', 'predicate', 'object'))):
                errors.append(f'relation_validation_failed:{meta["id"]}')
        if meta['constraint_type'] in ('indirect_exclusion', 'mixed'):
            exclusion_checked += 1
            if not meta['intended_constraint'].get('excluded_concept'):
                errors.append(f'missing_excluded_concept:{meta["id"]}')
        if meta['manual_review_status'] not in ('GOOD', 'REVISE') or meta['another_reasonable_reader_could_find_violation']:
            errors.append(f'unapproved_or_ambiguous:{meta["id"]}')
    if provenance_complete != len(final):
        errors.append('provenance_incomplete')
    work_counts = Counter(r['source_work'] for r in final)
    target_counts = Counter(r['source_target_id'] for r in final)
    if max(work_counts.values()) > 3 or max(target_counts.values()) > 1:
        errors.append('concentration_limit_exceeded')
    plan = mixed_plan(original, variants)
    if any(component not in ('original', 'constraint') for component, _ in plan):
        errors.append('unexpected_sampler_component')
    if any(sum(component == 'constraint' for component, _ in plan[i:i+EXAMPLES_PER_STEP]) != 2
           for i in range(0, len(plan), EXAMPLES_PER_STEP)):
        errors.append('mix_not_25_percent_per_update')
    actual = None
    if trace_path is not None:
        trace_path = Path(trace_path)
        trace = [json.loads(line) for line in trace_path.read_text().splitlines()]
        flattened = [(component, identity) for step in trace
                     for component, identity in zip(step['sampled_components'], step['sampled_ids'])]
        expected = [(component, (original if component == 'original' else variants)[index]['id'])
                    for component, index in plan[:len(flattened)]]
        if (flattened != expected or any(len(step['sampled_ids']) != EXAMPLES_PER_STEP for step in trace)
                or len(trace) > 50):
            errors.append('actual_trace_diverged_or_exceeded_limit')
        ids = {r['id']: r for r in variants}
        actual_counts = Counter(component for component, _ in flattened)
        actual_exposure = {'sampled_examples': len(flattened),
                           'constraint_examples': actual_counts['constraint'],
                           'original_examples': actual_counts['original'],
                           'constraint_fraction': actual_counts['constraint'] / len(flattened) if flattened else 0}
        actual = {'steps': len(trace), 'trace_sha256': sha(trace_path.read_bytes()),
                  'exposure': actual_exposure,
                  'class_draws': dict(Counter(ids[identity]['constraint_type']
                                              for component, identity in flattened if component == 'constraint')),
                  'unique_constraints': len({identity for component, identity in flattened if component == 'constraint'})}
    return {
        'proposed': len(proposals), 'final': len(final),
        'review_counts': dict(Counter(r['status'] for r in review)),
        'class_counts': dict(Counter(r['constraint_type'] for r in final)),
        'source_work_coverage': {'used': len(work_counts), 'train_total': len({r['work_id'] for r in original})},
        'target_reuse_counts': dict(Counter(target_counts.values())),
        'max_variants_per_target': max(target_counts.values()),
        'max_variants_per_work': max(work_counts.values()),
        'origin_prompt_class': dict(Counter(r['origin_prompt_class'] for r in final)),
        'target_length_buckets': dict(Counter(r['target_length_bucket'] for r in final)),
        'lexical_validation': {'approved_checked': lexical_checked,
                               'approved_failures': sum(not r['automatic_validation']['lexical_forms_absent'] for r in final),
                               'proposed_failed': sum(not r['automatic_validation']['lexical_forms_absent'] for r in proposals)},
        'relational_validation': {'checked': relation_checked, 'failures': sum('relation_validation_failed' in e for e in errors),
                                  'semantic_review_required': relation_checked},
        'exclusion_validation': {'checked': exclusion_checked, 'failures': sum('missing_excluded_concept' in e for e in errors)},
        'review_by_class': {kind: dict(Counter(d['status'] for p in proposals for d in review
                                              if p['id'] == d['id'] and p['constraint_type'] == kind))
                            for kind in sorted({p['constraint_type'] for p in proposals})},
        'provenance_complete': provenance_complete,
        'max_prompt_target_shared_phrase_words': max(r['automatic_validation']['prompt_target_longest_shared_phrase_words'] for r in final),
        'max_prompt_eval_shared_phrase_words': max_eval_prompt_overlap,
        'base_train_sha256': sha((ROOT / 'data/l5/train.jsonl').read_bytes()),
        'constraint_sha256': sha((ROOT / 'data/l9/constraints.jsonl').read_bytes()),
        'fixed_prompts_sha256': sha(fixed_path.read_bytes()),
        'novel_prompts_sha256': sha(novel_path.read_bytes()),
        'l4_weights': WEIGHTS, 'seed': SEED, 'constraint_seed': CONSTRAINT_SEED,
        'constraint_fraction_target': CONSTRAINT_FRACTION, 'full_plan_sha256': plan_hash(plan),
        'training_config': {'base_id': CONFIG['model_id'], 'base_revision': CONFIG['model_revision'],
                            'l6_recipe': L9, 'terminal_eos_loss_weight': 0.25,
                            'planned_stop_at': 40},
        'scheduled_40': {'exposure': exposure(plan[:40 * EXAMPLES_PER_STEP]),
                         'class_draws': class_draws(plan[:40 * EXAMPLES_PER_STEP], variants)},
        'scheduled_50_optional': {'exposure': exposure(plan[:50 * EXAMPLES_PER_STEP]),
                                  'class_draws': class_draws(plan[:50 * EXAMPLES_PER_STEP], variants)},
        'actual': actual, 'errors': errors,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--trace', type=Path)
    p.add_argument('--out', type=Path, default=ROOT / 'corpus/metadata/l9_qa.json')
    args = p.parse_args()
    report = audit(args.trace)
    write_json(args.out, report)
    print(json.dumps(report, indent=2))
    if report['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
