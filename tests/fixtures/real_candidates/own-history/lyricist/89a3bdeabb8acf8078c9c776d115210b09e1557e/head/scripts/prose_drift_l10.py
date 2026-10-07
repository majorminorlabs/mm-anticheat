"""Transparent prose-drift screening for a blinded manual review."""
from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path

from scripts.evaluate import norm_words
from scripts.pipeline import write_json

EXPLANATORY = re.compile(r'(?im)^\s*(?:the point is|in other words|the first part of (?:the )?(?:refrain|verse|song)|this (?:means|symbolizes|represents|might be why)|what this (?:means|shows))\b')
EDITOR_META = re.compile(r"(?im)(?:^\s*(?:sure[,!]|here(?:['’]s| is) (?:an?|the|your)\b|as an ai\b|i (?:wrote|created|can revise)\b|note:|editor(?:['’]s)? note:|\*\*line\s+\d+\*\*:)|\b(?:we['’]ll leave it up to you|we shall see what you make|i want you to write|let me know if you|would you like me to)\b)")
DIRECT_THEME = re.compile(r'(?im)^\s*(?:this (?:song|poem|piece|verse|story) is about|the (?:theme|emotion|feeling) is)\b')


def flags(output):
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    long_lines = [line for line in lines if len(norm_words(line)) >= 25]
    return {'explanatory_prose_proxy': bool(EXPLANATORY.search(output)),
            'narrative_prose_paragraph_proxy': len(long_lines) >= 2 or
                (len(long_lines) >= 1 and len(lines) <= 3),
            'editor_assistant_meta_proxy': bool(EDITOR_META.search(output)),
            'direct_theme_explanation_proxy': bool(DIRECT_THEME.search(output)),
            'long_line_count': len(long_lines)}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runs', nargs='+', required=True, help='NAME=directory')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    summaries = {}
    review = []
    for item in args.runs:
        name, directory = item.split('=', 1)
        rows = [json.loads(line) for line in (Path(directory) / 'generations.jsonl').read_text().splitlines()]
        if len(rows) != 50:
            raise ValueError(f'{name} must have all fixed50 outputs')
        all_flags = []
        for row in rows:
            found = flags(row['output'])
            all_flags.append(found)
            review.append({'model': name, 'id': row['id'], 'output': row['output'],
                           'machine_proxies': found, 'manual_review': 'PENDING',
                           'manual_categories': [], 'review_note': ''})
        summaries[name] = {'count': len(rows), **dict(Counter({key: sum(f[key] is True for f in all_flags)
                         for key in ('explanatory_prose_proxy', 'narrative_prose_paragraph_proxy',
                                     'editor_assistant_meta_proxy', 'direct_theme_explanation_proxy')}))}
    write_json(Path(args.out), {'method': 'Machine proxies are screening leads, not adjudicated prose-drift counts.',
                                'summary': summaries, 'manual_review_rows': review})
    print(json.dumps(summaries, indent=2))


if __name__ == '__main__':
    main()
