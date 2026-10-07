"""Freeze the L12 capacity intervention before expensive GPU work."""
import json

from scripts.l4_sampler import EXAMPLES_PER_STEP, sample_plan
from scripts.modeling import CONFIG, ROOT
from scripts.train_l12 import CONFIG as L12_MODEL, L6 as L12_RECIPE
from scripts.train_l6 import L6 as L6_RECIPE
from scripts.train_l5 import rows
from scripts.blind_quality_l12 import PAIRS, RUNS
from scripts.pipeline import sha


def test_only_base_and_checkpoint_schedule_change():
    assert L12_MODEL['model_id'] == 'Qwen/Qwen3-4B-Base'
    assert L12_MODEL['model_revision'] != CONFIG['model_revision']
    assert L12_MODEL['lora_target_modules'] == ['q_proj', 'v_proj']
    assert {k: v for k, v in L12_RECIPE.items() if k != 'checkpoints'} == \
           {k: v for k, v in L6_RECIPE.items() if k != 'checkpoints'}
    assert L12_RECIPE['checkpoints'] == [15, 25, 35, 40, 50]


def test_first_50_steps_follow_actual_l6_trace():
    train = rows('train')
    full_plan = sample_plan(train)
    frozen = json.loads((ROOT / 'corpus/metadata/l12_preflight.json').read_text())
    assert sha(json.dumps(full_plan, separators=(',', ':')).encode()) == frozen['sample_plan_sha256']
    plan = full_plan[:50 * EXAMPLES_PER_STEP]
    trace_path = ROOT / 'outputs/l6/sample_trace.jsonl'
    if not trace_path.exists():
        return
    trace = [json.loads(line) for line in
             trace_path.read_text().splitlines()[:50]]
    assert len(trace) == 50
    for step, record in enumerate(trace):
        actual = [train[i]['id'] for i in plan[step * EXAMPLES_PER_STEP:(step + 1) * EXAMPLES_PER_STEP]]
        assert actual == record['sampled_ids']


def test_blind_gate_has_frozen_five_way_scope():
    assert tuple(RUNS) == ('B0', 'L1-48', 'L6-40', 'L12-BASE', 'L12')
    assert set(PAIRS) == {('L1-48', 'L12'), ('L6-40', 'L12'),
                          ('B0', 'L12'), ('L12-BASE', 'L12'), ('B0', 'L12-BASE')}
