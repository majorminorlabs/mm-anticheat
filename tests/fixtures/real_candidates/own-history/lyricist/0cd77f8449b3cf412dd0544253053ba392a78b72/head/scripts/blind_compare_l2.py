"""Private, deterministic three-way blind packet; answer key stored separately."""
import argparse,json,random
from pathlib import Path
from scripts.pipeline import write_json,write_jsonl

def read(path):return {x['id']:x for x in (json.loads(line) for line in Path(path).read_text().splitlines())}
def main():
    p=argparse.ArgumentParser();p.add_argument('--b0',required=True);p.add_argument('--l1',required=True);p.add_argument('--l2',required=True);p.add_argument('--out',required=True);a=p.parse_args()
    models={'B0':read(a.b0),'L1':read(a.l1),'L2':read(a.l2)}
    ids=set(models['B0'])
    if any(set(m)!=ids for m in models.values()):raise ValueError('Prompt sets differ')
    rng=random.Random(161803);packet=[];key={}
    for pid in sorted(ids):
        prompt=models['B0'][pid]['prompt']
        if any(m[pid]['prompt']!=prompt for m in models.values()):raise ValueError(f'Prompt changed: {pid}')
        choices=list(models);rng.shuffle(choices)
        record={'id':pid,'prompt':prompt,'A':models[choices[0]][pid]['output'],
            'B':models[choices[1]][pid]['output'],'C':models[choices[2]][pid]['output']}
        packet.append(record);key[pid]={'A':choices[0],'B':choices[1],'C':choices[2]}
    out=Path(a.out);out.mkdir(parents=True,exist_ok=True)
    write_jsonl(out/'review_packet.jsonl',packet);write_json(out/'answer_key.json',key)
    (out/'rubric.md').write_text('''# Blind B0/L1/L2 comparison\n\nRead A, B and C for each prompt before opening `answer_key.json`. Rate each output 1–5 for target-style feel, unusual phrasing, imagery, cadence, ambiguity, originality, prompt fit and overall preference. Note copying concerns or malformed text. Preserve the answer key separately until scoring is complete. These are generated outputs; source lyrics are not included.\n''')
    print(f'{len(packet)} blinded prompts')
if __name__=='__main__':main()
