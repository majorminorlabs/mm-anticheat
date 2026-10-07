"""Secondary L5 diagnostic: fixed concepts without a length field."""
from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path

from scripts.analyze_outputs import analyze_row
from scripts.behavior_l3 import TOPICS, _has_group
from scripts.evaluate import norm_words
from scripts.modeling import CONFIG, ROOT, format_prompt, load_model
from scripts.pipeline import sha, write_json, write_jsonl

IDS = ('p01', 'p02', 'p04', 'p06', 'p07', 'p10', 'p12', 'p16',
       'p18', 'p29', 'p33', 'p38', 'p42', 'p43', 'p48', 'p50')
MAX_NEW_TOKENS = 160


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--adapter')
    p.add_argument('--out', required=True)
    p.add_argument('--score-only', action='store_true')
    args = p.parse_args()
    out = Path(args.out)
    if args.score_only:
        rows = [json.loads(line) for line in (out/'generations.jsonl').read_text().splitlines()]
    else:
        if not args.adapter:
            raise ValueError('--adapter is required for generation')
        import torch
        prompts = json.loads((ROOT / 'data/eval/prompts.json').read_text())
        selected = [(i, row) for i, row in enumerate(prompts) if row['id'] in IDS]
        assert tuple(row['id'] for _, row in selected) == IDS
        tokenizer, model = load_model(args.adapter)
        rows = []
        for index, row in selected:
            prompt = format_prompt(row['prompt'], None, form=row.get('form'))
            if '\nlength:' in prompt:
                raise ValueError('Secondary prompt includes length field')
            inputs = tokenizer(prompt, return_tensors='pt').to(model.device)
            seed = CONFIG['seed'] + index
            torch.manual_seed(seed)
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)
            with torch.inference_mode():
                result = model.generate(**inputs, max_new_tokens=MAX_NEW_TOKENS, do_sample=True,
                                        temperature=.85, top_p=.92, repetition_penalty=1.08,
                                        pad_token_id=tokenizer.eos_token_id,
                                        eos_token_id=tokenizer.eos_token_id)
            generated = result[0, inputs['input_ids'].shape[1]:]
            text = tokenizer.decode(generated, skip_special_tokens=True).strip()
            rows.append({'id': row['id'], 'prompt': row['prompt'], 'form': row.get('form'),
                         'original_fixed_length': row['length'], 'seed': seed, 'output': text,
                         'hit_token_cap': len(generated) == MAX_NEW_TOKENS})
    if len(rows) != len(IDS) or tuple(row['id'] for row in rows) != IDS:
        raise ValueError('Secondary prompt set changed')
    for row in rows:
        value = row['output']
        tokens = norm_words(value)
        groups = TOPICS[row['id']]
        shape = analyze_row(row)
        row['word_count'] = len(tokens)
        row['topic_any_first50'] = any(_has_group(tokens[:50], group) for group in groups) if groups else None
        row['empty'] = not bool(value)
        row['meta_instruction_hit'] = bool(re.search(r"(?im)^\s*(?:[-*]\s*)?(?:no dialogue|make it feel|here(?:'s| is) an example|the first part of the (?:refrain|request)|as an ai|i will write|this passage has|original text:|write a poem)\b", value))
        row['unexpected_section_label'] = shape['unexpected_section_label']
        row['unfinished_tail_proxy'] = shape['unfinished_tail']
    contact = [r['topic_any_first50'] for r in rows if r['topic_any_first50'] is not None]
    summary = {'prompt_count': len(rows), 'source_prompt_sha256': sha((ROOT/'data/eval/prompts.json').read_bytes()),
               'length_field_omitted': True, 'max_new_tokens': MAX_NEW_TOKENS,
               'temperature': .85, 'top_p': .92, 'repetition_penalty': 1.08,
               'mean_words': round(statistics.mean(r['word_count'] for r in rows),1),
               'median_words': statistics.median(r['word_count'] for r in rows),
               'min_words': min(r['word_count'] for r in rows),
               'max_words': max(r['word_count'] for r in rows),
               'topic_scored_prompts': len(contact),
               'topic_any_first50_rate': round(statistics.mean(contact),3),
               'empty_count': sum(r['empty'] for r in rows),
               'meta_instruction_count': sum(r['meta_instruction_hit'] for r in rows),
               'unexpected_section_label_count': sum(r['unexpected_section_label'] for r in rows),
               'token_cap_count': sum(r['hit_token_cap'] for r in rows),
               'unfinished_tail_proxy_count': sum(r['unfinished_tail_proxy'] for r in rows)}
    out.mkdir(parents=True, exist_ok=True)
    write_jsonl(out/'generations.jsonl', rows)
    write_json(out/'summary.json', summary)
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    main()
