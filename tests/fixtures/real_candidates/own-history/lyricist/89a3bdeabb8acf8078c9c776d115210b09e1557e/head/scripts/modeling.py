"""Shared model identity, prompt syntax and generation settings."""
from __future__ import annotations
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
CONFIG=json.loads((ROOT/'config/experiment.json').read_text())
PREFIX='Write only original creative text. No preface.\nRequest: '
SUFFIX='\n\nText:\n'
LENGTH_TOKENS={'short':96,'medium':160,'long':240}

def format_prompt(request:str, length:str|None=None, mood:str|None=None, form:str|None=None)->str:
    fields=[request.strip()]
    if length: fields.append(f'length: {length}')
    if mood: fields.append(f'mood: {mood.strip()}')
    if form: fields.append(f'form: {form.strip()}')
    return PREFIX+'\n'.join(fields)+SUFFIX

def load_model(adapter: str|None=None, device_map='auto', base_path: str|None=None):
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    tokenizer=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'])
    tokenizer.pad_token=tokenizer.eos_token
    source=base_path or CONFIG['model_id']
    revision=None if base_path else CONFIG['model_revision']
    model=AutoModelForCausalLM.from_pretrained(source,revision=revision,dtype=torch.bfloat16,device_map=device_map,attn_implementation='sdpa')
    if adapter:
        from peft import PeftModel
        model=PeftModel.from_pretrained(model,adapter)
    model.eval()
    return tokenizer,model

def generate(tokenizer,model,request:str,length='medium',mood=None,form=None,temperature=0.85,seed=0):
    import torch
    prompt=format_prompt(request,length,mood,form)
    inputs=tokenizer(prompt,return_tensors='pt').to(model.device)
    torch.manual_seed(seed)
    if torch.cuda.is_available(): torch.cuda.manual_seed_all(seed)
    with torch.inference_mode():
        out=model.generate(**inputs,max_new_tokens=LENGTH_TOKENS[length],do_sample=True,temperature=temperature,top_p=0.92,repetition_penalty=1.08,pad_token_id=tokenizer.eos_token_id,eos_token_id=tokenizer.eos_token_id)
    return tokenizer.decode(out[0,inputs['input_ids'].shape[1]:],skip_special_tokens=True).strip()
