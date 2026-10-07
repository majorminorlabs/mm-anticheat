"""Fixed-prompt behavioral proxies shared across B0/L1/L2/L3.

Topic groups are hand-specified paraphrase stems. They provide supporting
evidence, not a semantic-quality or human-preference score.
"""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from scripts.analyze_outputs import analyze
from scripts.evaluate import norm_words
from scripts.pipeline import write_json

# Each inner tuple is one topic concept with acceptable lexical paraphrases.
# A hit means the model mentioned at least one relevant concept; it can still
# misuse that concept or write poor prose. The vague/indirect prompts are null.
TOPICS = {
    'p01': [('home', 'house', 'return', 'back'), ('year', 'decade', 'time', 'long')],
    'p02': [('room', 'door', 'lock', 'inside'), ('sun', 'daylight', 'light', 'bright')],
    'p03': [('friend', 'stranger', 'recogniz', 'remember', 'know')],
    'p04': [('rain', 'wet', 'water'), ('hospital', 'doctor', 'ward', 'patient')],
    'p05': [('promise', 'vow', 'swear'), ('remember', 'forget', 'memory')],
    'p06': [('glass', 'shard'), ('river', 'stream', 'water', 'creek')],
    'p07': None,
    'p08': [('city', 'town', 'street', 'road')],
    'p09': [('apolog', 'sorry', 'forgiv'), ('wait', 'expect')],
    'p10': [('stair', 'step'), ('theater', 'stage', 'seat')],
    'p11': [('concrete', 'cement', 'pavement')],
    'p12': None,
    'p13': [('tooth', 'teeth'), ('garden', 'soil', 'yard')],
    'p14': [('door', 'open'), ('yesterday', 'past', 'before', 'time')],
    'p15': [('leave', 'left', 'go', 'away'), ('stay', 'remain')],
    'p16': [('moth', 'insect', 'wing'), ('exit', 'door', 'light')],
    'p17': [('cloth', 'coat', 'shirt', 'sweater', 'wear'), ('break', 'left', 'leave', 'gone')],
    'p18': [('lighthouse', 'beacon', 'light'), ('water', 'sea', 'ocean', 'dry', 'land')],
    'p19': [('car', 'drive', 'road'), ('argu', 'silent', 'fight', 'quiet')],
    'p20': [('buried', 'under', 'beneath', 'hidden'), ('floor', 'board', 'house')],
    'p21': [('crowd', 'people', 'everyone'), ('turn', 'away', 'reject', 'look')],
    'p22': [('key', 'lock'), ('pocket', 'coat', 'hand')],
    'p23': None,
    'p24': [('greenhouse', 'glass', 'plant'), ('shadow', 'shade', 'dark')],
    'p25': [('train', 'station', 'platform'), ('last', 'after', 'empty', 'gone')],
    'p26': [('dream', 'sleep'), ('smell', 'scent', 'odor')],
    'p27': [('brother', 'sister', 'sibling'), ('riddle', 'question', 'puzzle')],
    'p28': [('bell', 'ring'), ('snow', 'winter', 'cold', 'rust')],
    'p29': None,
    'p30': [('photo', 'picture', 'image'), ('face', 'missing', 'absent')],
    'p31': [('word', 'language', 'speak'), ('space', 'between', 'silence')],
    'p32': [('animal', 'dog', 'wolf', 'deer', 'cat', 'fox'), ('road', 'street', 'drive')],
    'p33': [('clock', 'timepiece', 'watch'), ('collect', 'gather', 'keep', 'pile')],
    'p34': [('morning', 'dawn', 'day'), ('wrong', 'strange', 'different', 'odd')],
    'p35': None,
    'p36': [('bridge', 'crossing'), ('collapse', 'fall', 'broken', 'dusk')],
    'p37': [('gift', 'present'), ('return', 'unopen', 'wrap', 'send')],
    'p38': [('salt', 'brine'), ('mouth', 'tongue', 'taste')],
    'p39': [('name', 'voice', 'call'), ('wall', 'through', 'behind')],
    'p40': [('office', 'building', 'work'), ('light', 'lamp', 'window')],
    'p41': None, 'p42': None, 'p43': None,
    'p44': [('chair', 'seat'), ('beach', 'shore', 'sand', 'sea')],
    'p45': [('coin', 'money', 'change'), ('sink', 'drain', 'basin')],
    'p46': [('plate', 'dish'), ('blue', 'crack', 'broken')],
    'p47': [('number', 'digit', 'paint'), ('shop', 'store', 'closed')],
    'p48': [('dog', 'pet', 'hound'), ('lost', 'missing', 'search')],
    'p49': [('winter', 'snow', 'cold', 'ice')],
    'p50': [('voicemail', 'phone', 'message', 'call'), ('late', 'delay', 'too')],
}


