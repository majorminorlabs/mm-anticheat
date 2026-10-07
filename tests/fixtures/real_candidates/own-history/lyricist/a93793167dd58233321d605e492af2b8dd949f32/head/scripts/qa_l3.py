"""L3 provenance, prompt, duplication, leakage, and EOS/truncation audit."""
from __future__ import annotations

import argparse
import difflib
import json
import statistics
import unicodedata
from collections import Counter
from pathlib import Path

from scripts.build_l2 import normalized
from scripts.build_l3 import BUCKETS
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, words, write_json
from scripts.train_l3 import L3, prepare
from scripts.train import batchify


def load(split):
    return [json.loads(line) for line in (ROOT / 'data/l3' / f'{split}.jsonl').read_text().splitlines()]


def quantiles(values):
    values = sorted(values)
    return {'min': values[0], 'p10': values[int(.1 * (len(values) - 1))],
            'median': statistics.median(values), 'p90': values[int(.9 * (len(values) - 1))],
            'max': values[-1]}


def longest_overlap(a, b):
    aa, bb = normalized(a), normalized(b)
    return difflib.SequenceMatcher(None, aa, bb, autojunk=False).find_longest_match(0, len(aa), 0, len(bb)).size


def audit(tokenizer=False):
    manifest = {x['work_id']: x for x in json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())}
    dataset = json.loads((ROOT / 'corpus/metadata/l3_dataset.json').read_text())
    splits = {s: load(s) for s in ('train', 'validation', 'heldout')}
    all_rows = [r for rows in splits.values() for r in rows]
    eval_prompts = {x['prompt'].casefold() for x in json.loads((ROOT / 'data/eval/prompts.json').read_text())}
    errors, sources, seen_ids, seen_targets = [], {}, set(), {}
    for split, rows in splits.items():
        for row in rows:
            wid, rid = row['work_id'], row['id']
            if row['split'] != split or manifest[wid]['split'] != split:
                errors.append(f'split:{rid}')
            if rid in seen_ids:
                errors.append(f'duplicate-id:{rid}')
            seen_ids.add(rid)
            source = ROOT / row['source_path']
            if source not in sources:
                sources[source] = (source.read_bytes(), source.read_text(encoding='utf-8-sig').splitlines())
            raw, lines = sources[source]
            if sha(raw) != row['source_sha256'] or sha(raw) != manifest[wid]['source_sha256']:
                errors.append(f'source-sha:{rid}')
            start, end = row['source_line_start'], row['source_line_end']
            expected_nums = list(range(start, end + 1))
            if row['source_line_numbers'] != expected_nums or not 1 <= start <= end <= len(lines):
                errors.append(f'line-range:{rid}')
                continue
            expected = '\n'.join(unicodedata.normalize('NFC', lines[n - 1].rstrip()) for n in expected_nums)
            if expected != row['target'] or sha(expected.encode()) != row['target_sha256']:
                errors.append(f'provenance:{rid}')
            count = len([line for line in row['target'].splitlines() if line.strip()])
            lo, hi = BUCKETS[row['length_bucket']]
            if count != row['target_line_count'] or not lo <= count <= hi:
                errors.append(f'length-bucket:{rid}')
            key = ' '.join(normalized(row['target']))
            if key in seen_targets:
                errors.append(f'exact-duplicate:{rid}:{seen_targets[key]}')
            seen_targets[key] = rid
            if row['prompt'].casefold() in eval_prompts:
                errors.append(f'eval-prompt-in-train:{rid}')
            if longest_overlap(row['prompt'], row['target']) >= 4:
                errors.append(f'prompt-copy:{rid}')
            target_tokens = set(normalized(row['target']))
            for hits in row['prompt_evidence'].values():
                if any(not normalized(hit) or normalized(hit)[0] not in target_tokens for hit in hits):
                    errors.append(f'ungrounded-evidence:{rid}')
            mode = row['length_mode']
            if mode not in ('none', 'field', 'natural'):
                errors.append(f'length-mode:{rid}')
            if mode == 'field' and row['length_control'] not in ('short', 'medium', 'long'):
                errors.append(f'length-field:{rid}')
            if mode != 'field' and row['length_control'] is not None:
                errors.append(f'unexpected-length-field:{rid}')
            if mode == 'natural' and not any(x in row['prompt'] for x in ('very short', ' short ', 'medium-length', 'longer')):
                errors.append(f'missing-natural-length:{rid}')
    work_sets = {s: {r['work_id'] for r in rows} for s, rows in splits.items()}
    if any(work_sets[a] & work_sets[b] for a, b in (('train', 'validation'), ('train', 'heldout'), ('validation', 'heldout'))):
        errors.append('work-level-leakage')
    if work_sets['train'] != {wid for wid, m in manifest.items() if m['split'] == 'train'}:
        errors.append('training-work-coverage')
    if sum(m['style_anchor'] for m in manifest.values() if m['split'] == 'train') != 9:
        errors.append('style-anchor-split')
    fuzzy = []
    norm = [normalized(r['target']) for r in all_rows]
    sets = [set(tokens) for tokens in norm]
    for i in range(len(all_rows)):
        for j in range(i + 1, len(all_rows)):
            if len(sets[i] & sets[j]) / max(1, len(sets[i] | sets[j])) < .72:
                continue
            ratio = difflib.SequenceMatcher(None, norm[i], norm[j], autojunk=False).ratio()
            if ratio >= .88:
                fuzzy.append({'a': all_rows[i]['id'], 'b': all_rows[j]['id'],
                              'cross_split': all_rows[i]['split'] != all_rows[j]['split'],
                              'ratio': round(ratio, 3)})
    if any(x['cross_split'] for x in fuzzy):
        errors.append('cross-split-fuzzy-duplicate')
    if fuzzy:
        errors.append(f'fuzzy-duplicate-pairs:{len(fuzzy)}')
    train = splits['train']
    per_work = Counter(r['work_id'] for r in train)
    classes = Counter(r['prompt_class'] for r in train)
    buckets = Counter(r['length_bucket'] for r in train)
    modes = Counter(r['length_mode'] for r in train)
    if not .65 <= classes['descriptive'] / len(train) <= .75:
        errors.append('prompt-class-mix')
    if modes['none'] / len(train) < .20:
        errors.append('too-few-unconditioned-prompts')
    token_stats = None
    if tokenizer:
        from transformers import AutoTokenizer
        tok = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
        tok.pad_token = tok.eos_token
        lengths, prompt_lengths, target_lengths, eos_positions = [], [], [], []
        for row in all_rows:
            try:
                example = prepare(tok, row)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            ids, labels = example['input_ids'], example['labels']
            prefix_length = next(i for i, value in enumerate(labels) if value != -100)
            if ids.count(tok.eos_token_id) != 1 or ids[-1] != tok.eos_token_id or labels[-1] != tok.eos_token_id:
                errors.append(f'eos-placement:{row["id"]}')
            if any(x != -100 for x in labels[:prefix_length]) or any(x == -100 for x in labels[prefix_length:]):
                errors.append(f'loss-mask:{row["id"]}')
            lengths.append(len(ids))
            prompt_lengths.append(prefix_length)
            target_lengths.append(len(ids) - prefix_length - 1)
            eos_positions.append(len(ids) - prefix_length - 1)
        token_stats = {'full_sequence': quantiles(lengths), 'prompt': quantiles(prompt_lengths),
                       'target': quantiles(target_lengths), 'eos_after_target_tokens': quantiles(eos_positions),
                       'max_sequence_length': L3['max_sequence_length'],
                       'truncated_count': sum(x > L3['max_sequence_length'] for x in lengths),
                       'eos_count_per_example': 1,
                       'padding_label_value': -100}
        import torch
        ordered = sorted(all_rows, key=lambda r: len(prepare(tok, r)['input_ids']))
        padded = batchify(tok, [prepare(tok, ordered[0]), prepare(tok, ordered[-1])], 'cpu')
        short_size = len(prepare(tok, ordered[0])['input_ids'])
        if any(int(x) != -100 for x in padded['labels'][0, short_size:]) or any(int(x) != 0 for x in padded['attention_mask'][0, short_size:]):
            errors.append('padding-leaks-into-loss')
        token_stats['padding_checked_with_unequal_sequences'] = True
    review_path = ROOT / 'corpus/metadata/l3_review_summary.json'
    review = json.loads(review_path.read_text()) if review_path.exists() else None
    if not review or review.get('checked', 0) < 60:
        errors.append('manual-review-incomplete')
    result = {'counts': {s: len(rows) for s, rows in splits.items()},
              'training_works': len(work_sets['train']),
              'examples_per_work': quantiles(list(per_work.values())),
              'prompt_classes': dict(classes), 'length_buckets': dict(buckets),
              'length_modes': dict(modes),
              'target_word_distribution': quantiles([len(words(r['target'])) for r in train]),
              'prompt_word_distribution': quantiles([len(words(r['prompt'])) for r in train]),
              'prompt_target_overlap_words': quantiles([longest_overlap(r['prompt'], r['target']) for r in train]),
              'fuzzy_duplicate_pairs': fuzzy, 'fuzzy_duplicate_count': len(fuzzy),
              'repeated_section_handling': dataset['audit'],
              'manual_review': review, 'token_stats': token_stats,
              'dataset_hashes': {s: sha((ROOT / 'data/l3' / f'{s}.jsonl').read_bytes()) for s in splits},
              'errors': errors}
    return result


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--tokenizer', action='store_true')
    args = p.parse_args()
    result = audit(args.tokenizer)
    write_json(ROOT / 'corpus/metadata/l3_qa.json', result)
    print(json.dumps({k: v for k, v in result.items() if k not in ('fuzzy_duplicate_pairs',)}, indent=2))
    if result['errors']:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
