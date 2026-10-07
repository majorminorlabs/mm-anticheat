"""One-pass L10 raw causal-LM LoRA trainer (train works only)."""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

from scripts.build_l10_cpt import EFFECTIVE_BATCH
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, write_json
from scripts.train import gpu_snapshot

L10_CPT = {'seed': CONFIG['seed'] + 10, 'context_length': 512,
           'lora_rank': 8, 'lora_alpha': 16, 'lora_dropout': .1,
           'target_modules': ['q_proj', 'v_proj'], 'learning_rate': 2e-5,
           'weight_decay': .01, 'microbatch_size': 2, 'effective_batch': EFFECTIVE_BATCH,
           'gradient_clip': 1.0, 'objective': 'unweighted next-token causal LM'}


def read_split(split: str) -> list[dict]:
    return [json.loads(line) for line in (ROOT / f'data/l10/packed-{split}.jsonl').read_text().splitlines()]


def verify_data(metadata: dict, splits: dict[str, list[dict]]) -> None:
    for split, rows in splits.items():
        path = ROOT / f'data/l10/packed-{split}.jsonl'
        if sha(path.read_bytes()) != metadata['splits'][split]['packed_sha256']:
            raise ValueError(f'{split} packed data hash changed')
        if len(rows) != metadata['splits'][split]['sequences']:
            raise ValueError(f'{split} sequence count changed')
    manifest = json.loads((ROOT / 'corpus/metadata/manifest.json').read_text())
    split_ids = {split: {r['work_id'] for r in manifest if r['split'] == split} for split in splits}
    for split, rows in splits.items():
        owners = {work for row in rows for work in row['work_ids']}
        if owners != split_ids[split]:
            raise ValueError(f'{split} work boundary violation')
        if any(not 2 <= len(row['input_ids']) <= L10_CPT['context_length'] for row in rows):
            raise ValueError(f'{split} invalid chunk length')


def make_batch(rows: list[dict], pad_id: int, device: str):
    import torch
    longest = max(len(row['input_ids']) for row in rows)
    ids = [row['input_ids'] + [pad_id] * (longest - len(row['input_ids'])) for row in rows]
    attention = [[1] * len(row['input_ids']) + [0] * (longest - len(row['input_ids'])) for row in rows]
    labels = [row['input_ids'] + [-100] * (longest - len(row['input_ids'])) for row in rows]
    return {key: torch.tensor(value, device=device) for key, value in
            (('input_ids', ids), ('attention_mask', attention), ('labels', labels))}


def token_loss(model, batch):
    import torch.nn.functional as F
    logits = model(input_ids=batch['input_ids'], attention_mask=batch['attention_mask']).logits
    targets = batch['labels'][:, 1:].contiguous()
    loss_sum = F.cross_entropy(logits[:, :-1].contiguous().float().view(-1, logits.shape[-1]),
                               targets.view(-1), ignore_index=-100, reduction='sum')
    count = int((targets != -100).sum())
    return loss_sum, count


