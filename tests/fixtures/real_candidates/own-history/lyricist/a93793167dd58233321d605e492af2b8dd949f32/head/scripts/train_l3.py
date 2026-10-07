"""L3 passage LoRA trainer, paused at step 100 for behavioral review."""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

from scripts.modeling import CONFIG, ROOT, format_prompt
from scripts.pipeline import sha, write_json
from scripts.train import batchify, gpu_snapshot

L3 = {'seed': CONFIG['seed'] + 3, 'max_sequence_length': 384,
      'lora_rank': 8, 'lora_alpha': 16, 'lora_dropout': .10,
      'learning_rate': 6e-5, 'weight_decay': .01,
      'batch_size': 2, 'gradient_accumulation_steps': 4,
      'max_steps': 200, 'checkpoints': [25, 50, 75, 100, 150, 200],
      'early_stop_margin': .02, 'early_stop_patience': 2,
      'min_early_stop_step': 75}


def rows(split):
    return [json.loads(line) for line in (ROOT / 'data/l3' / f'{split}.jsonl').read_text().splitlines()]


def prepare(tokenizer, row):
    prefix = format_prompt(row['prompt'], row['length_control'])
    prefix_ids = tokenizer(prefix, add_special_tokens=False)['input_ids']
    target_ids = tokenizer(row['target'], add_special_tokens=False)['input_ids']
    eos = tokenizer.eos_token_id
    if eos in prefix_ids or eos in target_ids:
        raise ValueError(f'Unexpected early EOS in {row["id"]}')
    ids = prefix_ids + target_ids + [eos]
    if len(ids) > L3['max_sequence_length']:
        raise ValueError(f'L3 sequence would truncate: {row["id"]} ({len(ids)})')
    if len(target_ids) < 8:
        raise ValueError(f'L3 target too short: {row["id"]}')
    return {'input_ids': ids, 'attention_mask': [1] * len(ids),
            'labels': [-100] * len(prefix_ids) + target_ids + [eos]}


def batch_indices(train_rows, step, micro):
    result = []
    for j in range(L3['batch_size']):
        position = (step * L3['gradient_accumulation_steps'] + micro) * L3['batch_size'] + j
        epoch, offset = divmod(position, len(train_rows))
        order = list(range(len(train_rows)))
        random.Random(L3['seed'] + epoch).shuffle(order)
        result.append(order[offset])
    return result


