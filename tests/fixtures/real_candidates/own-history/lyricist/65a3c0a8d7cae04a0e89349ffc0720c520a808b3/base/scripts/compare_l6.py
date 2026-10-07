"""Aggregate L6 and historical fixed-prompt behavior with EOS diagnostics."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.compare_l4 import compare
from scripts.compare_l5 import format_anomaly_ids, length_breakdown
from scripts.pipeline import write_json


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
        raise ValueError('Fixed prompts changed across comparison runs')
    generation_settings = {name: json.dumps(json.loads((Path(directory)/'run.json').read_text())['generation'], sort_keys=True)
                           for name, directory in runs.items()}
    if len(set(generation_settings.values())) != 1:
        raise ValueError('Generation settings changed across comparison runs')
    eos = {}
    for name, directory in runs.items():
        path = Path(directory)/'eos_diagnostics.json'
        if path.exists():
            eos[name] = json.loads(path.read_text())
    result = {'fixed_prompt_sha256': next(iter(prompt_hashes.values())),
              'generation_settings': json.loads(next(iter(generation_settings.values()))),
              'overview': overview, 'medium_long': medium_long,
              'per_length': per_length, 'eos': eos,
              'notes': {'below_minimum': 'Short <12, medium <35, long <65 words; proxy for premature stopping.',
                        'topic_contact': 'Any hand-specified concept stem in first 50 words on 42/50 prompts.',
                        'format_anomaly': 'Empty, label-only, unexpected section label, or anchored instruction phrase.',
                        'unfinished_tail': 'Output ending in alphanumeric character; can also be a valid lyric ending.',
                        'eos_probability': 'Raw model softmax on the sampled continuation at reached positions; conditional on reaching that position.'}}
    write_json(Path(args.out), result)
    for name, row in overview.items():
        print(name, {key: row[key] for key in ('length_adherence_rate','mean_words','mean_line_words',
                                              'under_requested_minimum_count','medium_long_early_stop_count',
                                              'topic_any_first50_rate','format_anomaly_count')},
              'eos', {key: eos[name][key] for key in ('mean_generated_output_tokens','eos_emitted_rate',
                                                      'mean_first_eos_position_when_emitted')}
              if name in eos else None)


if __name__ == '__main__':
    main()
