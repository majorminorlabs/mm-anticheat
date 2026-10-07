"""Generate the unchanged, target-free 20-prompt diagnostic for L9."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from scripts.build_l8 import forbidden_forms, token_present
from scripts.modeling import CONFIG, ROOT, generate, load_model
from scripts.pipeline import sha, write_json, write_jsonl

PROMPTS = ROOT / 'corpus/metadata/l8_novel_prompts.json'


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--adapter', required=True)
    p.add_argument('--base-path')
    p.add_argument('--model-id')
    p.add_argument('--model-revision')
    p.add_argument('--out', required=True)
    args = p.parse_args()
    prompts = json.loads(PROMPTS.read_text())
    assert len(prompts) == 20 and len({x['id'] for x in prompts}) == 20
    train_prompts = {json.loads(line)['prompt'] for line in (ROOT / 'data/l9/constraints.jsonl').read_text().splitlines()}
    assert all(p['prompt'] not in train_prompts for p in prompts)
    tokenizer, model = load_model(args.adapter, base_path=args.base_path,
                                  model_id=args.model_id, model_revision=args.model_revision)
    rows = []
    for i, item in enumerate(prompts):
        output = generate(tokenizer, model, item['prompt'], item['length'], seed=CONFIG['seed'] + 1000 + i)
        forbidden = {word: token_present(output, forbidden_forms(word))
                     for word in item.get('forbidden', [])}
        rows.append({**item, 'seed': CONFIG['seed'] + 1000 + i, 'output': output,
                     'forbidden_emitted': {word: forms for word, forms in forbidden.items() if forms}})
        if (i + 1) % 5 == 0:
            print(f'generated {i + 1}/20', flush=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out / 'generations.jsonl', rows)
    write_json(out / 'run.json', {'adapter': args.adapter, 'base_path': args.base_path,
                                  'model_id': args.model_id or CONFIG['model_id'],
                                  'model_revision': args.model_revision or CONFIG['model_revision'],
                                  'prompts_sha256': sha(PROMPTS.read_bytes()),
                                  'generation': {'temperature': 0.85, 'top_p': 0.92,
                                                 'repetition_penalty': 1.08, 'max_new_tokens': 'by length category'},
                                  'seed_offset': 1000, 'no_reference_targets': True})
    print(json.dumps({'count': len(rows), 'lexical_or_mixed_with_forbidden_emitted':
                      sum(bool(row['forbidden_emitted']) for row in rows)}))


if __name__ == '__main__':
    main()
