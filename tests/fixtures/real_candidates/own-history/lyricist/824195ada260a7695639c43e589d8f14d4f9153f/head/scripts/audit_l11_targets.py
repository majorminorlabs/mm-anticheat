"""Audit every existing train target without changing its text or split."""
from __future__ import annotations

import argparse
import json
import re
import statistics
from collections import Counter
from pathlib import Path

from scripts.build_l2 import source_sections
from scripts.build_l3 import BAD_TAIL
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

WORD = re.compile(r"[\w']+", re.UNICODE)
EXPOSITION = re.compile(r'\b(?:because|therefore|in other words|the reason|this means|i remember|there was|then i)\b', re.I)
DIALOGUE = re.compile(r'(^\s*[-–—]\s|[“”"].+[“”"]|^\s*\w+\s*:\s+)', re.M)


def tokens(value: str) -> list[str]:
    return WORD.findall(value.casefold())


def metrics(row: dict, source_lines: list[str]) -> dict:
    text = row['target']
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    counts = [len(tokens(line)) for line in lines]
    normalized = [' '.join(tokens(line)) for line in lines]
    tail = tokens(lines[-1])[-1] if lines and tokens(lines[-1]) else ''
    end = row['source_line_end']
    following = source_lines[end].strip() if end < len(source_lines) else ''
    boundary = end == len(source_lines) or not following or bool(re.fullmatch(r'\[[^]]+\]', following))
    return {
        'id': row['id'], 'work_id': row['work_id'], 'target_sha256': row['target_sha256'],
        'prompt_sha256': sha(row['prompt'].encode()), 'length_bucket': row['length_bucket'],
        'source_line_start': row['source_line_start'], 'source_line_end': end,
        'word_count': sum(counts), 'line_count': len(lines),
        'mean_words_per_line': round(statistics.mean(counts), 3),
        'median_words_per_line': statistics.median(counts),
        'max_line_words': max(counts),
        'stanza_count': len([part for part in re.split(r'\n\s*\n', text.strip()) if part.strip()]),
        'repeated_line_fraction': round(1 - len(set(normalized)) / len(normalized), 4),
        'natural_source_end_boundary_proxy': boundary,
        'dangling_terminal_proxy': tail in BAD_TAIL or bool(re.search(r'[,;:]\s*$', text)),
        'dialogue_heavy_proxy': sum(bool(DIALOGUE.search(line)) for line in lines) / len(lines) >= .3,
        'narrative_expository_proxy': bool(EXPOSITION.search(text)),
        'prose_paragraph_proxy': (sum(count >= 25 for count in counts) >= 2 or
                                  (len(lines) <= 3 and any(count >= 25 for count in counts))),
    }


def audit(out: Path) -> dict:
    rows = [json.loads(line) for line in (ROOT/'data/l5/train.jsonl').read_text().splitlines()]
    manifest = {r['work_id']: r for r in json.loads((ROOT/'corpus/metadata/manifest.json').read_text())}
    if len(rows) != 224 or len({r['id'] for r in rows}) != 224 or len({r['target_sha256'] for r in rows}) != 224:
        raise ValueError('Expected 224 unique L5 train targets')
    source_cache = {}
    records = []
    for row in rows:
        work = manifest[row['work_id']]
        if row['split'] != work['split'] or work['split'] != 'train' or row['source_sha256'] != work['source_sha256']:
            raise ValueError(f'Train-only source provenance failed: {row["id"]}')
        if row['target_sha256'] != sha(row['target'].encode()):
            raise ValueError(f'Target SHA failed: {row["id"]}')
        if row['source_path'] not in source_cache:
            _, source_lines = source_sections(ROOT/row['source_path'])
            source_cache[row['source_path']] = source_lines
        source_lines = source_cache[row['source_path']]
        source_text = '\n'.join(line.rstrip() for line in
                                source_lines[row['source_line_start'] - 1:row['source_line_end']])
        if source_text != row['target']:
            raise ValueError(f'Target differs from contiguous source lines: {row["id"]}')
        record = metrics(row, source_lines)
        record['style_anchor'] = bool(work['style_anchor'])
        records.append(record)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'audit.jsonl', records)
    result = {
        'source_l5_sha256': sha((ROOT/'data/l5/train.jsonl').read_bytes()),
        'manifest_sha256': sha((ROOT/'corpus/metadata/manifest.json').read_bytes()),
        'candidate_count': len(rows), 'train_works': len({r['work_id'] for r in records}),
        'style_anchor_work_count': len({r['work_id'] for r in records if r['style_anchor']}),
        'length_bucket_counts': dict(sorted(Counter(r['length_bucket'] for r in records).items())),
        'natural_end_boundary_count': sum(r['natural_source_end_boundary_proxy'] for r in records),
        'dangling_terminal_proxy_count': sum(r['dangling_terminal_proxy'] for r in records),
        'prose_paragraph_proxy_count': sum(r['prose_paragraph_proxy'] for r in records),
        'dialogue_heavy_proxy_count': sum(r['dialogue_heavy_proxy'] for r in records),
        'narrative_expository_proxy_count': sum(r['narrative_expository_proxy'] for r in records),
        'audit_sha256': sha((out/'audit.jsonl').read_bytes()),
        'source_era_metadata_available': False,
    }
    write_json(ROOT/'corpus/metadata/l11_candidate_audit.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=ROOT/'outputs/l11-candidates')
    args = parser.parse_args()
    print(json.dumps(audit(args.out), indent=2))
