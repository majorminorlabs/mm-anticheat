"""Verify L6 changed only terminal EOS loss weight and checkpoint cadence."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.l4_sampler import EXAMPLES_PER_STEP, SEED, WEIGHTS, sample_plan, summarize
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json
from scripts.train_l5 import L5, rows
from scripts.train_l6 import L6


def audit(trace_path=None):
    errors = []
    if {k: v for k, v in L6.items() if k != 'checkpoints'} != {k: v for k, v in L5.items() if k != 'checkpoints'}:
        errors.append('non-checkpoint-hyperparameter-change')
    train = rows('train')
    plan = sample_plan(train)
    l5_qa = json.loads((ROOT/'corpus/metadata/l5_qa.json').read_text())
    if sha((ROOT/'data/l5/train.jsonl').read_bytes()) != l5_qa['l5_train_sha256']:
        errors.append('l5-data-changed')
    l6_trace = None
    if trace_path:
        records = [json.loads(line) for line in Path(trace_path).read_text().splitlines()]
        lookup = {row['id']: i for i, row in enumerate(train)}
        actual = []
        for number, record in enumerate(records, start=1):
            if record['step'] != number or len(record['sampled_ids']) != EXAMPLES_PER_STEP:
                errors.append(f'trace-step:{number}')
            actual.extend(lookup[identity] for identity in record['sampled_ids'])
        if actual != plan[:len(actual)]:
            errors.append('sample-trace-diverged')
        l6_trace = {'completed_steps': len(records), 'sha256': sha(Path(trace_path).read_bytes()),
                    **summarize(train, actual)}
        l5_trace_path = ROOT/'outputs/l5/sample_trace.jsonl'
        if l5_trace_path.exists() and len(records) <= 50:
            l5_prefix = l5_trace_path.read_text().splitlines()[:len(records)]
            if records != [json.loads(line) for line in l5_prefix]:
                errors.append('l5-trace-prefix-changed')
    return {'l5_train_sha256': l5_qa['l5_train_sha256'],
            'validation_sha256': l5_qa['validation_sha256'],
            'heldout_sha256': l5_qa['heldout_sha256'],
            'sampler_weights': WEIGHTS, 'sampler_seed': SEED,
            'l5_hyperparameters_unchanged_except_checkpoints': 'non-checkpoint-hyperparameter-change' not in errors,
            'l6_checkpoints': L6['checkpoints'],
            'full_plan_sha256': sha(json.dumps(plan, separators=(',', ':')).encode()),
            'actual_training': l6_trace, 'errors': errors}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--trace', type=Path)
    p.add_argument('--out', default=str(ROOT/'corpus/metadata/l6_qa.json'))
    args = p.parse_args()
    result = audit(args.trace)
    write_json(Path(args.out), result)
    print(json.dumps(result, indent=2))
    if result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
