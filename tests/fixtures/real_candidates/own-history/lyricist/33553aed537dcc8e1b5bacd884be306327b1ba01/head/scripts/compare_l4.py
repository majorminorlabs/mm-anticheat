"""Aggregate fixed-prompt L4 behavior and per-prompt medium/long diagnostics."""
from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path

from scripts.analyze_outputs import analyze
from scripts.behavior_l3 import summarize
from scripts.pipeline import sha, write_json


def compare(runs):
    overview, medium_long = {}, {}
    for name, directory in runs.items():
        directory = Path(directory)
        behavior = summarize(directory)
        shape = analyze(directory / 'generations.jsonl')
        anomaly_ids = {row['id'] for row in shape['per_prompt'] if row['unexpected_section_label']}
        anomaly_ids |= {row['id'] for row in behavior['per_prompt'] if row['word_count'] == 0}
        generations = [json.loads(line) for line in (directory / 'generations.jsonl').read_text().splitlines()]
        for row in generations:
            lines = [line.strip() for line in row['output'].splitlines() if line.strip()]
            if lines and all(re.fullmatch(r'(?i)(?:verse|chorus|bridge)(?:\s+\d+)?\s*:', line) for line in lines):
                anomaly_ids.add(row['id'])
            if re.search(r'(?i)\b(?:your job is|you are given|no words with fewer|here.s an example|no dialogue|make it feel|the first part of the refrain|write a poem|here is|i will write|as an ai)\b', row['output']):
                anomaly_ids.add(row['id'])
        overview[name] = {key: value for key, value in behavior.items() if key != 'per_prompt'}
        overview[name]['length_adherence_rate'] = json.loads((directory / 'summary.json').read_text())['length_adherence_rate']
        overview[name]['format_anomaly_count'] = len(anomaly_ids)
        overview[name]['format_anomaly_ids'] = sorted(anomaly_ids)
        overview[name]['generation_sha256'] = sha((directory / 'generations.jsonl').read_bytes())
        selected = [row for row in behavior['per_prompt'] if row['requested_length'] in ('medium', 'long')]
        categories = {}
        for category in ('medium', 'long'):
            subset = [row for row in selected if row['requested_length'] == category]
            contact = [row['topic_any_first50'] for row in subset if row['topic_any_first50'] is not None]
            categories[category] = {
                'prompts': len(subset),
                'mean_actual_words': round(statistics.mean(row['word_count'] for row in subset), 1),
                'below_minimum_count': sum(row['under_requested_minimum'] for row in subset),
                'premature_stop_proxy_rate': round(statistics.mean(row['under_requested_minimum'] for row in subset), 3),
                'topic_scored_prompts': len(contact),
                'topic_contact_first50_rate': round(statistics.mean(contact), 3),
            }
        contact = [row['topic_any_first50'] for row in selected if row['topic_any_first50'] is not None]
        medium_long[name] = {
            'summary': {'prompts': len(selected),
                        'below_minimum_count': sum(row['under_requested_minimum'] for row in selected),
                        'premature_stop_proxy_rate': round(statistics.mean(row['under_requested_minimum'] for row in selected), 3),
                        'topic_scored_prompts': len(contact),
                        'topic_contact_first50_rate': round(statistics.mean(contact), 3),
                        'mean_actual_words': round(statistics.mean(row['word_count'] for row in selected), 1)},
            'categories': categories,
            'per_prompt': [{key: row[key] for key in ('id', 'requested_length', 'word_count',
                           'under_requested_minimum', 'topic_any_first50', 'topic_full')}
                           for row in selected],
        }
    return overview, medium_long


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runs', nargs='+', required=True, help='NAME=directory')
    p.add_argument('--overview-out', required=True)
    p.add_argument('--medium-long-out', required=True)
    args = p.parse_args()
    runs = dict(item.split('=', 1) for item in args.runs)
    overview, medium_long = compare(runs)
    write_json(Path(args.overview_out), overview)
    write_json(Path(args.medium_long_out), medium_long)
    for name, row in overview.items():
        print(name, {key: row[key] for key in ('length_adherence_rate', 'mean_words',
                                             'under_requested_minimum_count', 'topic_any_first50_rate',
                                             'format_anomaly_count')})


if __name__ == '__main__':
    main()
