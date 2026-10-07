"""L4 sampler and unchanged L3 training-format preflight/final trace audit."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.l4_sampler import EXAMPLES_PER_STEP, PLAN_STEPS, sample_plan, summarize, training_rows
from scripts.pipeline import sha, write_json
from scripts.qa_l3 import audit as audit_l3
from scripts.train_l3 import L3
from scripts.train_l4 import L4


def audit(trace_path=None, tokenizer=True):
    rows = training_rows()
    plan = sample_plan(rows)
    if plan != sample_plan(rows):
        raise ValueError('L4 sampler is not deterministic')
    l3 = audit_l3(tokenizer=tokenizer)
    if l3['errors']:
        raise ValueError(f'L3 data/format QA failed: {l3["errors"]}')
    if {k: v for k, v in L4.items() if k != 'checkpoints'} != {k: v for k, v in L3.items() if k != 'checkpoints'}:
        raise ValueError('L4 changed a non-sampling training setting')
    base = summarize(rows, plan[:50 * EXAMPLES_PER_STEP])
    if base['unique_source_works_observed'] != 84 or base['max_example_repetitions'] > 5:
        raise ValueError('L4 weighted sampler harmed source diversity')
    result = {
        'status': 'passed', 'source_l3_dataset_hashes': l3['dataset_hashes'],
        'unchanged_training_format': {
            'eos_count_per_example': l3['token_stats']['eos_count_per_example'] if tokenizer else None,
            'eos_after_target_tokens': l3['token_stats']['eos_after_target_tokens'] if tokenizer else None,
            'prompt_masked': tokenizer,
            'padding_label_value': l3['token_stats']['padding_label_value'] if tokenizer else None,
            'padding_checked_with_unequal_sequences': l3['token_stats']['padding_checked_with_unequal_sequences'] if tokenizer else None,
            'target_token_stats': l3['token_stats']['target'] if tokenizer else None,
            'full_sequence_stats': l3['token_stats']['full_sequence'] if tokenizer else None,
            'max_sequence_length': L3['max_sequence_length'],
            'truncated_count': l3['token_stats']['truncated_count'] if tokenizer else None,
        },
        'scheduled_50': base,
        'full_75_step_plan_sha256': sha(json.dumps(plan, separators=(',', ':')).encode()),
        'actual_training': None,
    }
    if trace_path:
        traces = [json.loads(line) for line in Path(trace_path).read_text().splitlines()]
        seen = []
        by_id = {row['id']: i for i, row in enumerate(rows)}
        for n, item in enumerate(traces, start=1):
            if item['step'] != n or len(item['sampled_ids']) != EXAMPLES_PER_STEP:
                raise ValueError(f'Invalid L4 sample trace step {n}')
            seen.extend(by_id[identity] for identity in item['sampled_ids'])
        if seen != plan[:len(seen)]:
            raise ValueError('Actual L4 sampling diverged from deterministic plan')
        result['actual_training'] = {'completed_steps': len(traces),
            'trace_sha256': sha(Path(trace_path).read_bytes()),
            **summarize(rows, seen)}
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--trace')
    p.add_argument('--out', required=True)
    p.add_argument('--without-tokenizer', action='store_true')
    args = p.parse_args()
    result = audit(args.trace, tokenizer=not args.without_tokenizer)
    write_json(Path(args.out), result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
