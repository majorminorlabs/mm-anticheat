"""Greedy selected-target and heldout continuation screen without saved text."""
from __future__ import annotations

import argparse
import difflib
import json
import statistics
from collections import Counter
from pathlib import Path

from scripts.l4_sampler import EXAMPLES_PER_STEP, sample_plan
from scripts.modeling import CONFIG, ROOT, load_model
from scripts.pipeline import sha, write_json, write_jsonl

PREFIX_TOKENS = 12
MAX_CONTINUATION_TOKENS = 64
FLAG_MATCH_TOKENS = 16
TRAIN_PROBES = 20


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def selected_probes(tokenizer):
    rows = read_jsonl(ROOT/'data/l11/train.jsonl')
    plan = sample_plan(rows)
    frequency = Counter(rows[i]['id'] for i in plan[:50 * EXAMPLES_PER_STEP])
    eligible = [row for row in rows if len(tokenizer(row['target'], add_special_tokens=False)['input_ids'])
                >= PREFIX_TOKENS + FLAG_MATCH_TOKENS]
    eligible.sort(key=lambda r: (-frequency[r['id']], r['target_sha256']))
    if len(eligible) < TRAIN_PROBES:
        raise ValueError('Too few curated targets for prefix audit')
    return [{'id': row['id'], 'text': row['target'], 'target_sha256': row['target_sha256'],
             'draws_in_first_50': frequency[row['id']]} for row in eligible[:TRAIN_PROBES]]


def longest_shared(left, right):
    return difflib.SequenceMatcher(None, left, right, autojunk=False).find_longest_match(
        0, len(left), 0, len(right)).size


def main():
    import torch

    parser = argparse.ArgumentParser()
    parser.add_argument('--adapter')
    parser.add_argument('--base-path')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    tokenizer, model = load_model(args.adapter, base_path=args.base_path)
    train = selected_probes(tokenizer)
    held = read_jsonl(ROOT/'data/l10/raw-heldout.jsonl')
    records = []
    for split, rows in (('train_selected', train), ('heldout', held)):
        for row in rows:
            ids = tokenizer(row['text'], add_special_tokens=False)['input_ids']
            if len(ids) < PREFIX_TOKENS + FLAG_MATCH_TOKENS:
                raise ValueError('Continuation reference too short')
            prefix = ids[:PREFIX_TOKENS]
            reference = ids[PREFIX_TOKENS:PREFIX_TOKENS + MAX_CONTINUATION_TOKENS]
            inputs = torch.tensor([prefix], device=model.device)
            with torch.inference_mode():
                result = model.generate(input_ids=inputs, max_new_tokens=len(reference),
                                        do_sample=False, pad_token_id=tokenizer.eos_token_id,
                                        eos_token_id=tokenizer.eos_token_id)
            generated = result[0, PREFIX_TOKENS:].tolist()
            if tokenizer.eos_token_id in generated:
                generated = generated[:generated.index(tokenizer.eos_token_id)]
            exact_prefix = 0
            for left, right in zip(generated, reference):
                if left != right:
                    break
                exact_prefix += 1
            longest = longest_shared(generated, reference)
            source_id = row.get('id', row.get('work_id'))
            records.append({'split': split, 'source_id_sha256': sha(source_id.encode()),
                            'source_text_sha256': sha(row['text'].encode()),
                            'prefix_sha256': sha(str(prefix).encode()),
                            'reference_sha256': sha(str(reference).encode()),
                            'generated_sha256': sha(str(generated).encode()),
                            'target_draws_in_first_50': row.get('draws_in_first_50'),
                            'generated_tokens': len(generated),
                            'exact_continuation_prefix_tokens': exact_prefix,
                            'longest_shared_continuation_tokens': longest,
                            'flag': exact_prefix >= FLAG_MATCH_TOKENS or longest >= FLAG_MATCH_TOKENS})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'per_probe.jsonl', records)
    definition = [(r['split'], r['source_id_sha256'], r['source_text_sha256']) for r in records]
    summary = {'base': args.base_path or CONFIG['model_id'], 'adapter': args.adapter,
               'prefix_tokens': PREFIX_TOKENS, 'max_generated_tokens': MAX_CONTINUATION_TOKENS,
               'flag_threshold_tokens': FLAG_MATCH_TOKENS, 'greedy': True,
               'source_text_saved': False,
               'probe_definition_sha256': sha(json.dumps(definition, separators=(',', ':')).encode()),
               'results_sha256': sha((out/'per_probe.jsonl').read_bytes()),
               'probes': {}}
    for split in ('train_selected', 'heldout'):
        selected = [r for r in records if r['split'] == split]
        summary['probes'][split] = {
            'count': len(selected), 'flags': sum(r['flag'] for r in selected),
            'max_exact_prefix_tokens': max(r['exact_continuation_prefix_tokens'] for r in selected),
            'max_longest_shared_tokens': max(r['longest_shared_continuation_tokens'] for r in selected),
            'mean_exact_prefix_tokens': round(statistics.mean(r['exact_continuation_prefix_tokens'] for r in selected), 3)}
    write_json(out/'summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
