"""Audit terminal EOS supervision before the L6 intervention."""
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from pathlib import Path

from scripts.l4_sampler import EXAMPLES_PER_STEP, sample_plan
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, write_json
from scripts.train import batchify
from scripts.train_l3 import prepare
from scripts.train_l5 import rows


def distribution(values):
    values = sorted(values)
    return {'min': values[0], 'median': statistics.median(values),
            'mean': round(statistics.mean(values), 5), 'max': values[-1]}


def audit():
    import torch
    import transformers
    tokenizer = transformers.AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer.pad_token = tokenizer.eos_token
    splits = {split: rows(split) for split in ('train', 'validation', 'heldout')}
    prepared = {split: [prepare(tokenizer, row) for row in split_rows]
                for split, split_rows in splits.items()}
    errors = []
    result_splits = {}
    for split, examples in prepared.items():
        target_counts = []
        eos_fractions = []
        total_supervised = 0
        for row, example in zip(splits[split], examples):
            ids, labels = example['input_ids'], example['labels']
            supervised = [i for i, label in enumerate(labels) if label != -100]
            eos_positions = [i for i, label in enumerate(labels) if label == tokenizer.eos_token_id]
            if eos_positions != [len(labels)-1] or ids[-1] != tokenizer.eos_token_id:
                errors.append(f'eos-location:{row["id"]}')
            if any(label == tokenizer.eos_token_id for label in labels[:-1]):
                errors.append(f'internal-supervised-eos:{row["id"]}')
            if len(supervised) != len(labels) - supervised[0]:
                errors.append(f'noncontiguous-target-labels:{row["id"]}')
            if supervised[0] == 0:
                errors.append(f'unmasked-first-input:{row["id"]}')
            count = len(supervised)
            target_counts.append(count - 1)
            eos_fractions.append(1/count)
            total_supervised += count
        result_splits[split] = {
            'examples': len(examples),
            'target_tokens_excluding_terminal_eos': distribution(target_counts),
            'supervised_tokens_including_terminal_eos': total_supervised,
            'terminal_eos_labels': len(examples),
            'terminal_eos_share_of_supervised_tokens': round(len(examples)/total_supervised, 6),
            'per_example_eos_share': distribution(eos_fractions),
        }
    train = splits['train']
    train_prepared = prepared['train']
    by_bucket = {}
    for bucket in ('very_short', 'short', 'medium', 'longer'):
        indices = [i for i, row in enumerate(train) if row['length_bucket'] == bucket]
        sizes = [sum(label != -100 for label in train_prepared[i]['labels']) for i in indices]
        by_bucket[bucket] = {'examples': len(indices),
                             'target_tokens_excluding_eos': distribution([n-1 for n in sizes]),
                             'per_example_eos_share': distribution([1/n for n in sizes]),
                             'aggregate_eos_share': round(len(indices)/sum(sizes), 6)}
    plan = sample_plan(train)
    first_50 = plan[:50 * EXAMPLES_PER_STEP]
    sampled_supervised = sum(sum(label != -100 for label in train_prepared[i]['labels']) for i in first_50)
    microbatches = [first_50[i:i+2] for i in range(0, len(first_50), 2)]
    micro_eos_shares = [2/sum(sum(label != -100 for label in train_prepared[i]['labels']) for i in pair)
                        for pair in microbatches]
    shortest, longest = sorted(train_prepared, key=lambda example: len(example['input_ids']))[::len(train_prepared)-1]
    padded = batchify(tokenizer, [shortest, longest], 'cpu')
    shorter_size = len(shortest['input_ids'])
    padding_labels = padded['labels'][0, shorter_size:]
    padding_mask = padded['attention_mask'][0, shorter_size:]
    if torch.any(padding_labels != -100) or torch.any(padding_mask != 0):
        errors.append('padding-loss-leak')
    if padded['labels'][0, shorter_size-1] != tokenizer.eos_token_id:
        errors.append('terminal-eos-lost-before-padding')
    return {
        'model_id': CONFIG['model_id'], 'revision': CONFIG['model_revision'],
        'transformers_version': transformers.__version__,
        'loss_path': 'ForCausalLMLoss shifts labels left and applies float32 cross_entropy(mean, ignore_index=-100) when num_items_in_batch is absent; the L5 trainer passes no num_items_in_batch.',
        'dataset_hashes': {split: sha((ROOT/('data/l5' if split == 'train' else 'data/l3')/f'{split}.jsonl').read_bytes())
                           for split in splits},
        'splits': result_splits, 'train_by_bucket': by_bucket,
        'first_50_l4_plan': {'draws': len(first_50), 'supervised_tokens': sampled_supervised,
                             'terminal_eos_labels': len(first_50),
                             'aggregate_eos_share': round(len(first_50)/sampled_supervised, 6),
                             'microbatch_eos_share': distribution(micro_eos_shares)},
        'padding': {'unequal_length_batch_checked': True,
                    'masked_padding_tokens': int(len(padding_labels)),
                    'padding_label': -100, 'padding_attention': 0},
        'terminal_eos_count_per_example': 1,
        'internal_eos_supervised': False,
        'implementation_bug_found': bool(errors), 'errors': errors,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', default=str(ROOT/'corpus/metadata/l6_eos_audit.json'))
    args = p.parse_args()
    result = audit()
    write_json(Path(args.out), result)
    print(json.dumps(result, indent=2))
    if result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
