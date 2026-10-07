"""Make a private, stratified prompt/target review sample before L3 training."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from scripts.build_l3 import BUCKETS
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl


def make_sample(size_per_bucket=20):
    manifest = json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())
    train_works = sorted((m for m in manifest if m['split'] == 'train'), key=lambda m: m['work_id'])
    context = {}
    for i, work in enumerate(train_works):
        third = min(2, 3 * i // len(train_works))
        context[work['work_id']] = {'style_anchor': work['style_anchor'],
                                    'corpus_position': ('early', 'middle', 'late')[third]}
    rows = [json.loads(line) for line in (ROOT / 'data/l3/train.jsonl').read_text().splitlines()]
    selected = []
    for bucket in BUCKETS:
        pool = [r for r in rows if r['length_bucket'] == bucket]
        wanted = {'descriptive': round(size_per_bucket * .7),
                  'sparse': size_per_bucket - round(size_per_bucket * .7)}
        for klass, count in wanted.items():
            options = [r for r in pool if r['prompt_class'] == klass]
            used_works = set()
            for _ in range(count):
                if not options:
                    break
                # Prefer missing anchor/position strata and distinct works.
                anchor_count = sum(context[x['work_id']]['style_anchor'] for x in selected if x['length_bucket'] == bucket)
                position_count = Counter(context[x['work_id']]['corpus_position'] for x in selected if x['length_bucket'] == bucket)
                options.sort(key=lambda r: (
                    r['work_id'] in used_works,
                    not context[r['work_id']]['style_anchor'] if anchor_count < 2 else False,
                    position_count[context[r['work_id']]['corpus_position']],
                    sha(f'review:{r["id"]}'.encode())))
                row = options.pop(0)
                used_works.add(row['work_id'])
                selected.append({k: row[k] for k in ('id', 'work_id', 'prompt', 'target', 'source_path',
                              'source_line_start', 'source_line_end', 'length_bucket',
                              'prompt_class', 'length_mode', 'prompt_evidence', 'target_line_count')}
                              | context[row['work_id']])
    selected.sort(key=lambda r: (list(BUCKETS).index(r['length_bucket']), r['prompt_class'], r['id']))
    return selected


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--out', default='outputs/l3-review')
    args = p.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sample = make_sample()
    write_jsonl(out / 'sample.jsonl', sample)
    summary = {'count': len(sample),
               'buckets': dict(Counter(r['length_bucket'] for r in sample)),
               'classes': dict(Counter(r['prompt_class'] for r in sample)),
               'anchors': sum(r['style_anchor'] for r in sample),
               'positions': dict(Counter(r['corpus_position'] for r in sample)),
               'sample_sha256': sha((out / 'sample.jsonl').read_bytes())}
    write_json(out / 'sample_summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
