"""All-baseline L5 comparison and requested-length breakdown."""
from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path

from scripts.analyze_outputs import analyze_row
from scripts.behavior_l3 import TOPICS, _has_group
from scripts.compare_l4 import compare
from scripts.evaluate import norm_words
from scripts.pipeline import sha, write_json

RANGES = {'very short': (None, None), 'short': (12, 80),
          'medium': (35, 150), 'long': (65, 240)}


def format_anomaly_ids(directory):
    rows = [json.loads(line) for line in (Path(directory)/'generations.jsonl').read_text().splitlines()]
    flagged = set()
    for row in rows:
        value = row['output']
        lines = [line.strip() for line in value.splitlines() if line.strip()]
        label_only = bool(lines) and all(re.fullmatch(r'(?i)(?:verse|chorus|bridge)(?:\s+\d+)?\s*:', line)
                                         for line in lines)
        instruction = bool(re.search(r"(?im)^\s*(?:[-*]\s*)?(?:no dialogue|make it feel|here(?:'s| is) an example|the first part of the (?:refrain|request)|as an ai|i will write|this passage has|original text:|write a poem)\b", value))
        unexpected_label = analyze_row(row)['unexpected_section_label']
        if not value.strip() or label_only or instruction or unexpected_label:
            flagged.add(row['id'])
    return sorted(flagged)


def length_breakdown(directory, anomaly_ids):
    directory = Path(directory)
    rows = [json.loads(x) for x in (directory/'generations.jsonl').read_text().splitlines()]
    scored = {x['id']: x for x in (json.loads(line) for line in (directory/'scored.jsonl').read_text().splitlines())}
    categories = {}
    for length, (lo, hi) in RANGES.items():
        subset = [row for row in rows if row['length'] == length]
        if not subset:
            categories[length] = {'prompt_count': 0, 'note': 'No fixed prompts request this length; metrics unavailable.'}
            continue
        words = [scored[row['id']]['metrics']['word_count'] for row in subset]
        contacts = []
        unfinished = []
        for row in subset:
            tokens = norm_words(row['output'])
            groups = TOPICS[row['id']]
            if groups:
                contacts.append(any(_has_group(tokens[:50], group) for group in groups))
            shape = analyze_row(row)
            unfinished.append(shape['unfinished_tail'])
        categories[length] = {
            'prompt_count': len(subset),
            'adherence_rate': round(sum(lo <= n <= hi for n in words)/len(words), 3),
            'mean_words': round(statistics.mean(words), 1),
            'median_words': statistics.median(words),
            'below_minimum_count': sum(n < lo for n in words),
            'above_maximum_count': sum(n > hi for n in words),
            'topic_scored_prompts': len(contacts),
            'topic_contact_first50_rate': round(statistics.mean(contacts), 3) if contacts else None,
            'malformed_proxy_count': sum(row['id'] in anomaly_ids for row in subset),
            'unfinished_tail_proxy_count': sum(unfinished),
        }
    return categories


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runs', nargs='+', required=True, help='NAME=directory')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    runs = dict(item.split('=', 1) for item in args.runs)
    overview, medium_long = compare(runs)
    for name, directory in runs.items():
        ids = format_anomaly_ids(directory)
        overview[name]['format_anomaly_count'] = len(ids)
        overview[name]['format_anomaly_ids'] = ids
    per_length = {name: length_breakdown(directory, set(overview[name]['format_anomaly_ids']))
                  for name, directory in runs.items()}
    prompt_hashes = {name: json.loads((Path(directory)/'run.json').read_text())['prompts_sha256']
                     for name, directory in runs.items()}
    if len(set(prompt_hashes.values())) != 1:
        raise ValueError('Fixed evaluation prompt hashes differ')
    result = {'fixed_prompt_sha256': next(iter(prompt_hashes.values())),
              'fixed_length_counts': {k: v['prompt_count'] for k, v in next(iter(per_length.values())).items()},
              'overview': overview, 'per_length': per_length,
              'medium_long': medium_long,
              'measurement_notes': {
                  'topic_contact': 'Any hand-specified concept stem in first 50 words; 42/50 fixed prompts scored.',
                  'premature_stop': 'Word count below fixed length minimum; proxy, not an EOS diagnosis.',
                  'unfinished_tail': 'Output ending in an alphanumeric character; may also be a valid line ending.',
                  'malformed': 'Empty output, anchored instruction phrase, unexpected section label, or label-only skeleton.'}}
    write_json(Path(args.out), result)
    for name, row in overview.items():
        print(name, {k: row[k] for k in ('length_adherence_rate','mean_words','under_requested_minimum_count',
                                        'medium_long_early_stop_count','topic_any_first50_rate',
                                        'duplicate_lines','format_anomaly_count')})


if __name__ == '__main__':
    main()
