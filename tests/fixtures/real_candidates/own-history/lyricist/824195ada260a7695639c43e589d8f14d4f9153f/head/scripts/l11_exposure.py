"""Compare curated L11 target-token exposure to the saved L6 50-step trace."""
from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from pathlib import Path

from scripts.l4_sampler import BUCKETS, EXAMPLES_PER_STEP, sample_plan
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, write_json

CHECKPOINTS = (15, 25, 35, 40, 50)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def token_counts(tokenizer, rows: list[dict]) -> dict[str, int]:
    return {row['id']: len(tokenizer(row['target'], add_special_tokens=False)['input_ids'])
            for row in rows}


def summarize(rows: list[dict], drawn_ids: list[str], counts: dict[str, int]) -> dict:
    by_id = {row['id']: row for row in rows}
    if len(by_id) != len(rows) or any(item not in by_id for item in drawn_ids):
        raise ValueError('Sampler IDs missing or duplicated in data')
    drawn = Counter(drawn_ids)
    totals = {}
    every_step = {}
    running = 0
    for index, item in enumerate(drawn_ids, 1):
        running += counts[item]
        if index % EXAMPLES_PER_STEP == 0:
            step = index // EXAMPLES_PER_STEP
            every_step[str(step)] = running
            if step in CHECKPOINTS:
                totals[str(step)] = running
    all_unique = sum(counts.values())
    return {'unique_targets': len(rows), 'source_works': len({r['work_id'] for r in rows}),
            'draws': len(drawn_ids), 'unique_drawn': len(drawn),
            'average_draws_per_target': round(len(drawn_ids) / len(rows), 4),
            'max_draws_per_target': max(drawn.values()),
            'unique_target_tokens': all_unique,
            'target_tokens_seen_at_step': totals,
            'target_tokens_seen_at_every_step': every_step,
            'effective_curated_token_passes_at_50': round(totals['50'] / all_unique, 4),
            'drawn_bucket_counts': dict(sorted(Counter(by_id[item]['length_bucket'] for item in drawn_ids).items())),
            'source_bucket_counts': {bucket: sum(r['length_bucket'] == bucket for r in rows) for bucket in BUCKETS},
            'drawn_ids_sha256': sha(json.dumps(drawn_ids, separators=(',', ':')).encode())}


def evaluate(curated_path: Path | None, out: Path) -> dict:
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    original_path = ROOT/'data/l5/train.jsonl'
    baseline_rows = read_jsonl(original_path)
    trace_path = ROOT/'outputs/l6/sample_trace.jsonl'
    trace = read_jsonl(trace_path)
    if len(trace) != 50 or [r['step'] for r in trace] != list(range(1, 51)):
        raise ValueError('Saved L6 trace is not 50 ordered steps')
    baseline_ids = [item for step in trace for item in step['sampled_ids']]
    if len(baseline_ids) != 50 * EXAMPLES_PER_STEP:
        raise ValueError('Saved L6 trace draw count changed')
    baseline = summarize(baseline_rows, baseline_ids, token_counts(tokenizer, baseline_rows))
    result = {'tokenizer_base_revision': CONFIG['model_revision'],
              'baseline_l5_sha256': sha(original_path.read_bytes()),
              'baseline_l6_trace_sha256': sha(trace_path.read_bytes()),
              'target_token_definition': 'Tokenizer target IDs, excluding prompt and terminal EOS; 400 draws through 50 updates.',
              'baseline_l6': baseline}
    if curated_path:
        rows = read_jsonl(curated_path)
        plan = sample_plan(rows)
        drawn_ids = [rows[i]['id'] for i in plan[:50 * EXAMPLES_PER_STEP]]
        curated = summarize(rows, drawn_ids, token_counts(tokenizer, rows))
        curated['train_jsonl_sha256'] = sha(curated_path.read_bytes())
        curated['plan_indices_sha256'] = sha(json.dumps(plan, separators=(',', ':')).encode())
        curated['target_token_exposure_ratio_to_l6'] = round(
            curated['target_tokens_seen_at_step']['50'] / baseline['target_tokens_seen_at_step']['50'], 4)
        curated['per_checkpoint_token_ratio_to_l6'] = {
            key: round(curated['target_tokens_seen_at_step'][key] / baseline['target_tokens_seen_at_step'][key], 4)
            for key in map(str, CHECKPOINTS)}
        curated['matched_exposure_l11_step_for_l6_checkpoint'] = {
            str(checkpoint): min(range(1, 51), key=lambda step: (
                abs(curated['target_tokens_seen_at_every_step'][str(step)] -
                    baseline['target_tokens_seen_at_step'][str(checkpoint)]), step))
            for checkpoint in CHECKPOINTS}
        result['curated_l11'] = curated
    write_json(out, result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--curated', type=Path)
    parser.add_argument('--out', type=Path, default=ROOT/'corpus/metadata/l11_exposure.json')
    args = parser.parse_args()
    print(json.dumps(evaluate(args.curated, args.out), indent=2))
