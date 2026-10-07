"""Completion-only loss on the untouched complete-work holdout set."""
import argparse,json,statistics
from pathlib import Path
from scripts.modeling import ROOT,CONFIG,load_model
from scripts.train import prepare,batchify
from scripts.pipeline import write_json

def main():
    import torch
    p=argparse.ArgumentParser();p.add_argument('--adapter');p.add_argument('--out',required=True);a=p.parse_args()
    rows=[json.loads(x) for x in (ROOT/'data/heldout/heldout.jsonl').read_text().splitlines()]
    tok,model=load_model(a.adapter)
    losses=[]
    with torch.inference_mode():
        for row in rows:
            b=batchify(tok,[prepare(tok,row)],model.device)
            losses.append(float(model(**b).loss))
    result={'model_id':CONFIG['model_id'],'model_revision':CONFIG['model_revision'],'adapter':a.adapter,'heldout_works':len(rows),'mean_completion_loss':round(statistics.mean(losses),5),'per_work':[{'work_id':r['work_id'],'loss':round(v,5)} for r,v in zip(rows,losses)]}
    write_json(Path(a.out),result)
    print(json.dumps({k:v for k,v in result.items() if k!='per_work'},indent=2))
if __name__=='__main__':main()
