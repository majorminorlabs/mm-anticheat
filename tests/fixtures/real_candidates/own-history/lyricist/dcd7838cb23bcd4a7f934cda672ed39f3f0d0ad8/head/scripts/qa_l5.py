"""L5 controlled-variant, provenance, serialization, and sampler audit."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from scripts.build_l5 import LABELS, SEED, counts
from scripts.l4_sampler import BUCKETS, EXAMPLES_PER_STEP, sample_plan, summarize
from scripts.modeling import CONFIG, ROOT, format_prompt
from scripts.pipeline import sha, write_json
from scripts.qa_l3 import audit as l3_audit
from scripts.train_l3 import prepare, rows as l3_rows


def audit(tokenizer=False, trace_path=None):
    source = l3_rows('train')
    variants = [json.loads(x) for x in (ROOT / 'data/l5/train.jsonl').read_text().splitlines()]
    manifest = {r['work_id']: r for r in json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())}
    errors = []
    if len(source) != len(variants) or len(variants) != 224:
        errors.append('row-count')
    if len({r['id'] for r in variants}) != len(variants):
        errors.append('duplicate-id')
    allowed = {'length_control', 'length_mode'}
    for before, after in zip(source, variants):
        if before['id'] != after['id']:
            errors.append(f'order:{before["id"]}')
        if {k: v for k, v in before.items() if k not in allowed} != {k: v for k, v in after.items() if k not in allowed}:
            errors.append(f'non-field-change:{before["id"]}')
        if after['target'] != before['target'] or after['target_sha256'] != before['target_sha256']:
            errors.append(f'target-changed:{before["id"]}')
        if after['length_control'] is None:
            if before['length_control'] is not None or after['length_mode'] != before['length_mode']:
                errors.append(f'no-field-mismatch:{before["id"]}')
        elif after['length_control'] != LABELS[after['length_bucket']] or after['length_mode'] != 'field':
            errors.append(f'label-mismatch:{before["id"]}')
        if format_prompt(after['prompt'], after['length_control']).count('length: ') != (after['length_control'] is not None):
            errors.append(f'field-serialization:{before["id"]}')
    original_qa = l3_audit(False)
    if original_qa['errors']:
        errors.append('l3-source-qa-errors')
    if sample_plan(source) != sample_plan(variants):
        errors.append('sampler-changed')
    explicit = [r for r in variants if r['length_control'] is not None]
    no_field = [r for r in variants if r['length_control'] is None]
    if (len(explicit), len(no_field)) != (179, 45):
        errors.append('exposure-ratio')
    train_works = {r['work_id'] for r in variants}
    val_works = {r['work_id'] for r in l3_rows('validation')}
    held_works = {r['work_id'] for r in l3_rows('heldout')}
    if train_works & (val_works | held_works):
        errors.append('work-leakage')
    if len({r['target_sha256'] for r in variants}) != len(variants):
        errors.append('duplicate-target-hash')
    token_stats = None
    if tokenizer:
        from transformers import AutoTokenizer
        from scripts.train import batchify
        tok = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
        tok.pad_token = tok.eos_token
        lengths = []
        prepared = []
        for row in variants:
            example = prepare(tok, row)
            prepared.append(example)
            ids, labels = example['input_ids'], example['labels']
            prefix_length = next(i for i, x in enumerate(labels) if x != -100)
            if ids.count(tok.eos_token_id) != 1 or ids[-1] != tok.eos_token_id or labels[-1] != tok.eos_token_id:
                errors.append(f'eos:{row["id"]}')
            if any(x != -100 for x in labels[:prefix_length]) or any(x == -100 for x in labels[prefix_length:]):
                errors.append(f'loss-mask:{row["id"]}')
            lengths.append(len(ids))
        pair = sorted(prepared, key=lambda e: len(e['input_ids']))
        padded = batchify(tok, [pair[0], pair[-1]], 'cpu')
        n = len(pair[0]['input_ids'])
        if any(int(x) != -100 for x in padded['labels'][0, n:]) or any(int(x) != 0 for x in padded['attention_mask'][0, n:]):
            errors.append('padding-loss-mask')
        token_stats = {'max_sequence': max(lengths), 'cap': 384,
                       'over_cap': sum(n > 384 for n in lengths),
                       'eos_after_entire_target': True, 'padding_checked': True}
    actual_training = None
    if trace_path:
        traces = [json.loads(line) for line in trace_path.read_text().splitlines()]
        by_id = {row['id']: i for i, row in enumerate(variants)}
        observed = []
        for number, record in enumerate(traces, start=1):
            if record['step'] != number or len(record['sampled_ids']) != EXAMPLES_PER_STEP:
                errors.append(f'trace-step:{number}')
                continue
            observed.extend(by_id[identity] for identity in record['sampled_ids'])
        if observed != sample_plan(variants)[:len(observed)]:
            errors.append('actual-sampler-diverged')
        actual_training = {'completed_steps': len(traces), 'trace_sha256': sha(trace_path.read_bytes()),
                           **summarize(variants, observed)}
    work_counts = {}
    for wid in sorted(train_works):
        wr = [r for r in variants if r['work_id'] == wid]
        work_counts[wid] = {'total': len(wr), 'explicit': sum(r['length_control'] is not None for r in wr),
                            'no_field': sum(r['length_control'] is None for r in wr),
                            'style_anchor': bool(manifest[wid]['style_anchor'])}
    anchor = [r for r in variants if manifest[r['work_id']]['style_anchor']]
    result = {'source_l3_sha256': sha((ROOT / 'data/l3/train.jsonl').read_bytes()),
              'l5_train_sha256': sha((ROOT / 'data/l5/train.jsonl').read_bytes()),
              'validation_sha256': sha((ROOT / 'data/l3/validation.jsonl').read_bytes()),
              'heldout_sha256': sha((ROOT / 'data/l3/heldout.jsonl').read_bytes()),
              'selection_seed': SEED, 'total': len(variants),
              'explicit': len(explicit), 'no_field': len(no_field),
              'explicit_pct': round(100*len(explicit)/len(variants), 2),
              'no_field_pct': round(100*len(no_field)/len(variants), 2),
              'fieldless_modes': dict(Counter(r['length_mode'] for r in no_field)),
              'by_bucket': counts(variants),
              'by_class': {cls: {'total': sum(r['prompt_class']==cls for r in variants),
                                'explicit': sum(r['prompt_class']==cls for r in explicit),
                                'no_field': sum(r['prompt_class']==cls for r in no_field)}
                           for cls in ('descriptive','sparse')},
              'by_work': work_counts,
              'explicit_works': len({r['work_id'] for r in explicit}),
              'no_field_works': len({r['work_id'] for r in no_field}),
              'style_anchors': {'works': len({r['work_id'] for r in anchor}),
                                'total': len(anchor),
                                'explicit': sum(r['length_control'] is not None for r in anchor),
                                'no_field': sum(r['length_control'] is None for r in anchor)},
              'labels': dict(Counter(r['length_control'] for r in explicit)),
              'target_text_unchanged': not any(x.startswith('target-changed:') for x in errors),
              'semantic_fields_unchanged': not any(x.startswith('non-field-change:') for x in errors),
              'sampler_plan_unchanged': 'sampler-changed' not in errors,
              'provenance_verified_by_l3_qa': not original_qa['errors'],
              'split_leakage': 'work-leakage' in errors,
              'duplicate_target_hashes': 'duplicate-target-hash' in errors,
              'token_stats': token_stats, 'actual_training': actual_training, 'errors': errors}
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--tokenizer', action='store_true')
    p.add_argument('--trace', type=Path)
    args = p.parse_args()
    result = audit(args.tokenizer, args.trace)
    write_json(ROOT / 'corpus/metadata/l5_qa.json', result)
    print(json.dumps({k: v for k, v in result.items() if k != 'by_work'}, indent=2))
    if result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
