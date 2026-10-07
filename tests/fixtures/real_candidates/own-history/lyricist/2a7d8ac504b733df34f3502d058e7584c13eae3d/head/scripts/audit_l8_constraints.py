"""Predeclared fixed-prompt constraint audit and deterministic proxies."""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json

RULES = {
    'p02': ('spatial_relation', 'Room remains locked while light enters it.'),
    'p03': ('indirect_exclusion', 'Old friend remains unrecognized; no confirmed recognition.'),
    'p04': ('spatial_relation', 'Rain occurs inside the hospital, not just outside it.'),
    'p07': ('lexical_prohibition', 'Jealousy is implied without jealous/jealousy/jealously.'),
    'p15': ('spatial_relation', 'Both wanting to leave and wanting to stay are present.'),
    'p18': ('spatial_relation', 'Lighthouse is far from water; no sea/coast/shore location.'),
    'p19': ('indirect_exclusion', 'Argument in car remains silent; no spoken exchange.'),
    'p20': ('spatial_relation', 'Something is buried under the floor.'),
    'p21': ('spatial_relation', 'Crowd turns away from subject.'),
    'p25': ('spatial_relation', 'Station scene occurs after the last train.'),
    'p30': ('indirect_exclusion', 'One face is absent from photograph.'),
    'p32': ('spatial_relation', 'Animal watches from road rather than another location.'),
    'p37': ('indirect_exclusion', 'Gift remains unopened when returned.'),
    'p39': ('spatial_relation', 'Name is heard through a wall.'),
    'p48': ('structure_refrain', 'Response has recognizable verse and chorus.'),
    'p49': ('structure_refrain', 'Response is a single stanza.'),
    'p50': ('structure_refrain', 'Response has a recognizable repeated refrain.'),
}
FORBIDDEN_P07 = re.compile(r'\bjealous(?:y|ies|ly)?\b', re.IGNORECASE)
SEA_P18 = re.compile(r'\b(?:sea|ocean|shore|coast|beach|harbor|harbour|wave|waves|tide|tides)\b', re.IGNORECASE)


def proxies(pid, output):
    text = output.strip()
    result = {'nonempty': bool(text)}
    if pid == 'p07':
        result['forbidden_forms'] = FORBIDDEN_P07.findall(text)
        result['lexical_pass'] = bool(text) and not result['forbidden_forms']
    if pid == 'p18':
        result['water_terms_needing_context_review'] = SEA_P18.findall(text)
    if pid == 'p49':
        result['blank_line_stanza_breaks'] = len(re.findall(r'\n\s*\n', text))
    if pid == 'p50':
        lines = [x.strip().casefold() for x in text.splitlines() if x.strip()]
        result['exact_repeated_lines'] = sorted({line for line in lines if lines.count(line) > 1})
    if pid == 'p48':
        result['verse_label'] = bool(re.search(r'(?im)^\s*(?:\[)?verse\b', text))
        result['chorus_label'] = bool(re.search(r'(?im)^\s*(?:\[)?chorus\b', text))
    return result


def make_packet(runs):
    fixed = json.loads((ROOT / 'data/eval/prompts.json').read_text())
    prompts = {x['id']: x for x in fixed}
    records = []
    hashes = {}
    for name, directory in runs.items():
        directory = Path(directory)
        manifest = json.loads((directory / 'run.json').read_text())
        hashes[name] = manifest['prompts_sha256']
        generations = {r['id']: r for r in (json.loads(line) for line in (directory / 'generations.jsonl').read_text().splitlines())}
        for pid, (typ, criterion) in RULES.items():
            output = generations[pid]['output']
            records.append({'model': name, 'id': pid, 'type': typ, 'prompt': prompts[pid]['prompt'],
                            'criterion': criterion, 'output': output, 'proxies': proxies(pid, output),
                            'internal_review': 'PENDING', 'review_note': ''})
    expected = sha((ROOT / 'data/eval/prompts.json').read_bytes())
    if set(hashes.values()) != {expected}:
        raise ValueError(f'Fixed prompt hash mismatch: {hashes}')
    return {'fixed_prompt_sha256': expected,
            'rules': {pid: {'type': typ, 'criterion': criterion} for pid, (typ, criterion) in RULES.items()},
            'runs': list(runs), 'records': records}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runs', nargs='+', required=True, help='NAME=directory')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    packet = make_packet(dict(item.split('=', 1) for item in args.runs))
    write_json(Path(args.out), packet)
    print(json.dumps({'runs': packet['runs'], 'constrained_prompt_count': len(RULES),
                      'by_type': {typ: sum(value[0] == typ for value in RULES.values())
                                  for typ in sorted({v[0] for v in RULES.values()})}}))


if __name__ == '__main__':
    main()
