"""Join the manually checked sample with final prompts and record QA decisions."""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl


def main():
    review_dir = ROOT / 'outputs/l3-review'
    sample_path = review_dir / 'sample.jsonl'
    sample = [json.loads(line) for line in sample_path.read_text().splitlines()]
    overrides_path = ROOT / 'corpus/metadata/l3_review_overrides.json'
    overrides = json.loads(overrides_path.read_text())
    if overrides['sample_sha256'] != sha(sample_path.read_bytes()):
        raise ValueError('L3 review sample changed after manual decisions')
    decisions = overrides['decisions']
    if set(decisions) != {r['id'] for r in sample}:
        raise ValueError('Each sampled L3 row needs an explicit review decision')
    labels = json.loads((ROOT / 'corpus/metadata/l3_prompt_labels.json').read_text())['labels']
    result = []
    for row in sample:
        decision = decisions[row['id']]
        status = decision['status']
        if status not in ('GOOD', 'NEEDS_REVISION', 'REJECT'):
            raise ValueError(f'Invalid review status: {row["id"]}')
        if status == 'NEEDS_REVISION' and not decision.get('prompt'):
            raise ValueError(f'Revision has no prompt: {row["id"]}')
        if status == 'GOOD' and (not labels[row['id']]['class_valid'] or not labels[row['id']]['evidence_valid']):
            raise ValueError(f'GOOD row has invalid label evidence/class: {row["id"]}')
        result.append({**row, 'draft_prompt': labels[row['id']]['prompt'],
                       'review_status': status,
                       'reviewed_prompt': decision.get('prompt', labels[row['id']]['prompt']),
                       'review_reason': decision.get('reason', '')})
    write_jsonl(review_dir / 'reviewed.jsonl', result)
    counts = Counter(r['review_status'] for r in result)
    summary = {'checked': len(result), 'good': counts['GOOD'],
               'revised': counts['NEEDS_REVISION'], 'rejected': counts['REJECT'],
               'buckets': dict(Counter(r['length_bucket'] for r in result)),
               'classes': dict(Counter(r['prompt_class'] for r in result)),
               'anchors': sum(r['style_anchor'] for r in result),
               'positions': dict(Counter(r['corpus_position'] for r in result)),
               'sample_sha256': sha(sample_path.read_bytes()),
               'reviewed_sha256': sha((review_dir / 'reviewed.jsonl').read_bytes())}
    write_json(ROOT / 'corpus/metadata/l3_review_summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
