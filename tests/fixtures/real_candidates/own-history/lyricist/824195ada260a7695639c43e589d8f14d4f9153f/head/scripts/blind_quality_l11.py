"""Build and score the private five-way L11 packet with the frozen L7 rubric."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
import urllib.request
from pathlib import Path

from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

RUNS = {
    'B0': 'outputs/b0',
    'L1-48': 'outputs/l1-eval-048',
    'L6-40': 'outputs/l6-eval-040',
    'C2-40': 'outputs/l10-c2-best-eval',
    'L11': 'outputs/l11-best-eval',
}
PAIRS = (('L1-48', 'L11'), ('L6-40', 'L11'),
         ('C2-40', 'L11'), ('B0', 'L11'))
PACKET_SEED = 314182
PAIR_SEED = 314183
JUDGE_SEED = 314167
JUDGE_MODEL = 'mistral-small3.2:24b'
DIMENSIONS = 'ABCDEFGHIJ'
TAGS = {
    'generic_prose', 'premature_stopping', 'prompt_subject_miss',
    'explicit_contradiction', 'forbidden_word_violation', 'structure_failure',
    'refrain_failure', 'excessive_literalness', 'incoherent_abstraction',
    'generic_cliche', 'repetition', 'malformed_output',
    'assistant_editor_meta', 'strong_imagery_poor_contact',
    'good_contact_generic_writing',
}
PAIR_OUTCOMES = {
    'A clearly better', 'A slightly better', 'tie',
    'B slightly better', 'B clearly better',
}
PAIR_REASONS = {
    'imagery', 'phrasing', 'cadence', 'prompt-fit', 'constraint',
    'completeness', 'prose-drift', 'coherence', 'originality',
}

RATING_INSTRUCTIONS = '''You are a blind, independent creative-writing evaluator. Do not guess model identity. Score ONLY the response below against its prompt. Return one JSON object, no markdown.
All A-J ratings must be integers 0-4. A prompt contact: 0 unrelated, 1 weak, 2 partial, 3 clear, 4 strongly grounded without parroting. B constraint following: 0 major requirements ignored, 1 several failures, 2 mixed, 3 mostly follows, 4 essentially all important requirements. C imagery: 0 none, 1 generic, 2 some specific, 3 strong concrete/unusual, 4 highly distinctive and useful. D phrasing: 0 plain, 1 conventional, 2 occasional unusual, 3 consistently distinctive, 4 striking without incoherence. E cadence/line behavior: 0 prose dumped into lines or malformed, 1 mostly prose, 2 mixed, 3 deliberate rhythm/line behavior, 4 unusually effective. F ambiguity/indirectness: 0 literal/explanatory, 1 mostly explicit, 2 some indirectness, 3 effective ambiguity, 4 strongly suggestive and compelling. G is a PENALTY for prose drift: 0 none, 1 slight, 2 noticeable, 3 substantial, 4 mostly ordinary narrative/explanation. H coherence: 0 incoherent, 1 fragmented, 2 mixed, 3 sustained, 4 coherent with interesting ambiguity. I completeness: 0 broken/truncated, 1 strongly unfinished, 2 questionable, 3 acceptable ending, 4 intentional complete ending. J overall CREATIVE quality: 0 unusable, 1 poor, 2 mediocre, 3 good, 4 excellent. Do not use length alone for J. A refrain requires a recurring phrase, not growth unless asked. Judge explicit facts, negations, situation, length and structure for B. Do not reward mere prompt repetition as strong contact.
Use zero or more failure tags, only when supported: generic_prose (substantial ordinary prose); premature_stopping (obvious fragment or too short to develop); prompt_subject_miss (subject largely absent); explicit_contradiction (directly reverses a prompt fact); forbidden_word_violation (names a forbidden concept); structure_failure (requested structure absent); refrain_failure (requested refrain absent); excessive_literalness (explains/paraphrases prompt); incoherent_abstraction (associations cannot be followed); generic_cliche (stock language dominates); repetition (unintentional); malformed_output (empty, label-only, broken); assistant_editor_meta (instructions/editorial commentary); strong_imagery_poor_contact (C>=3 and A<=1); good_contact_generic_writing (A>=3 and G>=3 or J<=1). Tags may overlap. Return exactly {"scores":{"A":0,...,"J":0},"tags":[],"evidence":"one brief sentence"}.'''

PAIR_INSTRUCTIONS = '''You are a blind creative-writing judge. Compare A and B only for the same prompt. Do not guess model identities and do not use prior scores. Consider prompt fit, explicit constraints, imagery, phrasing, cadence, coherence, prose drift, completeness, and originality together. Return one JSON object, no markdown: {"outcome":"tie","reasons":[],"evidence":"one brief sentence"}. Allowed outcome strings: A clearly better; A slightly better; tie; B slightly better; B clearly better. Reasons must be drawn from: imagery, phrasing, cadence, prompt-fit, constraint, completeness, prose-drift, coherence, originality. Use tie if there is no clear overall preference; do not mechanically choose the longer response.'''


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def build(out: Path):
    prompts_path = ROOT / 'data/eval/prompts.json'
    prompts = json.loads(prompts_path.read_text())
    if len(prompts) != 50 or len({r['id'] for r in prompts}) != 50:
        raise ValueError('Fixed benchmark must contain 50 unique prompts')
    prompt_hash = sha(prompts_path.read_bytes())
    expected = {r['id']: r for r in prompts}
    runs, run_evidence = {}, {}
    generations = set()
    for name, folder in RUNS.items():
        path = ROOT / folder
        manifest = json.loads((path/'run.json').read_text())
        rows = read_jsonl(path/'generations.jsonl')
        if manifest['prompts_sha256'] != prompt_hash or len(rows) != 50 or len({r['id'] for r in rows}) != 50:
            raise ValueError(f'{name}: prompt SHA or row count mismatch')
        by_id = {r['id']: r for r in rows}
        if set(by_id) != set(expected):
            raise ValueError(f'{name}: prompt IDs differ')
        for index, p in enumerate(prompts):
            row = by_id[p['id']]
            if any(row.get(k) != p.get(k) for k in ('prompt', 'length', 'form')):
                raise ValueError(f'{name}: changed prompt, length, or form at {p["id"]}')
            if row.get('seed') != 314159 + index:
                raise ValueError(f'{name}: changed seed at {p["id"]}')
            if not isinstance(row.get('output'), str):
                raise ValueError(f'{name}: missing output at {p["id"]}')
        generations.add(json.dumps(manifest['generation'], sort_keys=True))
        runs[name] = by_id
        run_evidence[name] = {'generation_sha256': sha((path/'generations.jsonl').read_bytes()),
                              'prompts_sha256': manifest['prompts_sha256'],
                              'source_path': folder}
    if len(generations) != 1:
        raise ValueError('Generation settings differ')
    rng = random.Random(PACKET_SEED)
    packet, answer = [], {}
    for p in prompts:
        order = list(RUNS)
        rng.shuffle(order)
        labels = [f'R{i}' for i in range(1, len(RUNS) + 1)]
        pid = p['id']
        packet.append({'id': pid, 'prompt': p['prompt'], 'length': p['length'],
                       'form': p.get('form'),
                       'candidates': [{'label': label, 'text': runs[name][pid]['output']}
                                      for label, name in zip(labels, order)]})
        answer[pid] = dict(zip(labels, order))
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'blind_packet.jsonl', packet)
    write_json(out/'answer_key.json', answer)
    pair_rng = random.Random(PAIR_SEED)
    pair_packet, pair_key = [], {}
    for p in prompts:
        pair_order = list(PAIRS)
        pair_rng.shuffle(pair_order)
        for index, (left, right) in enumerate(pair_order, 1):
            if pair_rng.randrange(2):
                left, right = right, left
            pair_id = f'{p["id"]}-Q{index}'
            pair_packet.append({'id': p['id'], 'pair_id': pair_id,
                                'prompt': p['prompt'], 'length': p['length'],
                                'form': p.get('form'),
                                'A': runs[left][p['id']]['output'],
                                'B': runs[right][p['id']]['output']})
            pair_key[pair_id] = {'A': left, 'B': right}
    write_jsonl(out/'blind_pairs.jsonl', pair_packet)
    write_json(out/'pair_answer_key.json', pair_key)
    write_json(out/'build_manifest.json', {
        'rubric_sha256': sha((ROOT/'corpus/metadata/l7_blind_rubric.md').read_bytes()),
        'prompt_types_sha256': sha((ROOT/'corpus/metadata/l7_prompt_types.json').read_bytes()),
        'prompts_sha256': prompt_hash, 'generation': json.loads(next(iter(generations))),
        'packet_seed': PACKET_SEED, 'pair_seed': PAIR_SEED,
        'judge_model': JUDGE_MODEL, 'judge_seed': JUDGE_SEED,
        'run_evidence': run_evidence,
        'blind_packet_sha256': sha((out/'blind_packet.jsonl').read_bytes()),
        'blind_pairs_sha256': sha((out/'blind_pairs.jsonl').read_bytes()),
        'response_count': 50 * len(RUNS), 'pair_count': 50 * len(PAIRS),
    })
    print(f'built {50 * len(RUNS)} anonymous responses and {50 * len(PAIRS)} anonymous pairs')


def ollama_request(prompt: str):
    request = urllib.request.Request('http://127.0.0.1:11434/api/generate',
        data=json.dumps({'model': JUDGE_MODEL, 'prompt': prompt, 'stream': False,
                         'format': 'json', 'keep_alive': '30m',
                         'options': {'temperature': 0, 'seed': JUDGE_SEED,
                                     'num_ctx': 4096, 'num_predict': 400}}).encode(),
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=600) as response:
        envelope = json.loads(response.read())
    raw = envelope['response']
    return raw, json.loads(raw), {
        'total_duration_ns': envelope.get('total_duration'),
        'eval_count': envelope.get('eval_count'),
    }


def valid_rating(result):
    scores = result.get('scores')
    if not isinstance(scores, dict) or set(scores) != set(DIMENSIONS):
        raise ValueError('Missing or extra rating dimension')
    if any(type(scores[k]) is not int or not 0 <= scores[k] <= 4 for k in DIMENSIONS):
        raise ValueError('Rating outside integer 0-4')
    tags = result.get('tags')
    if not isinstance(tags, list) or any(tag not in TAGS for tag in tags):
        raise ValueError('Invalid failure tag')
    if len(tags) != len(set(tags)) or not isinstance(result.get('evidence'), str):
        raise ValueError('Repeated tag or missing evidence')


def valid_pair(result):
    if result.get('outcome') not in PAIR_OUTCOMES:
        raise ValueError('Invalid pairwise outcome')
    reasons = result.get('reasons')
    if not isinstance(reasons, list) or any(reason not in PAIR_REASONS for reason in reasons):
        raise ValueError('Invalid pairwise reason')
    if len(reasons) != len(set(reasons)) or not isinstance(result.get('evidence'), str):
        raise ValueError('Repeated reason or missing evidence')


def score(out: Path, pairwise: bool):
    # This function reads only anonymous packets. In particular, it does not
    # open answer_key.json or pair_answer_key.json.
    packet = read_jsonl(out/('blind_pairs.jsonl' if pairwise else 'blind_packet.jsonl'))
    path = out/('pairwise_scores.jsonl' if pairwise else 'individual_scores.jsonl')
    completed = {(r['pair_id'] if pairwise else (r['id'], r['label']))
                 for r in read_jsonl(path)} if path.exists() else set()
    total = 50 * (len(PAIRS) if pairwise else len(RUNS))
    index = 0
    for row in packet:
        entries = [row] if pairwise else [dict(row, **candidate) for candidate in row['candidates']]
        for entry in entries:
            key = entry['pair_id'] if pairwise else (entry['id'], entry['label'])
            if key in completed:
                index += 1
                continue
            if pairwise:
                payload = {'prompt': entry['prompt'], 'requested_length': entry['length'],
                           'form': entry.get('form'), 'A': entry['A'], 'B': entry['B']}
                instructions, validator = PAIR_INSTRUCTIONS, valid_pair
            else:
                payload = {'prompt': entry['prompt'], 'requested_length': entry['length'],
                           'form': entry.get('form'), 'response': entry['text']}
                instructions, validator = RATING_INSTRUCTIONS, valid_rating
            prompt = instructions + '\n\nITEM:\n' + json.dumps(payload, ensure_ascii=False)
            last_error = None
            for attempt in range(1, 4):
                try:
                    raw, result, timing = ollama_request(prompt)
                    validator(result)
                    break
                except Exception as exc:
                    last_error = repr(exc)
                    if attempt == 3:
                        raise RuntimeError(f'Failed at anonymous item {key}: {last_error}') from exc
                    time.sleep(1)
            saved = {'id': entry['id'], 'pair_id': entry['pair_id']} if pairwise else \
                    {'id': entry['id'], 'label': entry['label']}
            saved.update({'result': result, 'raw_response': raw,
                          'input_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
                          'attempts': attempt, **timing})
            with path.open('a') as handle:
                handle.write(json.dumps(saved, ensure_ascii=False) + '\n')
                handle.flush()
            index += 1
            if index % 10 == 0 or index == total:
                print(f'{"pairs" if pairwise else "ratings"} {index}/{total}', flush=True)
    print(f'complete {total} {"pairs" if pairwise else "ratings"}')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=('build', 'score', 'pairwise'))
    p.add_argument('--out', required=True)
    args = p.parse_args()
    out = Path(args.out)
    if args.action == 'build':
        build(out)
    else:
        score(out, args.action == 'pairwise')


if __name__ == '__main__':
    main()
