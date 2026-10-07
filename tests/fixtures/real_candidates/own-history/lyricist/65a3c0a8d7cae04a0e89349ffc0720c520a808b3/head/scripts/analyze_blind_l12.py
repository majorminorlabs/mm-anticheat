"""Unblind complete L12 judgments with the unchanged L7 scoring rubric."""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path

from scripts.blind_quality_l12 import (DIMENSIONS, JUDGE_MODEL, JUDGE_SEED, RUNS,
                                      PAIR_INSTRUCTIONS, PAIRS, RATING_INSTRUCTIONS,
                                      read_jsonl, valid_pair, valid_rating)
from scripts.evaluate import norm_words
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

RANGES = {'short': (12, 80), 'medium': (35, 150), 'long': (65, 240)}


def stats(values):
    return {'mean': round(statistics.mean(values), 4),
            'median': round(statistics.median(values), 4)}


def composite(scores):
    style = sum(scores[k] for k in 'CDEF') / 4
    utility = sum(scores[k] for k in 'ABCDEFHIJ') / 9 - scores['G'] / 4
    return style, utility


def machine_checks(row):
    text = row['text']
    pid = row['id']
    count = len(norm_words(text))
    lower, upper = RANGES[row['length']]
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    normalized = [' '.join(norm_words(line)) for line in lines]
    repeated = any(value > 1 for value in Counter(normalized).values() if value)
    result = {'word_count': count, 'length_position':
              'under' if count < lower else 'over' if count > upper else 'within'}
    if pid == 'p07':
        result['forbidden_jealous_stem'] = bool(re.search(r'\bjealous\w*\b', text, re.I))
    if pid == 'p48':
        result['verse_and_chorus_label_proxy'] = (
            bool(re.search(r'(?im)^\s*verse\b', text)) and
            bool(re.search(r'(?im)^\s*chorus\b', text)))
    if pid == 'p49':
        result['stanza_count_by_blank_lines'] = len([
            part for part in re.split(r'\n\s*\n', text.strip()) if part.strip()])
    if pid == 'p50':
        result['exact_repeated_line_proxy'] = repeated
    return result


def summarize_group(rows):
    return {'n': len(rows),
            **{key: stats([row['scores'][key] for row in rows]) for key in DIMENSIONS},
            'style': stats([row['style'] for row in rows]),
            'utility': stats([row['utility'] for row in rows]),
            'under_minimum': sum(row['machine']['length_position'] == 'under' for row in rows),
            'over_maximum': sum(row['machine']['length_position'] == 'over' for row in rows),
            'tag_counts': dict(sorted(Counter(tag for row in rows for tag in row['tags']).items()))}


