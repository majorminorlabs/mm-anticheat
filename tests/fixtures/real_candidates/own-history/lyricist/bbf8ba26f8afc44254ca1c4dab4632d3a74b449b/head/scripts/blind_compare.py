"""Create a blinded B0/L1 human-review packet with a separate answer key."""
import argparse,json,random
from pathlib import Path
from scripts.pipeline import write_json,write_jsonl

def main():
    p=argparse.ArgumentParser();p.add_argument('--b0',required=True);p.add_argument('--l1',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    b={x['id']:x for x in map(json.loads,Path(a.b0).read_text().splitlines())}
    l={x['id']:x for x in map(json.loads,Path(a.l1).read_text().splitlines())}
    if b.keys()!=l.keys():raise ValueError('Prompt sets differ')
    rng=random.Random(271828);packet=[];key={}
    for pid in sorted(b):
        pair=[('B0',b[pid]),('L1',l[pid])];rng.shuffle(pair)
        packet.append({'id':pid,'prompt':b[pid]['prompt'],'A':pair[0][1]['output'],'B':pair[1][1]['output']})
        key[pid]={'A':pair[0][0],'B':pair[1][0]}
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    write_jsonl(out/'review_packet.jsonl',packet);write_json(out/'answer_key.json',key)
if __name__=='__main__':main()