def main():
    import torch
    from peft import LoraConfig, PeftModel, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, get_linear_schedule_with_warmup

    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--smoke', action='store_true')
    p.add_argument('--resume', action='store_true')
    p.add_argument('--stop-at', type=int, default=100)
    args = p.parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable')
    if not 1 <= args.stop_at <= L3['max_steps']:
        raise ValueError('Invalid stop-at step')
    torch.manual_seed(L3['seed'])
    torch.cuda.manual_seed_all(L3['seed'])
    random.seed(L3['seed'])
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    train, val, held = rows('train'), rows('validation'), rows('heldout')
    assert {r['work_id'] for r in train}.isdisjoint({r['work_id'] for r in val + held})
    tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer.pad_token = tokenizer.eos_token
    prepared = {split: [prepare(tokenizer, r) for r in data]
                for split, data in (('train', train), ('validation', val), ('heldout', held))}
    model = AutoModelForCausalLM.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'],
                dtype=torch.bfloat16, attn_implementation='sdpa')
    model.config.use_cache = False
    model.gradient_checkpointing_enable()
    model.enable_input_require_grads()
    model.to('cuda')
    state_path = out / 'optimizer.pt'
    adapter_path = out / 'last'
    if args.resume and state_path.exists():
        model = PeftModel.from_pretrained(model, adapter_path, is_trainable=True)
    else:
        model = get_peft_model(model, LoraConfig(r=L3['lora_rank'], lora_alpha=L3['lora_alpha'],
            lora_dropout=L3['lora_dropout'], target_modules=['q_proj', 'v_proj'], bias='none',
            task_type=TaskType.CAUSAL_LM))
    model.train()
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                  lr=L3['learning_rate'], weight_decay=L3['weight_decay'])
    total_steps = 2 if args.smoke else L3['max_steps']
    scheduler = get_linear_schedule_with_warmup(optimizer, max(1, round(total_steps * .1)), total_steps)
    start = 0
    best_val, worse = float('inf'), 0
    dataset_hashes = {split: sha((ROOT / 'data/l3' / f'{split}.jsonl').read_bytes())
                      for split in ('train', 'validation', 'heldout')}
    manifest = {'base_id': CONFIG['model_id'], 'base_revision': CONFIG['model_revision'],
                'l3_config': L3, 'dataset_hashes': dataset_hashes,
                'train_examples': len(train), 'train_works': len({r['work_id'] for r in train}),
                'validation_examples': len(val), 'heldout_examples': len(held),
                'smoke': args.smoke, 'started_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'checkpoints': [], 'wall_time_seconds': 0.0}
    if args.resume:
        if not state_path.exists():
            raise ValueError('No saved L3 optimizer state to resume')
        state = torch.load(state_path, map_location='cpu', weights_only=False)
        optimizer.load_state_dict(state['optimizer'])
        scheduler.load_state_dict(state['scheduler'])
        start = state['step']
        best_val, worse = state['best_val'], state['worse']
        torch.set_rng_state(state['torch_rng'])
        torch.cuda.set_rng_state_all(state['cuda_rng'])
        manifest = json.loads((out / 'run.json').read_text())
        if manifest['dataset_hashes'] != dataset_hashes:
            raise ValueError('L3 dataset changed before resume')
    else:
        write_json(out / 'run.json', manifest)
    stop_at = 2 if args.smoke else args.stop_at
    if stop_at <= start:
        raise ValueError('Stop-at step is not beyond saved step')
    phase_start = time.time()
    log = out / 'metrics.jsonl'

    def mean_loss(examples):
        model.eval()
        losses = []
        with torch.inference_mode():
            for example in examples:
                batch = batchify(tokenizer, [example], 'cuda')
                with torch.autocast('cuda', dtype=torch.bfloat16):
                    losses.append(float(model(**batch).loss))
        model.train()
        return sum(losses) / len(losses)

    for step in range(start, stop_at):
        optimizer.zero_grad(set_to_none=True)
        losses = []
        for micro in range(L3['gradient_accumulation_steps']):
            selected = batch_indices(train, step, micro)
            batch = batchify(tokenizer, [prepared['train'][i] for i in selected], 'cuda')
            with torch.autocast('cuda', dtype=torch.bfloat16):
                loss = model(**batch).loss / L3['gradient_accumulation_steps']
            loss.backward()
            losses.append(float(loss.detach()) * L3['gradient_accumulation_steps'])
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()
        number = step + 1
        checkpoint = args.smoke or number in L3['checkpoints'] or number == stop_at
        record = {'step': number,
                  'effective_epochs': round(number * L3['batch_size'] * L3['gradient_accumulation_steps'] / len(train), 3),
                  'train_loss': round(sum(losses) / len(losses), 5),
                  'lr': scheduler.get_last_lr()[0],
                  'elapsed_seconds': round(manifest['wall_time_seconds'] + time.time() - phase_start, 2)}
        if checkpoint:
            record['validation_loss'] = round(mean_loss(prepared['validation']), 5)
            record['heldout_loss'] = round(mean_loss(prepared['heldout']), 5)
            record['gpu'] = gpu_snapshot()
            record['peak_allocated_mib'] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
            if record['validation_loss'] < best_val:
                best_val, worse = record['validation_loss'], 0
            elif record['validation_loss'] > best_val + L3['early_stop_margin']:
                worse += 1
            else:
                worse = 0
            adapter = out / f'checkpoint-{number:03d}'
            model.save_pretrained(adapter, safe_serialization=True)
            model.save_pretrained(adapter_path, safe_serialization=True)
            adapter_hash = sha((adapter / 'adapter_model.safetensors').read_bytes())
            record['adapter_sha256'] = adapter_hash
            manifest['checkpoints'].append({'step': number, 'adapter_sha256': adapter_hash,
                'validation_loss': record['validation_loss'], 'heldout_loss': record['heldout_loss']})
            write_json(out / 'run.json', manifest)
            torch.save({'step': number, 'optimizer': optimizer.state_dict(),
                        'scheduler': scheduler.state_dict(), 'torch_rng': torch.get_rng_state(),
                        'cuda_rng': torch.cuda.get_rng_state_all(), 'best_val': best_val, 'worse': worse},
                       state_path)
        with log.open('a') as handle:
            handle.write(json.dumps(record) + '\n')
        if checkpoint:
            print(json.dumps(record), flush=True)
        if not args.smoke and checkpoint and number >= L3['min_early_stop_step'] and worse >= L3['early_stop_patience']:
            print(f'early-stop at {number}: validation deterioration', flush=True)
            break
    manifest['completed_steps'] = number
    manifest['wall_time_seconds'] = round(manifest['wall_time_seconds'] + time.time() - phase_start, 2)
    manifest['last_phase_finished_at_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    write_json(out / 'run.json', manifest)
    print(f'complete phase {start + 1}-{number} in {manifest["wall_time_seconds"]} cumulative seconds', flush=True)


if __name__ == '__main__':
    main()
