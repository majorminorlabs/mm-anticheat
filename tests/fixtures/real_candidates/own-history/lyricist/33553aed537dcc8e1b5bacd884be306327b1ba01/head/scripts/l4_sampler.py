"""Deterministic length-weighted, repetition-balanced L3 passage sampler."""
from __future__ import annotations

import json
import random
from collections import Counter

from scripts.modeling import ROOT
from scripts.pipeline import sha
from scripts.train_l3 import L3

BUCKETS = ('very_short', 'short', 'medium', 'longer')
WEIGHTS = {'very_short': 0.5, 'short': 0.75, 'medium': 1.5, 'longer': 2.5}
SEED = L3['seed']
EXAMPLES_PER_STEP = L3['batch_size'] * L3['gradient_accumulation_steps']
PLAN_STEPS = 75


def training_rows():
    return [json.loads(line) for line in (ROOT / 'data/l3/train.jsonl').read_text().splitlines()]


def expected_proportions(rows):
    counts = Counter(row['length_bucket'] for row in rows)
    mass = {bucket: counts[bucket] * WEIGHTS[bucket] for bucket in BUCKETS}
    total = sum(mass.values())
    return {bucket: mass[bucket] / total for bucket in BUCKETS}


def sample_plan(rows, steps=PLAN_STEPS, seed=SEED):
    """Choose weighted buckets, then balance repeats and works within each.

    The bucket draw is the only changed training distribution. Within a bucket,
    least-used passages and then least-used works break ties to keep coverage.
    The full 75-step plan makes a 50-to-75 continuation prefix-stable.
    """
    by_bucket = {bucket: [i for i, row in enumerate(rows) if row['length_bucket'] == bucket]
                 for bucket in BUCKETS}
    if any(not indices for indices in by_bucket.values()):
        raise ValueError('Every L3 length bucket needs examples')
    probabilities = expected_proportions(rows)
    rng = random.Random(seed)
    example_count, work_count = Counter(), Counter()
    plan = []
    for _ in range(steps * EXAMPLES_PER_STEP):
        bucket = rng.choices(BUCKETS, weights=[probabilities[b] for b in BUCKETS], k=1)[0]
        available = by_bucket[bucket]
        least_example = min(example_count[i] for i in available)
        choices = [i for i in available if example_count[i] == least_example]
        least_work = min(work_count[rows[i]['work_id']] for i in choices)
        choices = [i for i in choices if work_count[rows[i]['work_id']] == least_work]
        index = rng.choice(choices)
        plan.append(index)
        example_count[index] += 1
        work_count[rows[index]['work_id']] += 1
    return plan


def summarize(rows, indices):
    source_counts = Counter(row['length_bucket'] for row in rows)
    sampled = [rows[i] for i in indices]
    bucket_counts = Counter(row['length_bucket'] for row in sampled)
    example_counts = Counter(row['id'] for row in sampled)
    work_counts = Counter(row['work_id'] for row in sampled)
    class_counts = Counter(row['prompt_class'] for row in sampled)
    total = len(indices)
    return {
        'source_l3_examples': len(rows),
        'source_l3_sha256': sha((ROOT / 'data/l3/train.jsonl').read_bytes()),
        'source_bucket_counts': {b: source_counts[b] for b in BUCKETS},
        'weights': WEIGHTS,
        'expected_bucket_proportions': {b: round(v, 4) for b, v in expected_proportions(rows).items()},
        'sampled_examples': total,
        'sampled_bucket_counts': {b: bucket_counts[b] for b in BUCKETS},
        'sampled_bucket_proportions': {b: round(bucket_counts[b] / total, 4) for b in BUCKETS},
        'unique_examples_observed': len(example_counts),
        'unique_source_works_observed': len(work_counts),
        'max_example_repetitions': max(example_counts.values()),
        'max_source_work_repetitions': max(work_counts.values()),
        'effective_prompt_class_counts': dict(class_counts),
        'effective_prompt_class_proportions': {k: round(v / total, 4) for k, v in class_counts.items()},
        'sampler_seed': SEED,
        'plan_indices_sha256': sha(json.dumps(indices, separators=(',', ':')).encode()),
    }
