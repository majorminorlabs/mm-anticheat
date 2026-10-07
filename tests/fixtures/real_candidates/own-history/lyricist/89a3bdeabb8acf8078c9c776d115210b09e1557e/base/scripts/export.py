"""Merge a verified PEFT checkpoint into the pinned base for GGUF conversion."""
import argparse,json
from pathlib import Path
from scripts.modeling import CONFIG
from scripts.pipeline import sha,write_json

def main():
    import torch
    from transformers import AutoModelForCausalLM,AutoTokenizer
    from peft import PeftModel
    p=argparse.ArgumentParser();p.add_argument('--adapter',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    tok=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'])
    base=AutoModelForCausalLM.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'],dtype=torch.bfloat16,device_map='cpu')
    merged=PeftModel.from_pretrained(base,a.adapter).merge_and_unload()
    merged.save_pretrained(out,safe_serialization=True,max_shard_size='4GB')
    tok.save_pretrained(out)
    adapter_file=Path(a.adapter)/'adapter_model.safetensors'
    write_json(out/'lyricist-export.json',{'base_id':CONFIG['model_id'],'base_revision':CONFIG['model_revision'],'adapter_path':a.adapter,'adapter_sha256':sha(adapter_file.read_bytes()),'dtype':'bfloat16'})
    print(out)
if __name__=='__main__':main()
