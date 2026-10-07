"""Private deterministic 50-prompt L1/L2/L3 blind review packet."""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from scripts.pipeline import write_json, write_jsonl


def read(path):
    return {r['id']: r for r in (json.loads(line) for line in Path(path).read_text().splitlines())}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--l1', required=True)
    p.add_argument('--l2', required=True)
    p.add_argument('--l3', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    runs = {'L1': read(args.l1), 'L2-50': read(args.l2), 'L3': read(args.l3)}
    ids = set(runs['L1'])
    if len(ids) != 50 or any(set(run) != ids for run in runs.values()):
        raise ValueError('The three runs must contain the same fixed 50 prompts')
    rng = random.Random(314163)
    packet, key = [], {}
    for pid in sorted(ids):
        prompt = runs['L1'][pid]['prompt']
        if any(run[pid]['prompt'] != prompt for run in runs.values()):
            raise ValueError(f'Prompt changed: {pid}')
        order = list(runs)
        rng.shuffle(order)
        packet.append({'id': pid, 'prompt': prompt,
                       'A': runs[order[0]][pid]['output'],
                       'B': runs[order[1]][pid]['output'],
                       'C': runs[order[2]][pid]['output']})
        key[pid] = {'A': order[0], 'B': order[1], 'C': order[2]}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / 'review_packet.jsonl', packet)
    write_json(out / 'answer_key.json', key)
    (out / 'rubric.md').write_text('''# Blind L1/L2-50/L3 comparison

Read A, B, and C for each prompt before opening `answer_key.json`. Rate each 1–5 for resemblance to the target corpus style, unusual phrasing, imagery, cadence, ambiguity, prompt contact, completeness, originality, and overall preference. Note malformed text or copying concerns. Source lyrics are not included. No human scores are implied by this packet.
''')
    print(f'{len(packet)} blinded prompts')


if __name__ == '__main__':
    main()
