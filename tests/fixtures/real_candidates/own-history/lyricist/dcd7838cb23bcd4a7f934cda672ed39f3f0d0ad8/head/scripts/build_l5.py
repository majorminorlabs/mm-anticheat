"""Controlled L5 length-field exposure from immutable L3 training rows."""
from __future__ import annotations

import argparse
import json
import random
import re
from collections import Counter

from scripts.l4_sampler import BUCKETS
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

LABELS = {'very_short': 'very short', 'short': 'short',
          'medium': 'medium', 'longer': 'long'}
SEED = 314165
NO_FIELD_BY_BUCKET = {'very_short': 6, 'short': 20, 'medium': 14, 'longer': 5}


def load():
    return [json.loads(line) for line in (ROOT / 'data/l3/train.jsonl').read_text().splitlines()]


def counts(rows):
    by_bucket = {}
    for bucket in BUCKETS:
        group = [row for row in rows if row['length_bucket'] == bucket]
        by_bucket[bucket] = {
            'total': len(group),
            'explicit': sum(row['length_control'] is not None for row in group),
            'no_field': sum(row['length_control'] is None for row in group),
            'class': {cls: {'total': sum(r['prompt_class'] == cls for r in group),
                            'explicit': sum(r['prompt_class'] == cls and r['length_control'] is not None for r in group),
                            'no_field': sum(r['prompt_class'] == cls and r['length_control'] is None for r in group)}
                      for cls in ('descriptive', 'sparse')},
        }
    return by_bucket


def original_audit(rows):
    manifest = {x['work_id']: x for x in json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())}
    explicit = [r for r in rows if r['length_control'] is not None]
    mismatched = [{'id': r['id'], 'bucket': r['length_bucket'], 'label': r['length_control'],
                   'canonical': LABELS[r['length_bucket']]} for r in explicit
                  if r['length_control'] != LABELS[r['length_bucket']]]
    malformed = [r['id'] for r in explicit if r['length_control'] not in set(LABELS.values())]
    natural_labels = {'very short': 'very_short', 'short': 'short',
                      'medium-length': 'medium', 'longer': 'longer'}
    natural_counts = Counter()
    natural_ambiguous = []
    natural_mismatched = []
    for row in rows:
        if row['length_mode'] != 'natural':
            continue
        hits = [label for label in natural_labels
                if re.search(r'\b'+re.escape(label)+r'\b', row['prompt'])]
        if 'very short' in hits and 'short' in hits:
            hits.remove('short')
        if len(hits) != 1:
            natural_ambiguous.append({'id': row['id'], 'hits': hits})
        else:
            natural_counts[hits[0]] += 1
            if natural_labels[hits[0]] != row['length_bucket']:
                natural_mismatched.append({'id': row['id'], 'label': hits[0], 'bucket': row['length_bucket']})
    by_work = {}
    for wid in sorted({r['work_id'] for r in rows}):
        group = [r for r in rows if r['work_id'] == wid]
        by_work[wid] = {'total': len(group),
                        'explicit': sum(r['length_control'] is not None for r in group),
                        'no_field': sum(r['length_control'] is None for r in group),
                        'style_anchor': bool(manifest[wid]['style_anchor'])}
    return {'source_sha256': sha((ROOT / 'data/l3/train.jsonl').read_bytes()),
            'total': len(rows), 'explicit': len(explicit), 'no_field': len(rows)-len(explicit),
            'modes': dict(Counter(r['length_mode'] for r in rows)),
            'by_bucket': counts(rows),
            'by_class': {cls: {'total': sum(r['prompt_class'] == cls for r in rows),
                              'explicit': sum(r['prompt_class'] == cls and r['length_control'] is not None for r in rows)}
                         for cls in ('descriptive', 'sparse')},
            'train_works': len({r['work_id'] for r in rows}),
            'explicit_works': len({r['work_id'] for r in explicit}),
            'by_work': by_work,
            'anchor_examples': sum(manifest[r['work_id']]['style_anchor'] for r in rows),
            'explicit_anchor_examples': sum(manifest[r['work_id']]['style_anchor'] for r in explicit),
            'labels': dict(Counter(r['length_control'] for r in explicit)),
            'canonical_labels': LABELS, 'mismatched': mismatched,
            'malformed': malformed,
            'natural_labels': dict(natural_counts),
            'natural_ambiguous': natural_ambiguous,
            'natural_mismatched': natural_mismatched}


