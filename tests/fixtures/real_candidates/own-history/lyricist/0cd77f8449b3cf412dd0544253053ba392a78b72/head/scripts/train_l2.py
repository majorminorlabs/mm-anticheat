"""L2 passage-level LoRA training from the same pinned base, with work-safe data."""
from __future__ import annotations
import argparse,json,random,time
from pathlib import Path
from scripts.modeling import ROOT,CONFIG,format_prompt
from scripts.pipeline import sha,write_json
from scripts.train import batchify,gpu_snapshot

L2={'seed':CONFIG['seed']+2,'max_sequence_length':256,'lora_rank':8,'lora_alpha':16,'lora_dropout':0.10,
    'learning_rate':6e-5,'weight_decay':0.01,'batch_size':2,'gradient_accumulation_steps':4,
    'max_steps':250,'eval_steps':50,'save_steps':50,'min_steps':150,'early_stop_patience':2,
    'early_stop_margin':0.02}

def rows(split):return [json.loads(x) for x in (ROOT/'data/l2'/f'{split}.jsonl').read_text().splitlines()]
def prepare(tokenizer,row):
    prefix=format_prompt(row['prompt'],row['length_control'])
    ids=tokenizer(prefix+row['target']+tokenizer.eos_token,add_special_tokens=False,truncation=True,max_length=L2['max_sequence_length'])['input_ids']
    n=len(tokenizer(prefix,add_special_tokens=False)['input_ids'])
    if len(ids)<=n or len(ids)>=L2['max_sequence_length']:raise ValueError(f'Truncated L2 target: {row["id"]}')
    return {'input_ids':ids,'attention_mask':[1]*len(ids),'labels':[-100]*n+ids[n:]}

def batch_indices(train_rows,step,micro):
    count=len(train_rows);indices=[]
    for j in range(L2['batch_size']):
        position=(step*L2['gradient_accumulation_steps']+micro)*L2['batch_size']+j
        epoch,offset=divmod(position,count)
        order=list(range(count));random.Random(L2['seed']+epoch).shuffle(order)
        indices.append(order[offset])
    return indices

