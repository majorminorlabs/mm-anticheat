"""Blind source-only L11 target scoring with a separate answer key."""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import time
from collections import Counter
from pathlib import Path

from scripts.blind_quality_l10 import JUDGE_MODEL, JUDGE_SEED, ollama_request, read_jsonl
from scripts.modeling import ROOT
from scripts.pipeline import sha, write_json, write_jsonl

PACKET_SEED = 314181
JUDGE_MODEL_DIGEST = '5a408ab55df5c1b5cf46533c368813b30bf9e4d8fc39263bf2a3338cfa3b895b'
DIMENSIONS = 'ABCDEFGHI'
INSTRUCTIONS = '''You are scoring one anonymous source passage as a potential creative-writing training target. Score only the passage, with no inference about its artist or model behavior. Return one JSON object and no markdown. Every A-I score is an integer 0-4. Positive scores: 0 absent/broken, 2 mixed/adequate, 4 outstanding. Penalties: 0 absent, 4 dominant. A standalone completeness and natural ending. B specific, surprising imagery. C distinctive but effective phrasing. D purposeful cadence and lineation, not prose merely wrapped. E indirect or associative semantic movement. F productive ambiguity without incoherence. G penalty for generic narrative/expository prose, stock sentiment, or editor/assistant language. H penalty for dependence on surrounding song context. I penalty for excessive repeated-line or refrain dependence. Do not reward mere shortness, punctuation, or line count. Evaluate actual writing quality, not fame or guessed source. Return exactly {"scores":{"A":0,"B":0,"C":0,"D":0,"E":0,"F":0,"G":0,"H":0,"I":0},"rationale":"one short nonquoting sentence"}.'''


def valid(result: dict) -> None:
    scores = result.get('scores')
    if not isinstance(scores, dict) or set(scores) != set(DIMENSIONS):
        raise ValueError('Missing score dimension')
    if any(type(scores[k]) is not int or not 0 <= scores[k] <= 4 for k in DIMENSIONS):
        raise ValueError('Score outside 0-4')
    if not isinstance(result.get('rationale'), str) or not result['rationale'].strip():
        raise ValueError('Missing rationale')


def build(out: Path) -> None:
    source_path = ROOT/'data/l5/train.jsonl'
    rows = read_jsonl(source_path)
    audit_path = out/'audit.jsonl'
    audit = read_jsonl(audit_path)
    if len(rows) != 224 or len(audit) != 224 or {r['id'] for r in rows} != {r['id'] for r in audit}:
        raise ValueError('Audit and source row IDs differ')
    rng = random.Random(PACKET_SEED)
    rng.shuffle(rows)
    packet = []
    key = {}
    for index, row in enumerate(rows, 1):
        label = f'T{index:03d}'
        packet.append({'label': label, 'text': row['target']})
        key[label] = {'id': row['id'], 'target_sha256': row['target_sha256']}
    write_jsonl(out/'blind_packet.jsonl', packet)
    write_json(out/'answer_key.json', key)
    write_json(out/'build_manifest.json', {
        'rubric_sha256': sha((ROOT/'L11_RUBRIC.md').read_bytes()),
        'source_l5_sha256': sha(source_path.read_bytes()),
        'audit_sha256': sha(audit_path.read_bytes()),
        'instructions_sha256': sha(INSTRUCTIONS.encode()),
        'packet_sha256': sha((out/'blind_packet.jsonl').read_bytes()),
        'answer_key_sha256': sha((out/'answer_key.json').read_bytes()),
        'judge_model': JUDGE_MODEL, 'judge_seed': JUDGE_SEED,
        'judge_model_digest_observed': JUDGE_MODEL_DIGEST,
        'packet_seed': PACKET_SEED, 'candidate_count': len(rows),
    })
    print(f'built {len(rows)} anonymous source-only candidates')


def score(out: Path) -> None:
    packet = read_jsonl(out/'blind_packet.jsonl')
    saved_path = out/'scores.jsonl'
    completed = {r['label'] for r in read_jsonl(saved_path)} if saved_path.exists() else set()
    for index, entry in enumerate(packet, 1):
        if entry['label'] in completed:
            continue
        prompt = INSTRUCTIONS + '\n\nPASSAGE:\n' + json.dumps(entry['text'], ensure_ascii=False)
        for attempt in range(1, 4):
            try:
                raw, result, timing = ollama_request(prompt)
                valid(result)
                break
            except Exception as exc:
                if attempt == 3:
                    raise RuntimeError(f'Anonymous candidate {entry["label"]} failed') from exc
                time.sleep(1)
        record = {'label': entry['label'], 'result': result, 'raw_response': raw,
                  'input_sha256': hashlib.sha256(prompt.encode()).hexdigest(),
                  'attempts': attempt, **timing}
        with saved_path.open('a') as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + '\n')
            handle.flush()
        if index % 10 == 0 or index == len(packet):
            print(f'targets {index}/{len(packet)}', flush=True)
    print(f'complete {len(packet)} source-only target scores')


