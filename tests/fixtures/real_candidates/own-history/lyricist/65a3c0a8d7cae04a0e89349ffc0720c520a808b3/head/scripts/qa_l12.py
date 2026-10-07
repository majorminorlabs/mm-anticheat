"""Weight-free L12 compatibility and exposure preflight."""
from __future__ import annotations

import json
from collections import Counter

from scripts.l4_sampler import EXAMPLES_PER_STEP, sample_plan, summarize
from scripts.modeling import CONFIG, ROOT, format_prompt
from scripts.pipeline import sha, write_json
from scripts.train_l3 import prepare
from scripts.train_l5 import rows
from scripts.train_l12 import L6


def check():
    from transformers import AutoConfig, AutoTokenizer

    larger = json.loads((ROOT / 'config/l12_model.json').read_text())
    big_config = AutoConfig.from_pretrained(larger['model_id'], revision=larger['model_revision'])
    old_tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer = AutoTokenizer.from_pretrained(larger['model_id'], revision=larger['model_revision'])
    if big_config.architectures != [larger['architecture']]:
        raise ValueError('Unexpected model architecture')
    if not tokenizer.eos_token_id == old_tokenizer.eos_token_id == larger['tokenizer_eos_id']:
        raise ValueError('Tokenizer EOS mismatch')
    if tokenizer.get_vocab() != old_tokenizer.get_vocab():
        raise ValueError('L12 tokenizer vocabulary differs from L6')
    if L6['checkpoints'] != [15, 25, 35, 40, 50] or L6['max_steps'] != 200:
        raise ValueError('L12 schedule changed')
    train, val, held = rows('train'), rows('validation'), rows('heldout')
    if {r['work_id'] for r in train} & {r['work_id'] for r in val + held}:
        raise ValueError('Split leakage')
    plan = sample_plan(train)
    indices = plan[:50 * EXAMPLES_PER_STEP]
    trace_path = ROOT / 'outputs/l6/sample_trace.jsonl'
    expected = [json.loads(line)['sampled_ids'] for line in trace_path.read_text().splitlines()[:50]]
    actual = [[train[i]['id'] for i in indices[n:n + EXAMPLES_PER_STEP]]
              for n in range(0, len(indices), EXAMPLES_PER_STEP)]
    if actual != expected:
        raise ValueError('L12 sample order differs from L6 actual trace')
    prepared = [prepare(tokenizer, row) for row in train + val + held]
    if any(len(p['input_ids']) > 384 for p in prepared):
        raise ValueError('Sequence cap exceeded')
    if any(p['labels'][-1] != tokenizer.eos_token_id or p['labels'].count(tokenizer.eos_token_id) != 1
           for p in prepared):
        raise ValueError('Target terminal EOS differs')
    if any(p['labels'][0] != -100 for p in prepared):
        raise ValueError('Prompt masking differs')
    for row in train + val + held:
        prompt = format_prompt(row['prompt'], row['length_control'])
        if tokenizer(prompt, add_special_tokens=False)['input_ids'] != \
                old_tokenizer(prompt, add_special_tokens=False)['input_ids']:
            raise ValueError('Raw prompt tokens differ')
    target_tokens = sum(sum(t != -100 and t != tokenizer.eos_token_id for t in
                            prepared[i]['labels']) for i in indices)
    source_trace = json.loads((ROOT / 'outputs/l6/run.json').read_text())
    report = {
        'status': 'passed', 'model_id': larger['model_id'], 'model_revision': larger['model_revision'],
        'architecture': big_config.architectures[0], 'layers': big_config.num_hidden_layers,
        'hidden_size': big_config.hidden_size, 'attention_heads': big_config.num_attention_heads,
        'key_value_heads': big_config.num_key_value_heads,
        'lora_targets': larger['lora_target_modules'], 'tokenizer_eos_id': tokenizer.eos_token_id,
        'raw_prompt_format': 'scripts.modeling.format_prompt; no chat template applied',
        'l6_trace_sha256': sha(trace_path.read_bytes()),
        'sample_plan_sha256': sha(json.dumps(plan, separators=(',', ':')).encode()),
        'draws_50': len(indices), 'target_tokens_50': target_tokens,
        'bucket_exposure_50': dict(Counter(train[i]['length_bucket'] for i in indices)),
        'sampler_50': summarize(train, indices),
        'dataset_hashes': {split: sha((ROOT / ('data/l5' if split == 'train' else 'data/l3') /
                                      f'{split}.jsonl').read_bytes())
                           for split in ('train', 'validation', 'heldout')},
        'l6_scheduled_50': source_trace['sampler']['scheduled_50'],
        'bf16_base_gib': round(larger['safetensors_total_bytes'] / 2**30, 3),
        'estimated_train_vram_gib': 'roughly 20-30; confirm in 2-step A40 smoke',
        'estimated_disk_gib': 'at least 30 for model cache, optimizer, five adapters, logs',
    }
    return report


if __name__ == '__main__':
    result = check()
    write_json(ROOT / 'corpus/metadata/l12_preflight.json', result)
    print(json.dumps(result, indent=2))
