"""Build private L1/L6/L9 fixed-50 review packet with a separate key."""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

from scripts.audit_l8_constraints import RULES
from scripts.pipeline import write_json, write_jsonl


def load(path):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
    if len(rows) != 50 or len({row['id'] for row in rows}) != 50:
        raise ValueError('Expected 50 unique fixed prompt generations')
    return {row['id']: row for row in rows}


def build(runs):
    ids = set(next(iter(runs.values())))
    if any(set(run) != ids for run in runs.values()):
        raise ValueError('Fixed prompt IDs differ')
    rng = random.Random(314168)
    packet, key = [], {}
    for pid in sorted(ids):
        reference = next(iter(runs.values()))[pid]
        if any(run[pid]['prompt'] != reference['prompt'] or run[pid]['length'] != reference['length']
               for run in runs.values()):
            raise ValueError(f'Prompt mismatch {pid}')
        order = list(runs)
        rng.shuffle(order)
        packet.append({'id': pid, 'prompt': reference['prompt'], 'length': reference['length'],
                       'form': reference.get('form'),
                       **{letter: runs[name][pid]['output'] for letter, name in zip('ABC', order)}})
        key[pid] = dict(zip('ABC', order))
    return packet, key


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--l1', required=True)
    p.add_argument('--l6', required=True)
    p.add_argument('--l9', required=True)
    p.add_argument('--l9-name', default='L9-40')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    packet, key = build({'L1-48': load(args.l1), 'L6-40': load(args.l6), args.l9_name: load(args.l9)})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / 'review_packet.jsonl', packet)
    write_jsonl(out / 'constraint_subset.jsonl', [row for row in packet if row['id'] in RULES])
    write_json(out / 'answer_key.json', key)
    (out / 'README.md').write_text(
        '# L9 blind review packet\n\n'
        'Read `review_packet.jsonl` or the 17-prompt `constraint_subset.jsonl` before opening '
        '`answer_key.json`. A, B, and C are shuffled independently per prompt. '
        'Use `corpus/metadata/l7_blind_rubric.md` for imagery, phrasing, cadence, ambiguity, '
        'contact, constraints, prose drift, coherence, and completeness. '
        'No independent human scores have been collected.\n')
    print(f'{len(packet)} blinded prompts; {len(RULES)}-prompt constraint subset')


if __name__ == '__main__':
    main()