def analyze(root: Path, out: Path):
    packet = read_jsonl(root/'blind_packet.jsonl')
    pair_packet = read_jsonl(root/'blind_pairs.jsonl')
    ratings = read_jsonl(root/'individual_scores.jsonl')
    pair_ratings = read_jsonl(root/'pairwise_scores.jsonl')
    response_count, pair_count = 50 * len(RUNS), 50 * len(PAIRS)
    if (len(packet), len(pair_packet), len(ratings), len(pair_ratings)) != (50, pair_count, response_count, pair_count):
        raise ValueError('All L12 independent and pairwise ratings are required before unblinding')
    manifest = json.loads((root/'build_manifest.json').read_text())
    if sha((ROOT/'outputs/l12-selection.json').read_bytes()) != manifest['selection_sha256']:
        raise ValueError('Pre-blind checkpoint selection changed')
    if sha((root/'blind_packet.jsonl').read_bytes()) != manifest['blind_packet_sha256'] or \
       sha((root/'blind_pairs.jsonl').read_bytes()) != manifest['blind_pairs_sha256']:
        raise ValueError('Blind packet was modified')
    if sha((out/'l7_blind_rubric.md').read_bytes()) != manifest['rubric_sha256'] or \
       sha((out/'l7_prompt_types.json').read_bytes()) != manifest['prompt_types_sha256']:
        raise ValueError('Frozen rubric or prompt-type definitions changed')
    expected = {(r['id'], c['label']): {**r, **c} for r in packet for c in r['candidates']}
    scored = {(r['id'], r['label']): r for r in ratings}
    expected_pairs = {r['pair_id']: r for r in pair_packet}
    scored_pairs = {r['pair_id']: r for r in pair_ratings}
    if (len(expected), len(scored), len(expected_pairs), len(scored_pairs)) != (response_count, response_count, pair_count, pair_count) or \
       set(expected) != set(scored) or set(expected_pairs) != set(scored_pairs):
        raise ValueError('Missing, duplicate, or unknown anonymous score IDs')
    for rating in ratings:
        valid_rating(rating['result'])
        entry = expected[(rating['id'], rating['label'])]
        payload = {'prompt': entry['prompt'], 'requested_length': entry['length'],
                   'form': entry.get('form'), 'response': entry['text']}
        prompt = RATING_INSTRUCTIONS + '\n\nITEM:\n' + json.dumps(payload, ensure_ascii=False)
        if hashlib.sha256(prompt.encode()).hexdigest() != rating['input_sha256']:
            raise ValueError('Anonymous rating input hash mismatch')
    for rating in pair_ratings:
        valid_pair(rating['result'])
        entry = expected_pairs[rating['pair_id']]
        payload = {'prompt': entry['prompt'], 'requested_length': entry['length'],
                   'form': entry.get('form'), 'A': entry['A'], 'B': entry['B']}
        prompt = PAIR_INSTRUCTIONS + '\n\nITEM:\n' + json.dumps(payload, ensure_ascii=False)
        if hashlib.sha256(prompt.encode()).hexdigest() != rating['input_sha256']:
            raise ValueError('Anonymous pairwise input hash mismatch')

    # Identity keys are opened only after complete-score validation above.
    answer = json.loads((root/'answer_key.json').read_text())
    pair_key = json.loads((root/'pair_answer_key.json').read_text())
    prompt_types = {r['id']: r for r in json.loads((out/'l7_prompt_types.json').read_text())['rows']}
    if set(prompt_types) != {r['id'] for r in packet}:
        raise ValueError('Prompt-type IDs changed')
    individual, machine_rows = [], []
    for key, item in expected.items():
        rating = scored[key]
        label = item['label']
        name = answer[item['id']][label]
        scores = rating['result']['scores']
        style, utility = composite(scores)
        machine = machine_checks(item)
        individual.append({'id': item['id'], 'model': name, 'scores': scores,
                           'style': style, 'utility': utility,
                           'tags': rating['result']['tags'],
                           'evidence': rating['result']['evidence'],
                           'machine': machine})
        machine_rows.append({'id': item['id'], 'label': label, **machine})
    write_jsonl(out/'l12_machine_constraints.jsonl', machine_rows)
    grouped = defaultdict(list)
    for row in individual:
        grouped[row['model']].append(row)
    models = {name: summarize_group(rows) for name, rows in sorted(grouped.items())}
    rankings = {metric: sorted(models, key=lambda name: models[name][metric]['mean'], reverse=True)
                for metric in ('style', 'utility', 'J')}
    practical_ties = {metric: [
        [left, right] for index, left in enumerate(rankings[metric])
        for right in rankings[metric][index + 1:]
        if abs(models[left][metric]['mean'] - models[right][metric]['mean']) < 0.05]
        for metric in rankings}
    write_json(out/'l12_model_scores.json', {
        'method': 'One local blind model judge; 0-4 dimensions, predeclared composites; not human ratings.',
        'judge_model': JUDGE_MODEL, 'judge_seed': JUDGE_SEED,
        'response_count': len(individual), 'models': models, 'rankings': rankings,
        'practical_ties_under_0_05': practical_ties,
        'scoring_retries': sum(r['attempts'] - 1 for r in ratings),
    })

    pair_summary = {f'{a} vs {b}': {'first_wins': 0, 'ties': 0, 'second_wins': 0,
                                   'first_clear': 0, 'second_clear': 0,
                                   'reason_counts': Counter()}
                    for a, b in PAIRS}
    pair_detail = []
    for pid, record in expected_pairs.items():
        a, b = pair_key[pid]['A'], pair_key[pid]['B']
        logical = next((left, right) for left, right in PAIRS if {left, right} == {a, b})
        title = f'{logical[0]} vs {logical[1]}'
        outcome = scored_pairs[pid]['result']['outcome']
        winner = None if outcome == 'tie' else a if outcome.startswith('A ') else b
        if winner is None:
            pair_summary[title]['ties'] += 1
        elif winner == logical[0]:
            pair_summary[title]['first_wins'] += 1
            pair_summary[title]['first_clear'] += 'clearly' in outcome
        else:
            pair_summary[title]['second_wins'] += 1
            pair_summary[title]['second_clear'] += 'clearly' in outcome
        pair_summary[title]['reason_counts'].update(scored_pairs[pid]['result']['reasons'])
        pair_detail.append({'id': record['id'], 'pair_id': pid, 'first': logical[0],
                            'second': logical[1], 'winner': winner, 'strength': outcome,
                            'reasons': scored_pairs[pid]['result']['reasons']})
    for value in pair_summary.values():
        value['reason_counts'] = dict(sorted(value['reason_counts'].items()))
    write_json(out/'l12_pairwise_summary.json', {
        'pair_count': len(pair_detail), 'pairs': pair_summary,
        'scoring_retries': sum(r['attempts'] - 1 for r in pair_ratings),
        'per_prompt': pair_detail})

    regimes = {
        'length': {'short': lambda p: p['length'] == 'short',
                   'medium': lambda p: p['length'] == 'medium',
                   'long': lambda p: p['length'] == 'long'},
        'prompt_class': {'sparse': lambda p: p['prompt_class'] == 'sparse',
                         'descriptive': lambda p: p['prompt_class'] == 'descriptive'},
        'imagery_type': {'concrete': lambda p: p['concrete_imagery'],
                         'abstract_vague': lambda p: p['abstract_vague']},
        'explicit_constraint': {'yes': lambda p: p['explicit_constraint'],
                                'no': lambda p: not p['explicit_constraint']},
        'refrain_or_structural': {'yes': lambda p: p['refrain_or_structural'],
                                 'no': lambda p: not p['refrain_or_structural']},
    }
    breakdown = {}
    for regime, members in regimes.items():
        breakdown[regime] = {}
        for member, predicate in members.items():
            breakdown[regime][member] = {name: summarize_group([
                row for row in rows if predicate(prompt_types[row['id']])])
                for name, rows in sorted(grouped.items())}
    write_json(out/'l12_prompt_type_breakdown.json', breakdown)

    taxonomy = {'total_responses': len(individual),
                'judge_tags_all': dict(sorted(Counter(
                    tag for row in individual for tag in row['tags']).items())),
                'judge_tags_by_model': {name: dict(sorted(Counter(
                    tag for row in rows for tag in row['tags']).items()))
                    for name, rows in sorted(grouped.items())},
                'dimension_cross_checks_by_model': {},
                'machine_checks_by_model': {}}
    for name, rows in sorted(grouped.items()):
        taxonomy['dimension_cross_checks_by_model'][name] = {
            'substantial_prose_drift_G_ge_3': sum(r['scores']['G'] >= 3 for r in rows),
            'strongly_unfinished_I_le_1': sum(r['scores']['I'] <= 1 for r in rows),
            'weak_subject_contact_A_le_1': sum(r['scores']['A'] <= 1 for r in rows),
            'strong_imagery_poor_contact_C_ge_3_A_le_1': sum(
                r['scores']['C'] >= 3 and r['scores']['A'] <= 1 for r in rows),
            'good_contact_generic_A_ge_3_G_ge_3_or_J_le_1': sum(
                r['scores']['A'] >= 3 and
                (r['scores']['G'] >= 3 or r['scores']['J'] <= 1) for r in rows),
        }
        taxonomy['machine_checks_by_model'][name] = {
            'under_minimum': sum(r['machine']['length_position'] == 'under' for r in rows),
            'over_maximum': sum(r['machine']['length_position'] == 'over' for r in rows),
            'p07_forbidden_jealous_stem': sum(r['machine'].get('forbidden_jealous_stem', False) for r in rows),
            'p48_missing_verse_chorus_label_proxy': sum(
                r['machine'].get('verse_and_chorus_label_proxy') is False for r in rows),
            'p49_not_single_stanza_proxy': sum(
                r['machine'].get('stanza_count_by_blank_lines', 1) != 1 for r in rows),
            'p50_no_exact_repeated_line_proxy': sum(
                r['machine'].get('exact_repeated_line_proxy') is False for r in rows),
        }
    write_json(out/'l12_failure_taxonomy.json', taxonomy)
    write_json(out/'l12_analysis_manifest.json', {
        'rubric_sha256': manifest['rubric_sha256'],
        'blind_packet_sha256': manifest['blind_packet_sha256'],
        'blind_pairs_sha256': manifest['blind_pairs_sha256'],
        'individual_scores_sha256': sha((root/'individual_scores.jsonl').read_bytes()),
        'pairwise_scores_sha256': sha((root/'pairwise_scores.jsonl').read_bytes()),
        'answer_key_sha256': sha((root/'answer_key.json').read_bytes()),
        'pair_answer_key_sha256': sha((root/'pair_answer_key.json').read_bytes()),
        'response_count': response_count, 'pair_count': pair_count,
    })
    print(f'Unblinded {response_count} complete response ratings and {pair_count} pairwise ratings')
    print('Utility ranking:', rankings['utility'])
    print('Overall ranking:', rankings['J'])


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--blind', required=True)
    p.add_argument('--out', required=True)
    args = p.parse_args()
    analyze(Path(args.blind), Path(args.out))


if __name__ == '__main__':
    main()
