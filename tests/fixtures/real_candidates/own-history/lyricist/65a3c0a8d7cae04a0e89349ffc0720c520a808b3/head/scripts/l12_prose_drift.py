"""Compare L12 with the frozen L10 prose proxy and a stricter paragraph screen."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from scripts.evaluate import norm_words
from scripts.pipeline import write_json
from scripts.prose_drift_l10 import flags


def summarize(folder: Path):
    rows = [json.loads(line) for line in (folder / 'generations.jsonl').read_text().splitlines()]
    if len(rows) != 50:
        raise ValueError(f'{folder}: expected fixed50 outputs')
    existing = [flags(row['output']) for row in rows]
    strict_ids = []
    for row in rows:
        blocks = [block.strip() for block in re.split(r'\n\s*\n', row['output']) if block.strip()]
        if any('\n' not in block and len(norm_words(block)) >= 40 for block in blocks):
            strict_ids.append(row['id'])
    return {
        'count': len(rows),
        'l10_narrative_prose_paragraph_proxy': sum(r['narrative_prose_paragraph_proxy'] for r in existing),
        'strict_narrative_paragraph_proxy': len(strict_ids),
        'strict_proxy_ids': strict_ids,
        'explanatory_prose_proxy': sum(r['explanatory_prose_proxy'] for r in existing),
        'editor_assistant_meta_proxy': sum(r['editor_assistant_meta_proxy'] for r in existing),
        'direct_theme_explanation_proxy': sum(r['direct_theme_explanation_proxy'] for r in existing),
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runs', nargs='+', required=True, help='NAME=directory')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    result = {
        'definitions': {
            'l10_narrative_prose_paragraph_proxy':
                'At least two nonblank lines of 25+ words, or one such line when output has at most three nonblank lines.',
            'strict_narrative_paragraph_proxy':
                'At least one blank-line-delimited paragraph of 40+ words with no internal newline.'},
        'note': 'Both are machine screens, not adjudicated prose-drift ratings.',
        'runs': {name: summarize(Path(folder)) for name, folder in
                 (item.split('=', 1) for item in args.runs)},
    }
    write_json(Path(args.out), result)
    print(json.dumps({name: {k: v for k, v in row.items() if k.endswith('_proxy')}
                      for name, row in result['runs'].items()}, indent=2))


if __name__ == '__main__':
    main()
