"""Fixed-prompt generation and conservative overlap diagnostics."""
from __future__ import annotations
import argparse, difflib, json, random, re, statistics
from collections import Counter
from pathlib import Path
from scripts.l4_sampler import WEIGHTS
from scripts.modeling import ROOT,CONFIG,generate,load_model
from scripts.pipeline import words,sha,write_json,write_jsonl

NORMAL = re.compile(r"\b[\w]+(?:[’'][\w]+)*\b",re.UNICODE)
def norm_words(text:str)->list[str]: return [x.casefold().replace('’',"'") for x in NORMAL.findall(text)]
def ngrams(tokens,n): return {tuple(tokens[i:i+n]) for i in range(len(tokens)-n+1)}

def score_text(text:str, train:list[dict], requested_length:str|None=None)->dict:
    toks=norm_words(text); lines=[x.strip() for x in text.splitlines() if x.strip()]
    counts=Counter(x.casefold() for x in lines)
    repeated=sum(v-1 for v in counts.values() if v>1)
    train_tokens=[norm_words(x['text']) for x in train]
    longest=0; nearest=None; nearest_ratio=0.; shared5=set(); tri=ngrams(toks,3)
    for row,source in zip(train,train_tokens):
        match=difflib.SequenceMatcher(None,toks,source,autojunk=False).find_longest_match(0,len(toks),0,len(source))
        ratio=len(tri & ngrams(source,3))/max(1,len(tri))
        shared5 |= ngrams(toks,5) & ngrams(source,5)
        if match.size>longest: longest=match.size
        if ratio>nearest_ratio: nearest_ratio=ratio; nearest=row['work_id']
    ranges={'short':(12,80),'medium':(35,150),'long':(65,240)}
    lo,hi=ranges.get(requested_length,(0,10**9))
    return {'word_count':len(toks),'line_count':len(lines),'mean_line_words':round(statistics.mean((len(norm_words(x)) for x in lines)),2) if lines else 0,
      'type_token_ratio':round(len(set(toks))/max(1,len(toks)),4),'duplicate_line_count':repeated,
      'repeated_line_fraction':round(repeated/max(1,len(lines)),4),'length_adherent':lo<=len(toks)<=hi,
      'distinct_trigrams':len(tri),'overlap_5gram_count':len(shared5),'longest_train_phrase_words':longest,
      'nearest_train_work_id':nearest,'nearest_train_trigram_overlap':round(nearest_ratio,4),
      'memorization_flag':longest>=10 or (longest>=7 and nearest_ratio>=0.2)}

def evaluate(input_path:Path, output_dir:Path):
    prompts=json.loads((ROOT/'data/eval/prompts.json').read_text())
    train=[json.loads(x) for x in (ROOT/'data/pretrain/train.jsonl').read_text().splitlines()]
    rows=[json.loads(x) for x in input_path.read_text().splitlines()]
    by_id={x['id']:x for x in prompts}
    scored=[]
    for r in rows:
        p=by_id[r['id']]
        scored.append({**r,'metrics':score_text(r['output'],train,p.get('length'))})
    output_dir.mkdir(parents=True,exist_ok=True)
    write_jsonl(output_dir/'scored.jsonl',scored)
    nums=[x['metrics'] for x in scored]
    summary={'count':len(rows),'length_adherence_rate':round(sum(x['length_adherent'] for x in nums)/len(nums),3),
      'mean_words':round(statistics.mean(x['word_count'] for x in nums),1),
      'mean_duplicate_lines':round(statistics.mean(x['duplicate_line_count'] for x in nums),2),
      'mean_type_token_ratio':round(statistics.mean(x['type_token_ratio'] for x in nums),3),
      'mean_line_words':round(statistics.mean(x['mean_line_words'] for x in nums),2),
      'mean_overlap_5grams':round(statistics.mean(x['overlap_5gram_count'] for x in nums),2),
      'max_longest_train_phrase_words':max(x['longest_train_phrase_words'] for x in nums),
      'memorization_flags':sum(x['memorization_flag'] for x in nums)}
    write_json(output_dir/'summary.json',summary)
    blind=[{'id':r['id'],'text':r['output']} for r in scored]
    random.Random(314159).shuffle(blind)
    write_jsonl(output_dir/'blind.jsonl',blind)
    return summary

def run_generation(adapter,output_dir,limit=None):
    prompts=json.loads((ROOT/'data/eval/prompts.json').read_text())
    if limit: prompts=prompts[:limit]
    tokenizer,model=load_model(adapter)
    rows=[]
    for i,p in enumerate(prompts):
        out=generate(tokenizer,model,p['prompt'],p['length'],form=p.get('form'),seed=CONFIG['seed']+i)
        rows.append({'id':p['id'],'prompt':p['prompt'],'length':p['length'],'form':p.get('form'),'seed':CONFIG['seed']+i,'output':out})
        if (i+1)%10==0: print(f'generated {i+1}/{len(prompts)}',flush=True)
    output_dir.mkdir(parents=True,exist_ok=True)
    write_jsonl(output_dir/'generations.jsonl',rows)
    run={'model_id':CONFIG['model_id'],'model_revision':CONFIG['model_revision'],'adapter':adapter,
         'dataset_hashes':json.loads((ROOT/'corpus/metadata/dataset_hashes.json').read_text()),
         'generation':{'temperature':0.85,'top_p':0.92,'repetition_penalty':1.08,'max_new_tokens':'by length category'},
         'prompts_sha256':sha((ROOT/'data/eval/prompts.json').read_bytes())}
    if adapter and '/l2/' in f'/{adapter}/':
        run['l2_dataset_hashes']=json.loads((ROOT/'corpus/metadata/l2_dataset.json').read_text())['hashes']
    if adapter and '/l3/' in f'/{adapter}/':
        run['l3_dataset_hashes']=json.loads((ROOT/'corpus/metadata/l3_dataset.json').read_text())['hashes']
    if adapter and '/l4/' in f'/{adapter}/':
        run['l3_dataset_hashes']=json.loads((ROOT/'corpus/metadata/l3_dataset.json').read_text())['hashes']
        run['l4_sampler_weights']=WEIGHTS
    write_json(output_dir/'run.json',run)
    print(json.dumps(evaluate(output_dir/'generations.jsonl',output_dir),indent=2))

if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--adapter');a.add_argument('--out',required=True);a.add_argument('--score-only');a.add_argument('--limit',type=int)
    args=a.parse_args()
    if args.score_only: print(json.dumps(evaluate(Path(args.score_only),Path(args.out)),indent=2))
    else: run_generation(args.adapter,Path(args.out),args.limit)
