"""Prefix-stable L9 mix: six L4-weighted originals and two constraints/update."""
from __future__ import annotations

import json
import random

from scripts.l4_sampler import EXAMPLES_PER_STEP, PLAN_STEPS, SEED, WEIGHTS, sample_plan
from scripts.pipeline import sha

CONSTRAINT_FRACTION = 0.25
CONSTRAINT_SEED = SEED + 8


def mixed_plan(originals, constraints, steps=PLAN_STEPS):
    if EXAMPLES_PER_STEP != 8:
        raise ValueError('L9 mix requires the unchanged effective batch of 8')
    original_plan = sample_plan(originals, steps=steps, seed=SEED)
    constraint_plan = sample_plan(constraints, steps=steps, seed=CONSTRAINT_SEED)
    placement = random.Random(SEED + 80)
    plan = []
    for step in range(steps):
        constraint_positions = set(placement.sample(range(8), 2))
        original_used = constraint_used = 0
        for position in range(8):
            if position in constraint_positions:
                plan.append(('constraint', constraint_plan[step * 2 + constraint_used]))
                constraint_used += 1
            else:
                plan.append(('original', original_plan[step * 6 + original_used]))
                original_used += 1
    return plan


def plan_hash(plan):
    return sha(json.dumps(plan, separators=(',', ':')).encode())


def exposure(plan):
    total = len(plan)
    count = sum(component == 'constraint' for component, _ in plan)
    return {'sampled_examples': total, 'constraint_examples': count,
            'original_examples': total - count, 'constraint_fraction': count / total}