def analyze(out: Path) -> None:
    manifest = json.loads((out/'build_manifest.json').read_text())
    packet = read_jsonl(out/'blind_packet.jsonl')
    scores = read_jsonl(out/'scores.jsonl')
    if len(packet) != manifest['candidate_count'] or len(scores) != len(packet):
        raise ValueError('Complete packet required before unblinding')
    if (sha((ROOT/'L11_RUBRIC.md').read_bytes()) != manifest['rubric_sha256'] or
        sha((ROOT/'data/l5/train.jsonl').read_bytes()) != manifest['source_l5_sha256'] or
        sha((out/'audit.jsonl').read_bytes()) != manifest['audit_sha256'] or
        sha(INSTRUCTIONS.encode()) != manifest['instructions_sha256'] or
        sha((out/'blind_packet.jsonl').read_bytes()) != manifest['packet_sha256']):
        raise ValueError('Frozen source, rubric, audit, or packet changed')
    expected = {r['label']: r for r in packet}
    scored = {r['label']: r for r in scores}
    if len(expected) != len(packet) or len(scored) != len(scores) or set(expected) != set(scored):
        raise ValueError('Missing or repeated anonymous score')
    for record in scores:
        valid(record['result'])
        prompt = INSTRUCTIONS + '\n\nPASSAGE:\n' + json.dumps(expected[record['label']]['text'], ensure_ascii=False)
        if hashlib.sha256(prompt.encode()).hexdigest() != record['input_sha256']:
            raise ValueError('Judge input changed')
    key_path = out/'answer_key.json'
    if sha(key_path.read_bytes()) != manifest['answer_key_sha256']:
        raise ValueError('Answer key changed')
    key = json.loads(key_path.read_text())
    audit = {r['id']: r for r in read_jsonl(out/'audit.jsonl')}
    private = []
    tracked = []
    for label, item in expected.items():
        answer = key[label]
        if sha(item['text'].encode()) != answer['target_sha256']:
            raise ValueError('Answer key target hash mismatch')
        result = scored[label]['result']
        values = result['scores']
        composite = sum(values[k] for k in 'ABCDEF') - sum(values[k] for k in 'GHI')
        record = {'id': answer['id'], 'target_sha256': answer['target_sha256'],
                  'scores': values, 'composite': composite, 'audit': audit[answer['id']]}
        tracked.append(record)
        private.append({**record, 'rationale': result['rationale']})
    tracked.sort(key=lambda r: r['id'])
    private.sort(key=lambda r: r['id'])
    write_jsonl(out/'scored_private.jsonl', private)
    composites = Counter(r['composite'] for r in tracked)
    write_json(ROOT/'corpus/metadata/l11_target_scores.json', {
        'method': 'Anonymous source-only local model judge; nonquoting rationales retained in ignored local scored_private.jsonl.',
        'rubric_sha256': manifest['rubric_sha256'],
        'instructions_sha256': manifest['instructions_sha256'],
        'packet_sha256': manifest['packet_sha256'],
        'scores_sha256': sha((out/'scores.jsonl').read_bytes()),
        'rationales_sha256': sha((out/'scored_private.jsonl').read_bytes()),
        'judge_model': JUDGE_MODEL, 'judge_seed': JUDGE_SEED,
        'judge_model_digest_observed': JUDGE_MODEL_DIGEST,
        'candidate_count': len(tracked),
        'scoring_retries': sum(r['attempts'] - 1 for r in scores),
        'composite_histogram': {str(k): composites[k] for k in sorted(composites)},
        'rows': tracked,
    })
    print(f'unblinded {len(tracked)} complete target scores')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('build', 'score', 'analyze'))
    parser.add_argument('--out', type=Path, default=ROOT/'outputs/l11-candidates')
    args = parser.parse_args()
    {'build': build, 'score': score, 'analyze': analyze}[args.action](args.out)


if __name__ == '__main__':
    main()