def main():
    import torch
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, get_linear_schedule_with_warmup

    parser = argparse.ArgumentParser()
    parser.add_argument('--out', required=True)
    parser.add_argument('--smoke', action='store_true')
    args = parser.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    metadata_path = ROOT / 'corpus/metadata/l10_cpt_dataset.json'
    metadata = json.loads(metadata_path.read_text())
    splits = {split: read_split(split) for split in ('train', 'validation', 'heldout')}
    verify_data(metadata, splits)
    total_steps = math.ceil(len(splits['train']) / EFFECTIVE_BATCH)
    scheduled = {r['step']: r for r in metadata['checkpoint_schedule']}
    if total_steps != max(scheduled):
        raise ValueError('CPT schedule/data mismatch')
    torch.manual_seed(L10_CPT['seed'])
    torch.cuda.manual_seed_all(L10_CPT['seed'])
    tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer.pad_token = tokenizer.eos_token
    if tokenizer.eos_token_id != metadata['tokenizer_eos_id']:
        raise ValueError('EOS token changed')
    model = AutoModelForCausalLM.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'],
                dtype=torch.bfloat16, attn_implementation='sdpa')
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model.to('cuda')
    model = get_peft_model(model, LoraConfig(r=L10_CPT['lora_rank'], lora_alpha=L10_CPT['lora_alpha'],
        lora_dropout=L10_CPT['lora_dropout'], target_modules=L10_CPT['target_modules'],
        bias='none', task_type=TaskType.CAUSAL_LM))
    model.train()
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                   lr=L10_CPT['learning_rate'], weight_decay=L10_CPT['weight_decay'])
    # Six updates are too few for a zero-LR warmup: checkpoint 1 must see learning.
    scheduler = get_linear_schedule_with_warmup(optimizer, 0, total_steps)
    run = {'base_id': CONFIG['model_id'], 'base_revision': CONFIG['model_revision'],
           'config': L10_CPT, 'data_metadata_sha256': sha(metadata_path.read_bytes()),
           'packed_hashes': {s: metadata['splits'][s]['packed_sha256'] for s in splits},
           'smoke': args.smoke, 'planned_steps': total_steps, 'checkpoint_schedule': metadata['checkpoint_schedule'],
           'started_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'checkpoints': []}
    write_json(out / 'run.json', run)
    start = time.time()

    def evaluate(rows):
        model.eval()
        total_loss = 0.0
        total_tokens = 0
        with torch.inference_mode():
            for row in rows:
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    loss, count = token_loss(model, make_batch([row], tokenizer.pad_token_id, 'cuda'))
                total_loss += float(loss)
                total_tokens += count
        model.train()
        return round(total_loss / total_tokens, 6), total_tokens

    end_step = 2 if args.smoke else total_steps
    for step in range(1, end_step + 1):
        selected = splits['train'][(step - 1) * EFFECTIVE_BATCH:step * EFFECTIVE_BATCH]
        denominator = sum(len(row['input_ids']) - 1 for row in selected)
        optimizer.zero_grad(set_to_none=True)
        loss_total = 0.0
        for offset in range(0, len(selected), L10_CPT['microbatch_size']):
            micro = selected[offset:offset + L10_CPT['microbatch_size']]
            with torch.autocast('cuda', dtype=torch.bfloat16):
                loss, count = token_loss(model, make_batch(micro, tokenizer.pad_token_id, 'cuda'))
                scaled = loss / denominator
            scaled.backward()
            loss_total += float(loss.detach())
        torch.nn.utils.clip_grad_norm_(model.parameters(), L10_CPT['gradient_clip'])
        optimizer.step()
        scheduler.step()
        record = {'step': step, 'train_update_loss': round(loss_total / denominator, 6),
                  'sequences_seen': min(step * EFFECTIVE_BATCH, len(splits['train'])),
                  'supervised_tokens_in_update': denominator,
                  'lr_used_for_update': L10_CPT['learning_rate'] * (total_steps - step + 1) / total_steps,
                  'lr_after_update': scheduler.get_last_lr()[0],
                  'elapsed_seconds': round(time.time() - start, 2)}
        if step in scheduled or args.smoke:
            for split in splits:
                record[f'{split}_raw_lm_loss'], record[f'{split}_raw_lm_tokens'] = evaluate(splits[split])
            record['gpu'] = gpu_snapshot()
            record['peak_allocated_mib'] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
            if step in scheduled:
                record['effective_supervised_passes'] = scheduled[step]['effective_supervised_passes']
            folder = out / f'checkpoint-{step:03d}'
            model.save_pretrained(folder, safe_serialization=True)
            record['adapter_sha256'] = sha((folder / 'adapter_model.safetensors').read_bytes())
            run['checkpoints'].append({key: record[key] for key in ('step', 'train_raw_lm_loss',
                'validation_raw_lm_loss', 'heldout_raw_lm_loss', 'adapter_sha256')})
            write_json(out / 'run.json', run)
        with (out / 'metrics.jsonl').open('a') as handle:
            handle.write(json.dumps(record) + '\n')
        print(json.dumps(record), flush=True)
    run['completed_steps'] = end_step
    run['wall_time_seconds'] = round(time.time() - start, 2)
    run['finished_at_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    write_json(out / 'run.json', run)


if __name__ == '__main__':
    main()
