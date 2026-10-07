import json
from collections import Counter

from scripts.l4_sampler import EXAMPLES_PER_STEP
from scripts.l9_sampler import exposure, mixed_plan, plan_hash
from scripts.modeling import ROOT
from scripts.pipeline import sha
from scripts.train_l5 import rows
from scripts.train_l6 import L6
from scripts.train_l9 import L9, constraint_rows


def test_l9_replaces_l8_with_reviewed_train_targets():
    original, variants = rows('train'), constraint_rows()
    final = json.loads((ROOT / 'corpus/metadata/l9_constraint_final.json').read_text())
    review = json.loads((ROOT / 'corpus/metadata/l9_constraint_review.json').read_text())['decisions']
    outside = {r['work_id'] for split in ('validation', 'heldout') for r in rows(split)}
    fixed = {r['prompt'] for r in json.loads((ROOT / 'data/eval/prompts.json').read_text())}
    novel = {r['prompt'] for r in json.loads((ROOT / 'corpus/metadata/l8_novel_prompts.json').read_text())}
    assert len(variants) == len(final) == 85
    assert Counter(r['constraint_type'] for r in variants) == {
        'lexical_prohibition': 18, 'spatial_relation': 32,
        'indirect_exclusion': 25, 'mixed': 10,
    }
    assert Counter(d['status'] for d in review) == {'GOOD': 82, 'REVISE': 3, 'REJECT': 16}
    assert len({r['source_target_id'] for r in final}) == len(final)
    assert max(Counter(r['source_work'] for r in final).values()) <= 3
    for row, meta in zip(variants, final):
        source = original[meta['source_index']]
        assert row['target'] == source['target']
        assert row['target_sha256'] == source['target_sha256']
        assert row['length_control'] == source['length_control']
        assert row['work_id'] not in outside
        assert row['prompt'] == meta['constraint_prompt']
        assert row['prompt'] not in fixed | novel
        assert row['prompt_origin'] == 'l9_train_constraint_variant'
        assert meta['automatic_validation']['lexical_forms_absent']
        assert meta['automatic_validation']['prompt_target_longest_shared_phrase_words'] <= 4


def test_l9_sampler_keeps_the_l6_recipe_and_exact_quarter_exposure():
    original, variants = rows('train'), constraint_rows()
    first, second = mixed_plan(original, variants), mixed_plan(original, variants)
    assert plan_hash(first) == plan_hash(second)
    assert {k: v for k, v in L9.items() if k != 'checkpoints'} == {k: v for k, v in L6.items() if k != 'checkpoints'}
    assert L9['checkpoints'] == [25, 35, 40]
    assert exposure(first[:40 * EXAMPLES_PER_STEP]) == {
        'sampled_examples': 320, 'constraint_examples': 80,
        'original_examples': 240, 'constraint_fraction': 0.25,
    }
    assert all(sum(component == 'constraint' for component, _ in first[start:start + EXAMPLES_PER_STEP]) == 2
               for start in range(0, 40 * EXAMPLES_PER_STEP, EXAMPLES_PER_STEP))


def test_every_approved_relation_and_exclusion_has_checkable_metadata():
    final = json.loads((ROOT / 'corpus/metadata/l9_constraint_final.json').read_text())
    for meta in final:
        intended, checked = meta['intended_constraint'], meta['automatic_validation']
        if meta['constraint_type'] in ('spatial_relation', 'mixed'):
            assert checked['relation_markers_present']
            assert all(intended['relation'][field] for field in ('subject', 'predicate', 'object'))
        if meta['constraint_type'] in ('lexical_prohibition', 'indirect_exclusion', 'mixed'):
            assert intended['forbidden_forms']
            assert checked['found_forbidden_forms'] == []


def test_locked_eval_inputs_and_baseline_generations_are_unchanged():
    lock = json.loads((ROOT / 'corpus/metadata/l9_baseline_lock.json').read_text())
    assert lock['fixed_prompt_sha256'] == sha((ROOT / 'data/eval/prompts.json').read_bytes())
    assert lock['novel_prompt_sha256'] == sha((ROOT / 'corpus/metadata/l8_novel_prompts.json').read_bytes())
    for directory, digest in lock['baseline_generation_sha256'].items():
        assert digest == sha((ROOT / 'outputs' / directory / 'generations.jsonl').read_bytes())
