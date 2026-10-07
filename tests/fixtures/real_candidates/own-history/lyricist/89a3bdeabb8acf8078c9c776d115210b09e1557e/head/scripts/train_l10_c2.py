"""L10 C2: unchanged L6 behavioral SFT on a frozen merged CPT base."""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

from scripts.l4_sampler import PLAN_STEPS, SEED, WEIGHTS, sample_plan, summarize
from scripts.terminal_eos_loss import terminal_eos_weighted_loss
from scripts.modeling import CONFIG, ROOT
from scripts.pipeline import sha, write_json
from scripts.train import batchify, gpu_snapshot
from scripts.train_l3 import prepare
from scripts.train_l5 import L5, rows


L6 = {**L5, 'checkpoints': [15, 25, 35, 40, 50]}


def main():
    import torch
    from peft import LoraConfig, PeftModel, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, get_linear_schedule_with_warmup

    p = argparse.ArgumentParser()
    p.add_argument('--out', required=True)
    p.add_argument('--base-path', required=True)
    p.add_argument('--smoke', action='store_true')
    p.add_argument('--resume', action='store_true')
    p.add_argument('--stop-at', type=int, default=50)
    p.add_argument('--terminal-eos-loss-weight', type=float, default=0.25)
    args = p.parse_args()
    if not 0 <= args.terminal_eos_loss_weight <= 1:
        raise ValueError('terminal_eos_loss_weight must be between 0 and 1')
    if not torch.cuda.is_available():
        raise RuntimeError('CUDA unavailable')
    if not 1 <= args.stop_at <= PLAN_STEPS:
        raise ValueError('Invalid stop-at step')
    torch.manual_seed(SEED)
    torch.cuda.manual_seed_all(SEED)
    random.seed(SEED)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    base_path = Path(args.base_path)
    merge_manifest = json.loads((base_path / 'l10_merge_manifest.json').read_text())
    if not merge_manifest.get('merged') or merge_manifest['original_revision'] != CONFIG['model_revision']:
        raise ValueError('C2 requires the selected pinned CPT merged base')
    for filename, expected_hash in merge_manifest['file_sha256'].items():
        if sha((base_path / filename).read_bytes()) != expected_hash:
            raise ValueError(f'Merged base hash changed: {filename}')
    train, val, held = rows('train'), rows('validation'), rows('heldout')
    assert {r['work_id'] for r in train}.isdisjoint({r['work_id'] for r in val + held})
    plan = sample_plan(train)
    scheduled_50 = summarize(train, plan[:50 * L6['batch_size'] * L6['gradient_accumulation_steps']])
    sampler = {'weights': WEIGHTS, 'seed': SEED, 'plan_steps': PLAN_STEPS,
               'full_plan_sha256': sha(json.dumps(plan, separators=(',', ':')).encode()),
               'scheduled_50': scheduled_50}
    tokenizer = AutoTokenizer.from_pretrained(CONFIG['model_id'], revision=CONFIG['model_revision'])
    tokenizer.pad_token = tokenizer.eos_token
    prepared = {split: [prepare(tokenizer, r) for r in data]
                for split, data in (('train', train), ('validation', val), ('heldout', held))}
    model = AutoModelForCausalLM.from_pretrained(base_path,
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
        model = get_peft_model(model, LoraConfig(r=L6['lora_rank'], lora_alpha=L6['lora_alpha'],
            lora_dropout=L6['lora_dropout'], target_modules=['q_proj', 'v_proj'], bias='none',
            task_type=TaskType.CAUSAL_LM))
    model.train()
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                  lr=L6['learning_rate'], weight_decay=L6['weight_decay'])
    total_steps = 2 if args.smoke else L6['max_steps']
    scheduler = get_linear_schedule_with_warmup(optimizer, max(1, round(total_steps * .1)), total_steps)
    start = 0
    best_val, worse = float('inf'), 0
    dataset_hashes = {split: sha((ROOT / ('data/l5' if split == 'train' else 'data/l3') / f'{split}.jsonl').read_bytes())
                      for split in ('train', 'validation', 'heldout')}
    manifest = {'base_id': CONFIG['model_id'], 'base_revision': CONFIG['model_revision'],
                'merged_base_path': str(base_path), 'merged_base_manifest_sha256': sha((base_path / 'l10_merge_manifest.json').read_bytes()),
                'selected_cpt_adapter_sha256': merge_manifest['cpt_adapter_sha256'],
                'l6_config': {**L6, 'terminal_eos_loss_weight': args.terminal_eos_loss_weight},
                'sampler': sampler, 'dataset_hashes': dataset_hashes,
                'train_examples': len(train), 'train_works': len({r['work_id'] for r in train}),
                'validation_examples': len(val), 'heldout_examples': len(held),
                'smoke': args.smoke, 'started_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'checkpoints': [], 'wall_time_seconds': 0.0}
    if args.resume:
        if not state_path.exists():
            raise ValueError('No saved L6 optimizer state to resume')
        state = torch.load(state_path, map_location='cpu', weights_only=False)
        optimizer.load_state_dict(state['optimizer'])
        scheduler.load_state_dict(state['scheduler'])
        start = state['step']
        best_val, worse = state['best_val'], state['worse']
        torch.set_rng_state(state['torch_rng'])
        torch.cuda.set_rng_state_all(state['cuda_rng'])
        manifest = json.loads((out / 'run.json').read_text())
        if (manifest['dataset_hashes'] != dataset_hashes or manifest['sampler'] != sampler
                or manifest['l6_config']['terminal_eos_loss_weight'] != args.terminal_eos_loss_weight
                or manifest['merged_base_manifest_sha256'] != sha((base_path / 'l10_merge_manifest.json').read_bytes())):
            raise ValueError('L6 data or sampler changed before resume')
    else:
        write_json(out / 'run.json', manifest)
    stop_at = 2 if args.smoke else args.stop_at
    if stop_at <= start:
        raise ValueError('Stop-at step is not beyond saved step')
    phase_start = time.time()
    log = out / 'metrics.jsonl'
    trace = out / 'sample_trace.jsonl'
    if args.resume:
        if len(trace.read_text().splitlines()) != start:
            raise ValueError('L6 sample trace does not match optimizer step')
    elif trace.exists():
        raise ValueError('L6 output directory already has a sample trace')

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
        unweighted_losses = []
        sampled_ids = []
        for micro in range(L6['gradient_accumulation_steps']):
            offset = (step * L6['gradient_accumulation_steps'] + micro) * L6['batch_size']
            selected = plan[offset:offset + L6['batch_size']]
            sampled_ids.extend(train[i]['id'] for i in selected)
            batch = batchify(tokenizer, [prepared['train'][i] for i in selected], 'cuda')
            with torch.autocast('cuda', dtype=torch.bfloat16):
                result = model(**batch)
                loss = terminal_eos_weighted_loss(result.logits, batch['labels'], tokenizer.eos_token_id,
                                                  args.terminal_eos_loss_weight) / L6['gradient_accumulation_steps']
            loss.backward()
            losses.append(float(loss.detach()) * L6['gradient_accumulation_steps'])
            unweighted_losses.append(float(result.loss.detach()))
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        scheduler.step()
        number = step + 1
        checkpoint = args.smoke or number in L6['checkpoints'] or number == stop_at
        record = {'step': number,
                  'effective_epochs': round(number * L6['batch_size'] * L6['gradient_accumulation_steps'] / len(train), 3),
                  'train_loss': round(sum(losses) / len(losses), 5),
                  'unweighted_train_loss': round(sum(unweighted_losses) / len(unweighted_losses), 5),
                  'lr': scheduler.get_last_lr()[0],
                  'elapsed_seconds': round(manifest['wall_time_seconds'] + time.time() - phase_start, 2)}
        if checkpoint:
            record['validation_loss'] = round(mean_loss(prepared['validation']), 5)
            record['heldout_loss'] = round(mean_loss(prepared['heldout']), 5)
            record['gpu'] = gpu_snapshot()
            record['peak_allocated_mib'] = round(torch.cuda.max_memory_allocated() / 2**20, 1)
            if record['validation_loss'] < best_val:
                best_val, worse = record['validation_loss'], 0
            elif record['validation_loss'] > best_val + L6['early_stop_margin']:
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
        with trace.open('a') as handle:
            handle.write(json.dumps({'step': number, 'sampled_ids': sampled_ids}) + '\n')
        if checkpoint:
            print(json.dumps(record), flush=True)
        if not args.smoke and checkpoint and number >= L6['min_early_stop_step'] and worse >= L6['early_stop_patience']:
            print(f'early-stop at {number}: validation deterioration', flush=True)
            break
    manifest['completed_steps'] = number
    manifest['wall_time_seconds'] = round(manifest['wall_time_seconds'] + time.time() - phase_start, 2)
    manifest['last_phase_finished_at_utc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    write_json(out / 'run.json', manifest)
    print(f'complete phase {start + 1}-{number} in {manifest["wall_time_seconds"]} cumulative seconds', flush=True)


if __name__ == '__main__':
    main()
