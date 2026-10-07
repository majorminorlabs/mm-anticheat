"""Private short-prefix continuation audit; reports hashes and overlap, not lyrics."""
from __future__ import annotations

import argparse
import difflib
import json
import statistics
from pathlib import Path

from scripts.modeling import CONFIG, ROOT, load_model
from scripts.pipeline import sha, write_json, write_jsonl

PREFIX_TOKENS = 12
CONTINUATION_TOKENS = 64
TRAIN_PROBES = 11
FLAG_MATCH_TOKENS = 16


def read_docs(split):
    return [json.loads(line) for line in (ROOT / f'data/l10/raw-{split}.jsonl').read_text().splitlines()]


def longest_shared(left, right):
    return difflib.SequenceMatcher(None, left, right, autojunk=False).find_longest_match(
        0, len(left), 0, len(right)).size


def main():
    import torch

    p = argparse.ArgumentParser()
    p.add_argument('--adapter')
    p.add_argument('--base-path')
    p.add_argument('--model-id')
    p.add_argument('--model-revision')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    tokenizer, model = load_model(args.adapter, base_path=args.base_path,
                                  model_id=args.model_id, model_revision=args.model_revision)
    sources = {'heldout': read_docs('heldout'), 'train': read_docs('train')[:TRAIN_PROBES]}
    records = []
    for split, docs in sources.items():
        for row in docs:
            source_ids = tokenizer(row['text'], add_special_tokens=False)['input_ids']
            if len(source_ids) <= PREFIX_TOKENS + CONTINUATION_TOKENS:
                raise ValueError('Continuation source too short for frozen probe')
            prefix = source_ids[:PREFIX_TOKENS]
            reference = source_ids[PREFIX_TOKENS:PREFIX_TOKENS + CONTINUATION_TOKENS]
            inputs = torch.tensor([prefix], device=model.device)
            with torch.inference_mode():
                result = model.generate(input_ids=inputs, max_new_tokens=CONTINUATION_TOKENS,
                                        do_sample=False, pad_token_id=tokenizer.eos_token_id,
                                        eos_token_id=tokenizer.eos_token_id)
            generated = result[0, PREFIX_TOKENS:].tolist()
            if tokenizer.eos_token_id in generated:
                generated = generated[:generated.index(tokenizer.eos_token_id)]
            exact_prefix = 0
            for a, b in zip(generated, reference):
                if a != b:
                    break
                exact_prefix += 1
            longest = longest_shared(generated, reference)
            records.append({'split': split, 'work_id': row['work_id'],
                            'prefix_sha256': sha(bytes(str(prefix), 'ascii')),
                            'reference_sha256': sha(bytes(str(reference), 'ascii')),
                            'generated_sha256': sha(bytes(str(generated), 'ascii')),
                            'generated_tokens': len(generated), 'exact_continuation_prefix_tokens': exact_prefix,
                            'longest_shared_continuation_tokens': longest,
                            'flag': exact_prefix >= FLAG_MATCH_TOKENS or longest >= FLAG_MATCH_TOKENS})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / 'per_probe.jsonl', records)
    summary = {'base': args.base_path or args.model_id or CONFIG['model_id'], 'adapter': args.adapter,
               'prefix_tokens': PREFIX_TOKENS, 'max_generated_tokens': CONTINUATION_TOKENS,
               'flag_threshold_tokens': FLAG_MATCH_TOKENS, 'greedy': True,
               'source_text_saved': False, 'probes': {}}
    for split in sources:
        selected = [r for r in records if r['split'] == split]
        summary['probes'][split] = {
            'count': len(selected), 'flags': sum(r['flag'] for r in selected),
            'max_exact_prefix_tokens': max(r['exact_continuation_prefix_tokens'] for r in selected),
            'max_longest_shared_tokens': max(r['longest_shared_continuation_tokens'] for r in selected),
            'mean_exact_prefix_tokens': round(statistics.mean(r['exact_continuation_prefix_tokens'] for r in selected), 3)}
    write_json(out / 'summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
