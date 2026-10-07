"""Audit frozen L2 passages, provenance, duplication, leakage and prompt grounding."""
from __future__ import annotations
import argparse,difflib,json,statistics,unicodedata
from collections import Counter
from pathlib import Path
from scripts.modeling import ROOT,CONFIG
from scripts.pipeline import sha,words,write_json
from scripts.build_l2 import normalized

def load(split):return [json.loads(x) for x in (ROOT/'data/l2'/f'{split}.jsonl').read_text().splitlines()]
def quantiles(vals):
    vals=sorted(vals)
    return {'min':vals[0],'p10':vals[int(.1*(len(vals)-1))],'median':statistics.median(vals),'p90':vals[int(.9*(len(vals)-1))],'max':vals[-1]}
def longest_overlap(a,b):
    a=normalized(a);b=normalized(b)
    return difflib.SequenceMatcher(None,a,b,autojunk=False).find_longest_match(0,len(a),0,len(b)).size

def main():
    p=argparse.ArgumentParser();p.add_argument('--tokenizer',action='store_true');a=p.parse_args()
    manifest={x['work_id']:x for x in json.loads((ROOT/'corpus/metadata/manifest.json').read_text())}
    by_split={s:load(s) for s in ('train','validation','heldout')};all_rows=[r for x in by_split.values() for r in x]
    errors=[];source_cache={};seen_id=set();seen_target={}
    for split,rows in by_split.items():
        for r in rows:
            wid=r['work_id'];m=manifest[wid]
            if m['split']!=split or r['split']!=split: errors.append(f'split:{r["id"]}')
            if r['id'] in seen_id: errors.append(f'duplicate-id:{r["id"]}')
            seen_id.add(r['id'])
            path=ROOT/r['source_path']
            if path not in source_cache:source_cache[path]=(path.read_bytes(),path.read_text(encoding='utf-8-sig').splitlines())
            raw,lines=source_cache[path]
            if sha(raw)!=r['source_sha256'] or sha(raw)!=m['source_sha256']: errors.append(f'source-hash:{r["id"]}')
            nums=r['source_line_numbers'];target_lines=r['target'].splitlines()
            if len(nums)!=len(target_lines) or len(nums)!=r['target_line_count'] or not 2<=len(nums)<=8:errors.append(f'line-count:{r["id"]}')
            if nums!=list(range(nums[0],nums[-1]+1)):errors.append(f'noncontiguous:{r["id"]}')
            if [unicodedata.normalize('NFC',lines[n-1].rstrip()) for n in nums]!=target_lines:errors.append(f'provenance:{r["id"]}')
            if sha(r['target'].encode())!=r['target_sha256']: errors.append(f'target-hash:{r["id"]}')
            if r['length_control'] not in ('short','medium'): errors.append(f'length-control:{r["id"]}')
            norm=' '.join(normalized(r['target']))
            if norm in seen_target:errors.append(f'exact-target-duplicate:{r["id"]}:{seen_target[norm]}')
            seen_target[norm]=r['id']
            toks=set(normalized(r['target']))
            if any(not set(hits)<=toks for hits in r['prompt_evidence'].values()):errors.append(f'ungrounded-tag:{r["id"]}')
            if not r['prompt_tags'] and r['prompt'].split()[-1] not in toks:errors.append(f'ungrounded-fallback:{r["id"]}')
            if longest_overlap(r['prompt'],r['target'])>=4:errors.append(f'prompt-copy:{r["id"]}')
    ids={s:{r['work_id'] for r in rows} for s,rows in by_split.items()}
    if any(ids[a]&ids[b] for a,b in [('train','validation'),('train','heldout'),('validation','heldout')]):errors.append('work-leakage')
    if ids['train']!={x['work_id'] for x in manifest.values() if x['split']=='train'}:errors.append('training-coverage')
    # Candidate-filtered fuzzy duplicates among all target passages.
    fuzzy=[];tokens=[normalized(r['target']) for r in all_rows];sets=[set(t) for t in tokens]
    for i in range(len(all_rows)):
        for j in range(i+1,len(all_rows)):
            if len(sets[i]&sets[j])/max(1,len(sets[i]|sets[j]))<.72:continue
            ratio=difflib.SequenceMatcher(None,tokens[i],tokens[j],autojunk=False).ratio()
            if ratio>=.88:fuzzy.append({'a':all_rows[i]['id'],'b':all_rows[j]['id'],'same_work':all_rows[i]['work_id']==all_rows[j]['work_id'],'cross_split':all_rows[i]['split']!=all_rows[j]['split'],'ratio':round(ratio,3)})
    if any(x['cross_split'] for x in fuzzy):errors.append('cross-split-fuzzy-duplicate')
    classes=Counter(r['prompt_class'] for r in by_split['train']);perwork=Counter(r['work_id'] for r in by_split['train'])
    length_controls=Counter(r['length_control'] for r in by_split['train'])
    lengths=Counter(r['target_line_count'] for r in by_split['train'])
    prompt_overlaps=[longest_overlap(r['prompt'],r['target']) for r in by_split['train']]
    token_dist=None
    if a.tokenizer:
        from transformers import AutoTokenizer
        tok=AutoTokenizer.from_pretrained(CONFIG['model_id'],revision=CONFIG['model_revision'])
        token_dist=quantiles([len(tok(r['target'],add_special_tokens=False)['input_ids']) for r in by_split['train']])
    result={'counts':{s:len(rows) for s,rows in by_split.items()},'training_works':len(ids['train']),
       'prompt_classes':dict(classes),'length_controls':dict(length_controls),'target_line_counts':dict(sorted(lengths.items())),
       'target_word_distribution':quantiles([len(words(r['target'])) for r in by_split['train']]),
       'target_token_distribution':token_dist,'examples_per_work':quantiles(list(perwork.values())),
       'max_prompt_target_phrase_words':max(prompt_overlaps),'prompt_target_overlap_distribution':quantiles(prompt_overlaps),
       'fuzzy_duplicate_pairs':fuzzy,'fuzzy_duplicate_count':len(fuzzy),
       'dataset_hashes':{s:sha((ROOT/'data/l2'/f'{s}.jsonl').read_bytes()) for s in by_split},
       'errors':errors}
    write_json(ROOT/'corpus/metadata/l2_qa.json',result)
    print(json.dumps({k:v for k,v in result.items() if k not in ('fuzzy_duplicate_pairs','dataset_hashes')},indent=2))
    if errors:raise SystemExit(1)
if __name__=='__main__':main()
