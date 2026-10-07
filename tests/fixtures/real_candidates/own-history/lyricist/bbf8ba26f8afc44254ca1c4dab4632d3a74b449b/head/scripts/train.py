"""Conservative LoRA trainer for the A40. One work per epoch, selected as SFT or raw."""
from __future__ import annotations
import argparse, json, math, random, subprocess, time
from pathlib import Path
from scripts.modeling import ROOT,CONFIG,format_prompt
from scripts.pipeline import sha,write_json

def rows(path): return [json.loads(x) for x in path.read_text().splitlines()]
def prepare(tokenizer,row,raw=False):
    text=row['text'] if raw else row['completion']
    prefix='' if raw else format_prompt(row['prompt'])
    ids=tokenizer(prefix+text+tokenizer.eos_token,add_special_tokens=False,truncation=True,max_length=CONFIG['max_sequence_length'])['input_ids']
    prefix_len=len(tokenizer(prefix,add_special_tokens=False)['input_ids'])
    if len(ids)<=prefix_len: raise ValueError('Completion truncated away')
    labels=[-100]*prefix_len+ids[prefix_len:]
    return {'input_ids':ids,'attention_mask':[1]*len(ids),'labels':labels}

def batchify(tokenizer, examples, device):
    import torch
    longest=max(len(x['input_ids']) for x in examples)
    fields={}
    for k,pad in [('input_ids',tokenizer.pad_token_id),('attention_mask',0),('labels',-100)]:
        fields[k]=torch.tensor([x[k]+[pad]*(longest-len(x[k])) for x in examples],device=device)
    return fields

def sample_ids(train_ids, update_step, micro, batch_size, accum, seed):
    indices=[]
    for j in range(batch_size):
        pos=(update_step*accum+micro)*batch_size+j
        epoch,offset=divmod(pos,len(train_ids))
        shuffled=train_ids.copy();random.Random(seed+epoch).shuffle(shuffled)
        work=shuffled[offset]
        raw=random.Random(seed+1000003+epoch*len(train_ids)+offset).random()<0.25
        indices.append((work,raw))
    return indices

def gpu_snapshot():
    try: return subprocess.check_output(['nvidia-smi','--query-gpu=name,memory.used,utilization.gpu','--format=csv,noheader'],text=True,timeout=5).strip()
    except Exception: return None

def main():
    import torch
    from transformers import AutoTokenizer,AutoModelForCausalLM,get_linear_schedule_with_warmup
    from peft import LoraConfig,get_peft_model,PeftModel,TaskType
    a=argparse.ArgumentParser();a.add_argument('--out',required=True);a.add_argument('--smoke',action='store_true');a.add_argument('--resume',action='store_true');args=a.parse_args()
    if not torch.cuda.is_available(): raise RuntimeError('CUDA unavailable')
    torch.manual_seed(CONFIG['seed']);random.seed(CONFIG['seed']);torch.cuda.manual_seed_all(CONFIG['seed'])
    out=Path(args.out);out.mkdir(parents=True,exist_ok=True)
    tok=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision']);tok.pad_token=tok.eos_token
    model=AutoModelForCausalLM.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'],dtype=torch.bfloat16,attn_implementation='sdpa')
    model.config.use_cache=False;model.gradient_checkpointing_enable();model.enable_input_require_grads();model.to('cuda')
    state_file=out/'optimizer.pt';last_adapter=out/'last'
    if args.resume and state_file.exists(): model=PeftModel.from_pretrained(model,last_adapter,is_trainable=True)
    else:
        lora=LoraConfig(r=CONFIG['lora_rank'],lora_alpha=CONFIG['lora_alpha'],lora_dropout=CONFIG['lora_dropout'],target_modules=['q_proj','v_proj'],bias='none',task_type=TaskType.CAUSAL_LM)
        model=get_peft_model(model,lora)
    model.train()
    optimizer=torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),lr=CONFIG['learning_rate'],weight_decay=0.01)
    steps=2 if args.smoke else CONFIG['max_steps'];accum=CONFIG['gradient_accumulation_steps'];batch_size=CONFIG['batch_size']
    scheduler=get_linear_schedule_with_warmup(optimizer,num_warmup_steps=max(1,round(steps*0.1)),num_training_steps=steps)
    start=0
    if args.resume and state_file.exists():
        state=torch.load(state_file,map_location='cpu',weights_only=False)
        optimizer.load_state_dict(state['optimizer']);scheduler.load_state_dict(state['scheduler']);start=state['step']
        torch.set_rng_state(state['torch_rng']);torch.cuda.set_rng_state_all(state['cuda_rng'])
    sft={x['work_id']:x for x in rows(ROOT/'data/sft/train.jsonl')}
    raw={x['work_id']:x for x in rows(ROOT/'data/pretrain/train.jsonl')}
    val=rows(ROOT/'data/sft/validation.jsonl')
    if sft.keys()!=raw.keys(): raise ValueError('Training work representations differ')
    train_ids=sorted(sft)
    manifest={'model_id':CONFIG['model_id'],'model_revision':CONFIG['model_revision'],'config':CONFIG,'dataset_hashes':json.loads((ROOT/'corpus/metadata/dataset_hashes.json').read_text()),'train_works':len(train_ids),'validation_works':len(val),'representation_sampling':{'generation':0.75,'raw_style':0.25},'started_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'smoke':args.smoke}
    write_json(out/'run.json',manifest)
    log=out/'metrics.jsonl';start_time=time.time()
    def val_loss():
        model.eval();losses=[]
        with torch.inference_mode():
            for row in val:
                ex=prepare(tok,row)
                b=batchify(tok,[ex],'cuda')
                with torch.autocast('cuda',dtype=torch.bfloat16): losses.append(float(model(**b).loss))
        model.train();return sum(losses)/len(losses)
    for step in range(start,steps):
        optimizer.zero_grad(set_to_none=True);losses=[]
        for micro in range(accum):
            selected=sample_ids(train_ids,step,micro,batch_size,accum,CONFIG['seed'])
            examples=[prepare(tok,(raw if is_raw else sft)[wid],is_raw) for wid,is_raw in selected]
            b=batchify(tok,examples,'cuda')
            with torch.autocast('cuda',dtype=torch.bfloat16): loss=model(**b).loss/accum
            loss.backward();losses.append(float(loss.detach())*accum)
        torch.nn.utils.clip_grad_norm_(model.parameters(),1.0)
        optimizer.step();scheduler.step()
        n=step+1;do_eval=args.smoke or n%CONFIG['eval_steps']==0 or n==steps
        record={'step':n,'epoch_equivalent':round(n*accum*batch_size/len(train_ids),3),'train_loss':round(sum(losses)/len(losses),5),'lr':scheduler.get_last_lr()[0],'elapsed_seconds':round(time.time()-start_time,1),'gpu':gpu_snapshot() if do_eval else None}
        if do_eval: record['validation_loss']=round(val_loss(),5)
        with log.open('a') as f:f.write(json.dumps(record)+'\n')
        print(json.dumps(record),flush=True)
        if args.smoke or n%CONFIG['save_steps']==0 or n==steps:
            checkpoint=out/f'checkpoint-{n:03d}';model.save_pretrained(checkpoint,safe_serialization=True)
            model.save_pretrained(last_adapter,safe_serialization=True)
            torch.save({'step':n,'optimizer':optimizer.state_dict(),'scheduler':scheduler.state_dict(),'torch_rng':torch.get_rng_state(),'cuda_rng':torch.cuda.get_rng_state_all()},state_file)
    print('complete',out,flush=True)
if __name__=='__main__':main()