def main():
    import torch
    from transformers import AutoTokenizer,AutoModelForCausalLM,get_linear_schedule_with_warmup
    from peft import LoraConfig,get_peft_model,PeftModel,TaskType
    p=argparse.ArgumentParser();p.add_argument('--out',required=True);p.add_argument('--smoke',action='store_true');p.add_argument('--resume',action='store_true');a=p.parse_args()
    if not torch.cuda.is_available():raise RuntimeError('CUDA unavailable')
    torch.manual_seed(L2['seed']);torch.cuda.manual_seed_all(L2['seed']);random.seed(L2['seed'])
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    train=rows('train');val=rows('validation');held=rows('heldout')
    assert {r['work_id'] for r in train}.isdisjoint({r['work_id'] for r in val+held})
    tok=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision']);tok.pad_token=tok.eos_token
    # Pre-tokenize once: the dataset is small and exact input lengths are a QA gate.
    train_prepared=[prepare(tok,r) for r in train]
    val_prepared=[prepare(tok,r) for r in val]
    held_prepared=[prepare(tok,r) for r in held]
    model=AutoModelForCausalLM.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'],dtype=torch.bfloat16,attn_implementation='sdpa')
    model.config.use_cache=False;model.gradient_checkpointing_enable();model.enable_input_require_grads();model.to('cuda')
    state_file=out/'optimizer.pt';last_adapter=out/'last'
    if a.resume and state_file.exists():model=PeftModel.from_pretrained(model,last_adapter,is_trainable=True)
    else:model=get_peft_model(model,LoraConfig(r=L2['lora_rank'],lora_alpha=L2['lora_alpha'],lora_dropout=L2['lora_dropout'],
        target_modules=['q_proj','v_proj'],bias='none',task_type=TaskType.CAUSAL_LM))
    model.train()
    opt=torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),lr=L2['learning_rate'],weight_decay=L2['weight_decay'])
    steps=2 if a.smoke else L2['max_steps'];accum=L2['gradient_accumulation_steps']
    scheduler=get_linear_schedule_with_warmup(opt,max(1,round(steps*.1)),steps)
    start=0;best_val=float('inf');worse=0
    if a.resume and state_file.exists():
        state=torch.load(state_file,map_location='cpu',weights_only=False)
        opt.load_state_dict(state['optimizer']);scheduler.load_state_dict(state['scheduler']);start=state['step']
        best_val=state['best_val'];worse=state['worse']
        torch.set_rng_state(state['torch_rng']);torch.cuda.set_rng_state_all(state['cuda_rng'])
    dataset_hashes={s:sha((ROOT/'data/l2'/f'{s}.jsonl').read_bytes()) for s in ('train','validation','heldout')}
    manifest={'base_id':CONFIG['model_id'],'base_revision':CONFIG['model_revision'],'l2_config':L2,
      'dataset_hashes':dataset_hashes,'train_examples':len(train),'train_works':len({r['work_id'] for r in train}),
      'validation_examples':len(val),'heldout_examples':len(held),'smoke':a.smoke,
      'started_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'checkpoints':[]}
    if not a.resume:write_json(out/'run.json',manifest)
    else:manifest=json.loads((out/'run.json').read_text())
    start_time=time.time();log=out/'metrics.jsonl'
    def evaluate(examples):
        model.eval();losses=[]
        with torch.inference_mode():
            for ex in examples:
                b=batchify(tok,[ex],'cuda')
                with torch.autocast('cuda',dtype=torch.bfloat16):losses.append(float(model(**b).loss))
        model.train();return sum(losses)/len(losses)
    for step in range(start,steps):
        opt.zero_grad(set_to_none=True);losses=[]
        for micro in range(accum):
            indices=batch_indices(train,step,micro)
            b=batchify(tok,[train_prepared[i] for i in indices],'cuda')
            with torch.autocast('cuda',dtype=torch.bfloat16):loss=model(**b).loss/accum
            loss.backward();losses.append(float(loss.detach())*accum)
        torch.nn.utils.clip_grad_norm_(model.parameters(),1.0)
        opt.step();scheduler.step();n=step+1
        checkpoint=a.smoke or n%L2['eval_steps']==0 or n==steps
        record={'step':n,'effective_epochs':round(n*accum*L2['batch_size']/len(train),3),
          'train_loss':round(sum(losses)/len(losses),5),'lr':scheduler.get_last_lr()[0],
          'elapsed_seconds':round(time.time()-start_time,2)}
        if checkpoint:
            record.update({'validation_loss':round(evaluate(val_prepared),5),'heldout_loss':round(evaluate(held_prepared),5),
                'gpu':gpu_snapshot(),'peak_allocated_mib':round(torch.cuda.max_memory_allocated()/2**20,1)})
            if record['validation_loss']<best_val:
                best_val=record['validation_loss'];worse=0
            elif record['validation_loss']>best_val+L2['early_stop_margin']:worse+=1
            else:worse=0
            cp=out/f'checkpoint-{n:03d}';model.save_pretrained(cp,safe_serialization=True)
            model.save_pretrained(last_adapter,safe_serialization=True)
            adapter_hash=sha((cp/'adapter_model.safetensors').read_bytes())
            record['adapter_sha256']=adapter_hash
            manifest['checkpoints'].append({'step':n,'adapter_sha256':adapter_hash,'validation_loss':record['validation_loss'],
                'heldout_loss':record['heldout_loss']})
            write_json(out/'run.json',manifest)
            torch.save({'step':n,'optimizer':opt.state_dict(),'scheduler':scheduler.state_dict(),
                'torch_rng':torch.get_rng_state(),'cuda_rng':torch.cuda.get_rng_state_all(),
                'best_val':best_val,'worse':worse},state_file)
        with log.open('a') as f:f.write(json.dumps(record)+'\n')
        if checkpoint:print(json.dumps(record),flush=True)
        if not a.smoke and checkpoint and n>=L2['min_steps'] and worse>=L2['early_stop_patience']:
            print(f'early-stop at {n}: validation deterioration',flush=True);break
    manifest['finished_at_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    manifest['wall_time_seconds']=round(time.time()-start_time,2);manifest['completed_steps']=n
    write_json(out/'run.json',manifest)
    print(f'complete {out}: {n} updates in {manifest["wall_time_seconds"]} s',flush=True)
if __name__=='__main__':main()
