"""Private randomized four-way L1/L3/L4 fixed-prompt review packet."""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from scripts.pipeline import write_json, write_jsonl


def load(path):
    return {row['id']: row for row in (json.loads(line) for line in Path(path).read_text().splitlines())}


def main():
    p = argparse.ArgumentParser()
    for name in ('l1', 'l3_25', 'l3_50', 'l4'):
        p.add_argument(f'--{name}', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    runs = {'L1-48': load(args.l1), 'L3-25': load(args.l3_25),
            'L3-50': load(args.l3_50), 'L4': load(args.l4)}
    ids = set(runs['L1-48'])
    if len(ids) != 50 or any(set(run) != ids for run in runs.values()):
        raise ValueError('Four runs must contain the same 50 prompt IDs')
    rng = random.Random(314164)
    packet, key = [], {}
    for pid in sorted(ids):
        prompt = runs['L1-48'][pid]['prompt']
        if any(run[pid]['prompt'] != prompt for run in runs.values()):
            raise ValueError(f'Prompt changed: {pid}')
        order = list(runs)
        rng.shuffle(order)
        letters = 'ABCD'
        packet.append({'id': pid, 'prompt': prompt,
                       **{letter: runs[name][pid]['output'] for letter, name in zip(letters, order)}})
        key[pid] = dict(zip(letters, order))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / 'review_packet.jsonl', packet)
    write_json(out / 'answer_key.json', key)
    (out / 'rubric.md').write_text('''# Blind L1-48 / L3-25 / L3-50 / L4 review

Read A–D before opening the separate answer key. Rate each 1–5 for style resemblance, unusual phrasing, imagery, cadence, ambiguity, prompt contact, completeness, originality, and overall preference. Note generic explanatory prose, malformed text, or copying concerns. No human scores are implied by this packet.
''')
    print(f'{len(packet)} blinded prompts')


if __name__ == '__main__':
    main()
