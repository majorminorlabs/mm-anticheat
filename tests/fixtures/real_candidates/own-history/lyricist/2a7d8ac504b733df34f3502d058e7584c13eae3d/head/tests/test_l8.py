import json

from scripts.l4_sampler import EXAMPLES_PER_STEP
from scripts.l8_sampler import exposure, mixed_plan, plan_hash
from scripts.modeling import ROOT
from scripts.train_l5 import rows
from scripts.train_l8 import constraint_rows


def test_constraints_use_unchanged_train_targets_and_no_eval_works():
    original, variants = rows('train'), constraint_rows()
    metadata = json.loads((ROOT / 'corpus/metadata/l8_constraint_final.json').read_text())
    outside = {r['work_id'] for split in ('validation', 'heldout') for r in rows(split)}
    assert len(variants) == len(metadata) == 63
    assert not ({r['work_id'] for r in variants} & outside)
    for variant, meta in zip(variants, metadata):
        source = original[meta['source_index']]
        assert variant['target'] == source['target']
        assert variant['target_sha256'] == source['target_sha256']
        assert variant['length_control'] == source['length_control']
        assert variant['prompt'] == meta['constraint_prompt']
        assert meta['automatic_validation']['passed']
        assert meta['manual_review_status'] in ('GOOD', 'REVISE')


def test_mix_is_deterministic_and_exactly_one_quarter():
    original, variants = rows('train'), constraint_rows()
    first = mixed_plan(original, variants)
    second = mixed_plan(original, variants)
    assert plan_hash(first) == plan_hash(second)
    assert len(first) == 75 * EXAMPLES_PER_STEP
    assert exposure(first[:50 * EXAMPLES_PER_STEP]) == {
        'sampled_examples': 400, 'constraint_examples': 100,
        'original_examples': 300, 'constraint_fraction': 0.25,
    }
    for start in range(0, len(first), EXAMPLES_PER_STEP):
        assert sum(component == 'constraint' for component, _ in first[start:start + EXAMPLES_PER_STEP]) == 2


def test_novel_prompts_are_target_free_and_not_training_prompts():
    novel = json.loads((ROOT / 'corpus/metadata/l8_novel_prompts.json').read_text())
    train_prompts = {r['prompt'] for r in constraint_rows()}
    assert len(novel) == len({p['id'] for p in novel}) == 20
    assert all('target' not in item and item['prompt'] not in train_prompts for item in novel)
    assert {t: sum(p['type'] == t for p in novel) for t in
            ('lexical_prohibition', 'spatial_relation', 'indirect_exclusion', 'mixed')} == {
                'lexical_prohibition': 5, 'spatial_relation': 5,
                'indirect_exclusion': 5, 'mixed': 5,
            }
