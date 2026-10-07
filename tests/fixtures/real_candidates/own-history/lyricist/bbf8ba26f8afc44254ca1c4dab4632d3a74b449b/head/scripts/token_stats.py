"""Compute per-work tokenizer counts without editing source or changing splits."""
import json
from pathlib import Path
from scripts.modeling import ROOT,CONFIG
from scripts.pipeline import write_json

def main():
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'])
    manifest=json.loads((ROOT/'corpus/metadata/manifest.json').read_text())
    token_stats=[]
    for work in manifest:
        text=(ROOT/'corpus/cleaned'/f"{work['work_id']}.txt").read_text()
        token_stats.append({'work_id':work['work_id'],'split':work['split'],'source_sha256':work['source_sha256'],'token_count':len(tokenizer(text,add_special_tokens=False)['input_ids'])})
    write_json(ROOT/'corpus/metadata/token_stats.json',{'model_id':CONFIG['model_id'],'model_revision':CONFIG['model_revision'],'works':token_stats,'total_tokens':sum(x['token_count'] for x in token_stats)})
    print(sum(x['token_count'] for x in token_stats))
if __name__=='__main__':main()
