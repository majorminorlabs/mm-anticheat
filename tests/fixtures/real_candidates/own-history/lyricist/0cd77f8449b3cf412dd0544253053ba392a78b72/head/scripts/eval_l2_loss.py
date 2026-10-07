"""Completion-only loss on the fixed L2 passage probes, never used for training."""
import argparse,json,statistics
from collections import defaultdict
from pathlib import Path
from scripts.modeling import ROOT,CONFIG,load_model
from scripts.pipeline import write_json
from scripts.train import batchify
from scripts.train_l2 import prepare,rows

def main():
    import torch
    p=argparse.ArgumentParser();p.add_argument('--adapter');p.add_argument('--split',choices=('validation','heldout'),default='heldout');p.add_argument('--out',required=True);a=p.parse_args()
    passages=rows(a.split);tok,model=load_model(a.adapter)
    losses=[];by_work=defaultdict(list)
    with torch.inference_mode():
        for row in passages:
            batch=batchify(tok,[prepare(tok,row)],model.device)
            value=float(model(**batch).loss)
            losses.append(value);by_work[row['work_id']].append(value)
    result={'base_id':CONFIG['model_id'],'base_revision':CONFIG['model_revision'],'adapter':a.adapter,
      'split':a.split,'passages':len(passages),'works':len(by_work),
      'mean_passage_loss':round(statistics.mean(losses),5),
      'mean_work_loss':round(statistics.mean(statistics.mean(v) for v in by_work.values()),5)}
    write_json(Path(a.out),result);print(json.dumps(result,indent=2))
if __name__=='__main__':main()
