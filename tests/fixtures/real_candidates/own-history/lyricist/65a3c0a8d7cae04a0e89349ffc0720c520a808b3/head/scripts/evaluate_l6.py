"""Unchanged fixed-prompt sampling with observed EOS positions/probabilities."""
from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from scripts.evaluate import evaluate
from scripts.modeling import CONFIG, LENGTH_TOKENS, ROOT, format_prompt, load_model
from scripts.pipeline import sha, write_json, write_jsonl

DIAGNOSTIC_IDS = ('p01', 'p02', 'p04', 'p06', 'p10', 'p16', 'p18', 'p33', 'p43', 'p50')
PROBE_POSITIONS = (1, 8, 16, 24, 32, 48, 64, 96, 128, 160, 200)


def generate_observed(tokenizer, model, row, seed, diagnostic):
    import torch

    prompt = format_prompt(row['prompt'], row['length'], form=row.get('form'))
    inputs = tokenizer(prompt, return_tensors='pt').to(model.device)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=LENGTH_TOKENS[row['length']],
                                   do_sample=True, temperature=.85, top_p=.92,
                                   repetition_penalty=1.08,
                                   pad_token_id=tokenizer.eos_token_id,
                                   eos_token_id=tokenizer.eos_token_id,
                                   return_dict_in_generate=True)
    prefix_count = inputs['input_ids'].shape[1]
    token_ids = generated.sequences[0, prefix_count:]
    eos_indices = (token_ids == tokenizer.eos_token_id).nonzero(as_tuple=True)[0]
    first_eos = int(eos_indices[0]) + 1 if eos_indices.numel() else None
    content_tokens = first_eos - 1 if first_eos is not None else len(token_ids)
    output = tokenizer.decode(token_ids, skip_special_tokens=True).strip()
    observation = {'id': row['id'], 'prompt': row['prompt'], 'length': row['length'],
                   'form': row.get('form'), 'seed': seed, 'output': output,
                   'generated_output_tokens': content_tokens,
                   'eos_emitted': first_eos is not None,
                   'first_eos_position': first_eos,
                   'hit_token_cap': first_eos is None and len(token_ids) == LENGTH_TOKENS[row['length']]}
    eos_curve = None
    if diagnostic:
        # Teacher-force the *sampled* continuation to observe raw model EOS
        # probability at every reached position. No generation setting changes.
        with torch.inference_mode():
            logits = model(input_ids=generated.sequences,
                           attention_mask=torch.ones_like(generated.sequences)).logits[0].float()
        predicting = logits[prefix_count-1:prefix_count-1+len(token_ids)]
        log_normalizer = torch.logsumexp(predicting, dim=-1)
        probabilities = (predicting[:, tokenizer.eos_token_id]-log_normalizer).exp().tolist()
        eos_curve = {'id': row['id'], 'requested_length': row['length'],
                     'content_tokens': content_tokens, 'first_eos_position': first_eos,
                     'raw_eos_probability_at_generated_position':
                         [round(float(value), 8) for value in probabilities]}
    return observation, eos_curve


def summarize_observations(rows, curves):
    eos_positions = [row['first_eos_position'] for row in rows if row['eos_emitted']]
    summary = {'prompt_count': len(rows),
               'mean_generated_output_tokens': round(statistics.mean(row['generated_output_tokens'] for row in rows), 2),
               'median_generated_output_tokens': statistics.median(row['generated_output_tokens'] for row in rows),
               'eos_emitted_count': len(eos_positions),
               'eos_emitted_rate': round(len(eos_positions)/len(rows), 3),
               'mean_first_eos_position_when_emitted': round(statistics.mean(eos_positions), 2) if eos_positions else None,
               'median_first_eos_position_when_emitted': statistics.median(eos_positions) if eos_positions else None,
               'token_cap_count': sum(row['hit_token_cap'] for row in rows),
               'diagnostic_prompt_count': len(curves)}
    by_length = {}
    for length in ('short', 'medium', 'long'):
        selected = [row for row in rows if row['length'] == length]
        if not selected:
            by_length[length] = {'prompts': 0}
            continue
        reached_eos = [row['first_eos_position'] for row in selected if row['eos_emitted']]
        by_length[length] = {'prompts': len(selected),
                             'mean_output_tokens': round(statistics.mean(row['generated_output_tokens'] for row in selected), 2),
                             'eos_emitted_count': len(reached_eos),
                             'eos_emitted_rate': round(len(reached_eos)/len(selected), 3),
                             'mean_first_eos_position_when_emitted': round(statistics.mean(reached_eos), 2) if reached_eos else None,
                             'median_first_eos_position_when_emitted': statistics.median(reached_eos) if reached_eos else None,
                             'token_cap_count': sum(row['hit_token_cap'] for row in selected)}
    summary['by_requested_length'] = by_length
    probability_by_position = {}
    for position in PROBE_POSITIONS:
        probabilities = [curve['raw_eos_probability_at_generated_position'][position-1]
                         for curve in curves if len(curve['raw_eos_probability_at_generated_position']) >= position]
        probability_by_position[str(position)] = {'reached_prompts': len(probabilities),
                                                  'mean_raw_eos_probability': round(statistics.mean(probabilities), 8) if probabilities else None,
                                                  'median_raw_eos_probability': round(statistics.median(probabilities), 8) if probabilities else None}
    summary['diagnostic_eos_probability_by_position'] = probability_by_position
    return summary


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--adapter')
    p.add_argument('--base-path', help='Frozen merged CPT base for L10 C2')
    p.add_argument('--model-id')
    p.add_argument('--model-revision')
    p.add_argument('--out', required=True)
    p.add_argument('--limit', type=int)
    args = p.parse_args()
    prompts = json.loads((ROOT/'data/eval/prompts.json').read_text())
    if args.limit:
        prompts = prompts[:args.limit]
    tokenizer, model = load_model(args.adapter, base_path=args.base_path,
                                  model_id=args.model_id, model_revision=args.model_revision)
    rows, curves = [], []
    for index, row in enumerate(prompts):
        observation, curve = generate_observed(tokenizer, model, row, CONFIG['seed']+index,
                                               row['id'] in DIAGNOSTIC_IDS)
        rows.append(observation)
        if curve:
            curves.append(curve)
        if (index+1) % 10 == 0:
            print(f'generated {index+1}/{len(prompts)}', flush=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'generations.jsonl', rows)
    write_json(out/'eos_probability_curves.json', curves)
    write_json(out/'eos_diagnostics.json', summarize_observations(rows, curves))
    run = {'model_id': args.model_id or CONFIG['model_id'],
           'model_revision': args.model_revision or CONFIG['model_revision'],
           'adapter': args.adapter, 'base_path': args.base_path,
           'prompts_sha256': sha((ROOT/'data/eval/prompts.json').read_bytes()),
           'generation': {'temperature': .85, 'top_p': .92, 'repetition_penalty': 1.08,
                          'max_new_tokens': 'by length category'},
           'diagnostic_prompt_ids': DIAGNOSTIC_IDS,
           'eos_probability': 'raw model softmax on sampled continuations, teacher-forced after unchanged generation'}
    write_json(out/'run.json', run)
    print(json.dumps(evaluate(out/'generations.jsonl', out), indent=2))
    print(json.dumps(json.loads((out/'eos_diagnostics.json').read_text()), indent=2))


if __name__ == '__main__':
    main()