def _has_group(tokens, group):
    return any(any(token.startswith(stem) for token in tokens) for stem in group)


def summarize(directory):
    directory = Path(directory)
    rows = [json.loads(line) for line in (directory / 'generations.jsonl').read_text().splitlines()]
    scored = {r['id']: r for r in (json.loads(line) for line in (directory / 'scored.jsonl').read_text().splitlines())}
    assert len(rows) == 50 and len(scored) == 50
    shape = analyze(directory / 'generations.jsonl')
    contacts, first50_contacts, premature, medium_long, details = [], [], [], [], []
    lower = {'short': 12, 'medium': 35, 'long': 65}
    for row in rows:
        metrics = scored[row['id']]['metrics']
        tokens = norm_words(row['output'])
        groups = TOPICS[row['id']]
        hits = [_has_group(tokens, group) for group in groups] if groups else None
        first50_hits = [_has_group(tokens[:50], group) for group in groups] if groups else None
        shortfall = metrics['word_count'] < lower[row['length']]
        premature.append(shortfall)
        if row['length'] in ('medium', 'long'):
            medium_long.append(shortfall)
        if hits is not None:
            contacts.append(hits)
            first50_contacts.append(first50_hits)
        details.append({'id': row['id'], 'requested_length': row['length'],
                        'word_count': metrics['word_count'], 'under_requested_minimum': shortfall,
                        'topic_group_hits': hits, 'topic_any': any(hits) if hits is not None else None,
                        'topic_full': all(hits) if hits is not None else None,
                        'topic_any_first50': any(first50_hits) if first50_hits is not None else None,
                        'memorization_flag': metrics['memorization_flag']})
    return {'count': len(rows), 'topic_scored_prompts': len(contacts),
            'topic_any_rate': round(sum(any(x) for x in contacts) / len(contacts), 3),
            'topic_full_rate': round(sum(all(x) for x in contacts) / len(contacts), 3),
            'topic_any_first50_rate': round(sum(any(x) for x in first50_contacts) / len(first50_contacts), 3),
            'topic_full_first50_rate': round(sum(all(x) for x in first50_contacts) / len(first50_contacts), 3),
            'under_requested_minimum_count': sum(premature),
            'under_requested_minimum_rate': round(statistics.mean(premature), 3),
            'medium_long_early_stop_count': sum(medium_long),
            'medium_long_early_stop_rate': round(statistics.mean(medium_long), 3),
            'mean_words': round(statistics.mean(len(norm_words(r['output'])) for r in rows), 1),
            'mean_line_words': shape['mean_line_words'],
            'prose_like': shape['prose_like'],
            'generic_phrase_hits': shape['generic_phrase_hits'],
            'meta_instruction_hits': shape['meta_instruction_hits'],
            'unexpected_section_labels': shape['unexpected_section_labels'],
            'empty_outputs': sum(not r['output'].strip() for r in rows),
            'unfinished_tail_count': shape['unfinished_tails'],
            'duplicate_lines': shape['duplicate_lines'],
            'memorization_flags': sum(scored[r['id']]['metrics']['memorization_flag'] for r in rows),
            'max_longest_train_phrase_words': max(scored[r['id']]['metrics']['longest_train_phrase_words'] for r in rows),
            'per_prompt': details}


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--runs', nargs='+', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    result = {Path(run).name: summarize(run) for run in args.runs}
    write_json(Path(args.out), result)
    for name, row in result.items():
        print(name, {k: v for k, v in row.items() if k != 'per_prompt'})


if __name__ == '__main__':
    main()
