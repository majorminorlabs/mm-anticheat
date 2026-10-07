"""Build L11 from scored, unchanged L5 training targets only."""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from pathlib import Path

from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

MIN_BUCKET_TARGETS = {'very_short': 5, 'short': 15, 'medium': 15, 'longer': 8}


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def eligible(record: dict, cutoff: int) -> bool:
    scores = record['scores']
    audit = record['audit']
    return (record['composite'] >= cutoff and scores['A'] >= 2 and scores['D'] >= 2 and
            scores['G'] <= 2 and scores['H'] <= 2 and scores['I'] <= 2 and
            audit['natural_source_end_boundary_proxy'] and not audit['dangling_terminal_proxy'])


def build(cutoff: int, max_count: int, review_file: Path, out: Path) -> dict:
    if not 70 <= max_count <= 120:
        raise ValueError('L11 max count must stay within the predeclared 70–120 range')
    source_path = ROOT/'data/l5/train.jsonl'
    source = read_jsonl(source_path)
    source_by_id = {row['id']: row for row in source}
    scored_path = ROOT/'corpus/metadata/l11_target_scores.json'
    scores = json.loads(scored_path.read_text())
    scored = scores['rows']
    if scores['candidate_count'] != 224 or len(scored) != 224 or len(source_by_id) != 224 or \
       {row['id'] for row in scored} != set(source_by_id):
        raise ValueError('L11 target scores and source candidates mismatch')
    review = json.loads(review_file.read_text())
    preview = review.get('preview', False)
    rejected = set(review.get('reject_ids', []))
    reviewed = set(review.get('reviewed_ids', []))
    overrides = review.get('prompt_overrides', {})
    if not (rejected | reviewed | set(overrides)) <= set(source_by_id):
        raise ValueError('Manual review mentions unknown IDs')
    if set(overrides) & rejected:
        raise ValueError('A rejected target cannot receive a prompt override')
    pool = [record for record in scored if eligible(record, cutoff) and record['id'] not in rejected]
    # Source-work coverage breaks quality ties; no prior generation result enters selection.
    chosen, per_work, per_bucket = [], Counter(), Counter()
    pending = pool.copy()
    anchor_limit = math.floor(max_count * .15)
    anchors = 0

    def rank(record):
        return (-record['composite'], -record['scores']['A'], -record['scores']['D'],
                -record['scores']['B'], -record['scores']['C'],
                per_work[record['audit']['work_id']] > 0, record['target_sha256'])

    def take(bucket=None):
        nonlocal anchors
        pending.sort(key=rank)
        for candidate in pending:
            if bucket is not None and source_by_id[candidate['id']]['length_bucket'] != bucket:
                continue
            work = candidate['audit']['work_id']
            if per_work[work] >= 3 or (candidate['audit']['style_anchor'] and anchors >= anchor_limit):
                continue
            if any(existing['audit']['work_id'] == work and
                   max(existing['audit']['source_line_start'], candidate['audit']['source_line_start']) <=
                   min(existing['audit']['source_line_end'], candidate['audit']['source_line_end'])
                   for existing in chosen):
                continue
            chosen.append(candidate)
            per_work[work] += 1
            per_bucket[source_by_id[candidate['id']]['length_bucket']] += 1
            anchors += bool(candidate['audit']['style_anchor'])
            pending.remove(candidate)
            return True
        return False

    # All reserved examples must pass the same quality cutoff. This protects
    # length coverage without lowering the source-only quality bar.
    for bucket in ('longer', 'medium', 'short', 'very_short'):
        minimum = MIN_BUCKET_TARGETS[bucket]
        while per_bucket[bucket] < minimum and len(chosen) < max_count and take(bucket):
            pass
    while pending and len(chosen) < max_count and take():
        pass
    while chosen and anchors / len(chosen) > .15:
        last_anchor = next((i for i in range(len(chosen) - 1, -1, -1)
                            if chosen[i]['audit']['style_anchor']), None)
        if last_anchor is None:
            break
        removed = chosen.pop(last_anchor)
        anchors -= 1
        per_work[removed['audit']['work_id']] -= 1
        per_bucket[source_by_id[removed['id']]['length_bucket']] -= 1
    chosen.sort(key=lambda r: r['id'])
    selected_ids = {r['id'] for r in chosen}
    if not preview and not selected_ids <= reviewed:
        raise ValueError('Every selected target requires documented manual review')
    if set(overrides) - selected_ids:
        raise ValueError('Prompt override is not in selected set')
    prompt_reviews = review.get('prompt_reviews', {})
    if set(prompt_reviews) != set(overrides):
        raise ValueError('Every prompt revision requires old/new/reason/status review')
    for identifier, revised in overrides.items():
        detail = prompt_reviews[identifier]
        if (detail.get('old_prompt') != source_by_id[identifier]['prompt'] or
            detail.get('new_prompt') != revised or not detail.get('reason') or
            detail.get('status') != 'approved'):
            raise ValueError(f'Prompt revision review incomplete: {identifier}')
    train = []
    changes = []
    for record in chosen:
        row = dict(source_by_id[record['id']])
        if row['target_sha256'] != record['target_sha256'] or sha(row['target'].encode()) != row['target_sha256']:
            raise ValueError('Target text changed during curation')
        if record['id'] in overrides:
            revised = overrides[record['id']]
            if not isinstance(revised, str) or not revised.strip() or '\n' in revised:
                raise ValueError('Prompt override must be a short single-line string')
            changes.append({'id': record['id'], 'old_sha256': sha(row['prompt'].encode()),
                            'new_sha256': sha(revised.encode())})
            row['prompt'] = revised
        train.append(row)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'train.jsonl', train)
    old_targets = {r['target_sha256'] for r in source}
    if any(r['target_sha256'] not in old_targets for r in train):
        raise AssertionError('Non-L5 target entered L11')
    report = {
        'rubric_sha256': scores['rubric_sha256'],
        'target_scores_sha256': sha(scored_path.read_bytes()),
        'original_l5_train_sha256': sha(source_path.read_bytes()),
        'manual_review_sha256': sha(review_file.read_bytes()),
        'selection_cutoff': cutoff, 'max_count': max_count,
        'candidate_count': len(source), 'numeric_eligible_count': sum(eligible(r, cutoff) for r in scored),
        'eligible_after_manual_review': len(pool), 'selected_count': len(train),
        'selected_ids': [r['id'] for r in train],
        'selected_target_hashes': {r['id']: r['target_sha256'] for r in train},
        'selected_prompt_hashes': {r['id']: sha(r['prompt'].encode()) for r in train},
        'train_jsonl_sha256': sha((out/'train.jsonl').read_bytes()),
        'source_work_count': sum(value > 0 for value in per_work.values()),
        'max_selected_per_work': max(per_work.values()) if per_work else 0,
        'overlapping_selected_source_spans': 0,
        'style_anchor_work_count': len({r['work_id'] for r in train
                                        if next(s['audit']['style_anchor'] for s in chosen if s['id'] == r['id'])}),
        'style_anchor_target_count': anchors,
        'style_anchor_target_fraction': round(anchors / len(train), 4) if train else 0,
        'length_bucket_counts': dict(sorted(Counter(r['length_bucket'] for r in train).items())),
        'selected_composite_histogram': dict(sorted(Counter(str(r['composite']) for r in chosen).items())),
        'prompt_revision_count': len(changes), 'prompt_revision_hashes': changes,
        'passage_expansion_count': 0,
        'manual_rejection_count': len(rejected),
        'manual_reviewed_selected_count': len(selected_ids & reviewed),
        'source_era_metadata_available': False,
        'target_text_changed': False,
        'validation_or_heldout_used': False,
    }
    if not preview:
        write_json(ROOT/'corpus/metadata/l11_selection.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--cutoff', type=int, required=True)
    parser.add_argument('--max-count', type=int, default=110)
    parser.add_argument('--review-file', type=Path, default=ROOT/'outputs/l11-candidates/manual_review.json')
    parser.add_argument('--out', type=Path, default=ROOT/'data/l11')
    args = parser.parse_args()
    print(json.dumps(build(args.cutoff, args.max_count, args.review_file, args.out), indent=2))
