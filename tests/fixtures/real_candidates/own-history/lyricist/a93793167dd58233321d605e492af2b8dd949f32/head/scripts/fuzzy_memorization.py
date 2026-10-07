"""Conservative fuzzy source-overlap review for generated text.

Flags are leads for manual inspection, never proof of memorization.
"""
from __future__ import annotations

import argparse
import difflib
import json
from collections import Counter
from pathlib import Path

from scripts.evaluate import norm_words
from scripts.modeling import ROOT
from scripts.pipeline import write_json


def _sources():
    return [(r['work_id'], norm_words(r['text'])) for r in
            (json.loads(line) for line in (ROOT / 'data/pretrain/train.jsonl').read_text().splitlines())]


def _windows(output, source, block):
    for size in (8, 12, 16):
        if len(output) < size or len(source) < size:
            continue
        for shift in (-3, 0, 3):
            out_start = max(0, min(len(output) - size, block.a + shift))
            source_start = max(0, min(len(source) - size, block.b + shift))
            yield output[out_start:out_start + size], source[source_start:source_start + size], out_start, source_start


def audit(generations):
    rows = [json.loads(line) for line in Path(generations).read_text().splitlines()]
    source = _sources()
    work_frequency = Counter(word for _, tokens in source for word in set(tokens))
    findings = []
    per_output = []
    for row in rows:
        output = norm_words(row['output'])
        best = None
        suspicious = []
        for work_id, tokens in source:
            matcher = difflib.SequenceMatcher(None, output, tokens, autojunk=False)
            for block in matcher.get_matching_blocks():
                if block.size < 3:
                    continue
                for out_window, source_window, out_start, source_start in _windows(output, tokens, block):
                    ratio = difflib.SequenceMatcher(None, out_window, source_window, autojunk=False).ratio()
                    rare = sum(work_frequency[t] <= 2 for t in set(out_window) & set(source_window))
                    candidate = {'work_id': work_id, 'window_tokens': len(out_window),
                                 'similarity': round(ratio, 3), 'rare_shared_terms': rare,
                                 'output_start_token': out_start, 'source_start_token': source_start,
                                 'output_window': ' '.join(out_window),
                                 'source_window': ' '.join(source_window)}
                    if best is None or (ratio, len(out_window), rare) > (best['similarity'], best['window_tokens'], best['rare_shared_terms']):
                        best = candidate
                    if (len(out_window) >= 12 and ratio >= .82 and rare >= 2) or (ratio >= .9 and rare >= 2):
                        suspicious.append(candidate)
        suspicious.sort(key=lambda x: (-x['similarity'], -x['window_tokens'], -x['rare_shared_terms']))
        unique = []
        seen = set()
        for hit in suspicious:
            key = (hit['work_id'], hit['output_start_token'], hit['source_start_token'])
            if key not in seen:
                seen.add(key)
                unique.append(hit)
        per_output.append({'id': row['id'], 'best_fuzzy_window': best,
                           'suspicious_count': len(unique),
                           'suspicious': unique[:5]})
        if unique:
            findings.append({'id': row['id'], 'nearest_source_work': unique[0]['work_id'],
                             'top_match': unique[0], 'candidate_count': len(unique)})
    return {'generated_outputs': len(rows), 'suspicious_outputs': len(findings),
            'threshold': 'at least two terms occurring in at most two training works, plus 12-token ratio >=.82 or 8-token ratio >=.90',
            'findings': findings, 'per_output': per_output}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--generations', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    result = audit(args.generations)
    write_json(Path(args.out), result)
    print(json.dumps({k: v for k, v in result.items() if k != 'per_output'}, indent=2))


if __name__ == '__main__':
    main()
