"""Private randomized three-way L1/L4/L5 packet with separate answer key."""
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
    for name in ('l1', 'l4', 'l5'):
        p.add_argument(f'--{name}', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    runs = {'L1-48': load(args.l1), 'L4-35': load(args.l4), 'L5': load(args.l5)}
    ids = set(runs['L1-48'])
    if len(ids) != 50 or any(set(run) != ids for run in runs.values()):
        raise ValueError('All three runs must contain the same 50 fixed prompts')
    rng = random.Random(314165)
    packet, key = [], {}
    for pid in sorted(ids):
        prompt = runs['L1-48'][pid]['prompt']
        length = runs['L1-48'][pid]['length']
        if any(run[pid]['prompt'] != prompt or run[pid]['length'] != length for run in runs.values()):
            raise ValueError(f'Prompt or length changed: {pid}')
        order = list(runs)
        rng.shuffle(order)
        packet.append({'id': pid, 'prompt': prompt, 'length': length,
                       **{letter: runs[name][pid]['output'] for letter, name in zip('ABC', order)}})
        key[pid] = dict(zip('ABC', order))
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'review_packet.jsonl', packet)
    write_json(out/'answer_key.json', key)
    (out/'rubric.md').write_text('''# Blind L1 / L4 / L5 review

Read A–C before opening the separate answer key. Rate each 1–5 for style resemblance, unusual phrasing, imagery, cadence, ambiguity, prompt contact, completeness, originality, and overall preference. Note generic explanatory prose, malformed text, or copying concerns. No human scores are implied by this packet.
''')
    print(f'{len(packet)} blinded prompts')


if __name__ == '__main__':
    main()