def select_no_field(rows):
    """Select 45 fieldless rows, balancing bucket, class, anchor, then work."""
    manifest = {x['work_id']: x for x in json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())}
    rng = random.Random(SEED)
    selected = set()
    selected_work = Counter()
    for bucket in BUCKETS:
        group = [r for r in rows if r['length_bucket'] == bucket]
        candidates = [r for r in group if r['length_control'] is None]
        quota = NO_FIELD_BY_BUCKET[bucket]
        if len(candidates) < quota:
            raise ValueError(f'Not enough unconditioned candidates in {bucket}')
        # Largest remainder allocation by prompt class, with an anchor quota
        # as a tie breaker inside each class. Existing explicit rows stay explicit.
        class_counts = Counter(r['prompt_class'] for r in group)
        sparse_quota = round(quota * class_counts['sparse'] / len(group))
        class_quota = {'sparse': sparse_quota, 'descriptive': quota-sparse_quota}
        for cls in ('descriptive', 'sparse'):
            pool = [r for r in candidates if r['prompt_class'] == cls]
            target = class_quota[cls]
            if len(pool) < target:
                raise ValueError(f'Not enough {bucket}/{cls} no-field candidates')
            rng.shuffle(pool)
            anchor_count = sum(manifest[r['work_id']]['style_anchor'] for r in group if r['prompt_class'] == cls)
            class_total = class_counts[cls]
            anchor_quota = min(round(target * anchor_count / class_total),
                               sum(manifest[r['work_id']]['style_anchor'] for r in pool))
            for anchor, n in ((True, anchor_quota), (False, target-anchor_quota)):
                choices = [r for r in pool if bool(manifest[r['work_id']]['style_anchor']) == anchor]
                for _ in range(n):
                    if not choices:
                        raise ValueError(f'Not enough {bucket}/{cls}/anchor={anchor} candidates')
                    row = min(choices, key=lambda r: selected_work[r['work_id']])
                    choices.remove(row)
                    selected.add(row['id'])
                    selected_work[row['work_id']] += 1
    return selected


def build(rows):
    no_field = select_no_field(rows)
    variants = []
    for original in rows:
        row = dict(original)
        if row['id'] not in no_field:
            row['length_mode'] = 'field'
            row['length_control'] = LABELS[row['length_bucket']]
        variants.append(row)
    return variants


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--audit-only', action='store_true')
    args = p.parse_args()
    rows = load()
    audit = original_audit(rows)
    write_json(ROOT / 'corpus/metadata/l5_original_field_audit.json', audit)
    if len(rows) != 224 or audit['explicit'] != 67 or audit['malformed']:
        raise SystemExit('Original L3 field audit differs from expected 224/67 or contains malformed labels')
    print(json.dumps({'original': {'total': audit['total'], 'explicit': audit['explicit'],
                                   'no_field': audit['no_field'], 'mismatched': len(audit['mismatched'])}}))
    if args.audit_only:
        return
    variants = build(rows)
    if len(variants) != 224 or sum(r['length_control'] is not None for r in variants) != 179:
        raise ValueError('L5 exposure count changed')
    write_jsonl(ROOT / 'data/l5/train.jsonl', variants)
    print(json.dumps({'l5': {'total': len(variants), 'explicit': 179, 'no_field': 45,
                              'sha256': sha((ROOT / 'data/l5/train.jsonl').read_bytes())}}))


if __name__ == '__main__':
    main()
