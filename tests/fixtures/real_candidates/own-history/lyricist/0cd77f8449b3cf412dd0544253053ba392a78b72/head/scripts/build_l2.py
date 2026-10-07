"""Build short, grounded L2 supervision from the frozen complete-work split."""
from __future__ import annotations
import difflib, json, re, unicodedata
from collections import Counter,defaultdict
from pathlib import Path
from scripts.modeling import ROOT,CONFIG
from scripts.pipeline import SECTION,sha,words,write_json,write_jsonl

# Each label has auditable word evidence. Prompts use a category, not target phrases.
TAGS={
 'water':{'water','rain','river','sea','ocean','creek','flood','drown','shore','wet','waves'},
 'winter':{'ice','snow','frozen','cold','winter','frost'},
 'memory':{'memory','memories','remember','forget','forgot','recall','recognize','name'},
 'leaving':{'leave','left','leaving','gone','away','return','returning','home','stay'},
 'light':{'sun','light','shadow','moon','night','dark','darkness','stars','star'},
 'body':{'hand','hands','teeth','blood','skin','face','mouth','eyes','head','tongue','bone'},
 'enclosure':{'room','wall','walls','door','window','house','bed','inside','prison','cell'},
 'doubt':{'lie','lies','truth','true','believe','wrong','trust','doubt'},
 'distance':{'far','apart','alone','empty','missing','lost','lonely'},
 'change':{'change','changed','changing','different','difference','break','broken','fall','falling','fade','fading','turn'},
 'sound':{'voice','sound','silence','scream','sing','singing','noise','quiet','echo'},
 'movement':{'walk','walking','run','running','crawl','road','drive','train','steps'},
 'time':{'time','years','year','old','young','before','after','past','future'},
 'belief':{'god','cross','pray','saint','sin','soul','heaven','faith'},
 'damage':{'cut','wound','scar','poison','burn','fire','crack','bruise','destroyed','destroy','crushing'},
 'touch':{'touch','hold','holding','kiss','embrace'},
 'attachment':{'love','lover','beloved','heart','kiss','darling','sweetheart'},
 'guilt':{'guilt','blame','regret','sorry','shame','fault'},
 'understanding':{'understand','understanding','answer','answers','question','questions','realize'},
 'fear':{'scared','afraid','fear','panic','terror','nervous','frightened'},
 'judgment':{'evaluate','judge','judged','criticism','proof','prove','testimonial'},
 'exchange':{'money','cash','price','buy','sell','sold','compensated','commercial'},
 'meaning':{'meaning','meaningful','mattered','matters','matter','purpose','consequence'},
 'mind':{'mind','conscience','instincts','thought','thoughts','dream'},
 'release':{'surrender','release','released','letting','strayed'},
 'disappearance':{'disappeared','vanished','vanish','vanishing'},
}
DESCRIPTIONS={
 'water':'water','winter':'cold or snow','memory':'uncertain memory','leaving':'leaving or returning',
 'light':'light and darkness','body':'the body','enclosure':'an enclosed place','doubt':'doubt or mistrust',
 'distance':'distance from someone','change':'something changing','sound':'a sound or silence',
 'movement':'movement through a place','time':'time passing','belief':'belief or faith',
 'damage':'damage or injury','touch':'physical closeness',
 'attachment':'attachment to someone','guilt':'guilt or blame','understanding':'trying to understand something',
 'fear':'fear','judgment':'being judged','exchange':'money or exchange',
 'meaning':'what matters','mind':'the mind or a dream','release':'letting go',
 'disappearance':'disappearance',
}
PRIORITY=['water','winter','enclosure','body','light','sound','damage','movement','memory','fear','guilt','attachment','leaving','disappearance','doubt','distance','change','belief','touch','judgment','exchange','meaning','mind','release','understanding','time']
STOP={'about','after','again','always','before','because','could','every','going','have','just','know','like','more','never','nothing','only','other','right','some','something','still','their','there','these','they','thing','things','through','would','your','youre','with','without','this','that','what','when','where','were','from','into','then','them','dont','cant','will','want','make','take','ever','here','been','once','while','which','everything','anything','everybody','completely','exactly','already','particularly','particular'}
ANNOTATION=re.compile(r'^\s*\((?:chorus|verse|bridge|outro|pre-chorus|post-chorus)(?:\s*\d+)?\)\s*$',re.I)
FALLBACK_CONCRETE={'compass','concrete','gunpowder','courtyard','fingerprint','picture','ransom',
    'children','california','disaster','comfort','heartaches','buried','crying','jumping','borrowed'}


def normalized(text):
    return [w.casefold().replace('’',"'") for w in words(text)]
def similarity(a,b):
    aa=normalized(a);bb=normalized(b)
    if not aa or not bb:return 0.0
    return difflib.SequenceMatcher(None,aa,bb,autojunk=False).ratio()
def source_sections(path:Path):
    lines=path.read_text(encoding='utf-8-sig').splitlines()
    try: opener=lines.index('```text'); closer=lines.index('```',opener+1)
    except ValueError as exc: raise ValueError(f'Missing lyric fence: {path}') from exc
    result=[];current=[];label=None
    def flush():
        if current:result.append({'label':label,'records':current.copy()})
    for idx in range(opener+1,closer):
        line=lines[idx]
        match=SECTION.fullmatch(line)
        if match:
            flush();current=[];label=match.group(1)
        else:current.append((idx+1,unicodedata.normalize('NFC',line.rstrip())))
    flush()
    return result,lines

def stanza_chunks(records):
    stanzas=[];current=[]
    for number,line in records:
        if line.strip():current.append((number,line))
        elif current:stanzas.append(current);current=[]
    if current:stanzas.append(current)
    for stanza in stanzas:
        if len(stanza)<2:continue
        if len(stanza)<=8:yield stanza
        else:
            for start in range(0,len(stanza),6):
                chunk=stanza[start:start+6]
                if len(chunk)>=2:yield chunk

def tags_for(text):
    toks=set(normalized(text));found=[];evidence={}
    for tag in PRIORITY:
        hits=sorted(toks&TAGS[tag])
        if hits:found.append(tag);evidence[tag]=hits
    return found,evidence

def fallback_word(text):
    candidates=[w for w in normalized(text) if w in FALLBACK_CONCRETE]
    counts=Counter(candidates)
    return min(counts, key=lambda w:(counts[w],-len(w),w)) if counts else None

def prompt_for(passage_id,text):
    tags,evidence=tags_for(text)
    h=int(sha(f'class:{CONFIG["seed"]}:{passage_id}'.encode())[:8],16)%100
    klass='descriptive' if h<65 else 'sparse'
    if klass=='sparse':
        if tags:prompt=DESCRIPTIONS[tags[0]]
        else:prompt=fallback_word(text)
        selected=tags[:1]
    else:
        if len(tags)>=2:
            prompt=f'write something short involving {DESCRIPTIONS[tags[0]]} and {DESCRIPTIONS[tags[1]]}'
            selected=tags[:2]
        elif tags:
            prompt=f'write something short and indirect about {DESCRIPTIONS[tags[0]]}'
            selected=tags[:1]
        else:
            fallback=fallback_word(text)
            prompt=f'write something short involving {fallback}' if fallback else None
            selected=[]
    return prompt,klass,selected,{tag:evidence[tag] for tag in selected}

def build():
    manifest=json.loads((ROOT/'corpus/metadata/manifest.json').read_text())
    rows={x:[] for x in ('train','validation','heldout')}
    audit={'source_works':len(manifest),'raw_sections':0,'repeat_sections_skipped':0,'near_repeat_sections_skipped':0,
           'single_line_stanzas_skipped':0,'near_repeat_passages_skipped':0,'internal_repetition_skipped':0,
           'ungrounded_prompt_skipped':0,'annotation_passage_skipped':0,'work_cap_dropped':0}
    for work in manifest:
        path=ROOT/work['source_path'];source,source_lines=source_sections(path)
        split=work['split'];work_rows=[];seen_sections=[];seen_passages=[]
        for section_index,section in enumerate(source):
            audit['raw_sections']+=1
            section_text='\n'.join(line for _,line in section['records'] if line.strip())
            if not section_text:continue
            ratios=[similarity(section_text,old) for old in seen_sections]
            if ratios and max(ratios)>=0.88 and min(len(normalized(section_text)),len(normalized(seen_sections[ratios.index(max(ratios))])))>=10:
                audit['repeat_sections_skipped' if max(ratios)==1 else 'near_repeat_sections_skipped']+=1
                continue
            seen_sections.append(section_text)
            audit['single_line_stanzas_skipped']+=sum(1 for s in _stanzas(section['records']) if len(s)==1)
            for chunk_index,chunk in enumerate(stanza_chunks(section['records'])):
                target='\n'.join(line for _,line in chunk)
                if len(words(target))<7:continue
                if any(ANNOTATION.fullmatch(line) for _,line in chunk):
                    audit['annotation_passage_skipped']+=1;continue
                distinct=[]
                for _,line in chunk:
                    if not any(similarity(line,old)>=0.85 for old in distinct):distinct.append(line)
                if len(distinct)/len(chunk)<0.75:
                    audit['internal_repetition_skipped']+=1;continue
                if any(similarity(target,old)>=0.88 for old in seen_passages):
                    audit['near_repeat_passages_skipped']+=1;continue
                seen_passages.append(target)
                start,end=chunk[0][0],chunk[-1][0]
                passage_id=f"{work['work_id']}:{start}-{end}"
                prompt,klass,tags,evidence=prompt_for(passage_id,target)
                if prompt is None:
                    audit['ungrounded_prompt_skipped']+=1;continue
                row={'id':passage_id,'work_id':work['work_id'],'split':split,'source_path':work['source_path'],
                    'source_sha256':work['source_sha256'],'source_line_start':start,'source_line_end':end,
                    'source_line_numbers':[n for n,_ in chunk],'section_label':section['label'],
                    'section_index':section_index,'target':target,'target_sha256':sha(target.encode()),
                    'target_line_count':len(chunk),'prompt':prompt,'prompt_class':klass,
                    'length_control':'short' if len(chunk)<=4 or len(words(target))<=30 else 'medium',
                    'prompt_tags':tags,'prompt_evidence':evidence}
                # Verify every target line against the unmodified Markdown file.
                if [source_lines[n-1].rstrip() for n,_ in chunk]!=[line for _,line in chunk]:
                    raise ValueError(f'Provenance line mismatch: {passage_id}')
                work_rows.append(row)
        if not work_rows: raise ValueError(f'No L2 passage from {work["work_id"]}')
        if len(work_rows)>10:
            work_rows=sorted(work_rows,key=lambda r:sha(f'select:{CONFIG["seed"]}:{r["id"]}'.encode()))[:10]
            audit['work_cap_dropped']+=len(seen_passages)-10
            work_rows.sort(key=lambda r:r['source_line_start'])
        rows[split].extend(work_rows)
    for split,items in rows.items():write_jsonl(ROOT/'data/l2'/f'{split}.jsonl',items)
    hashes={split:sha((ROOT/'data/l2'/f'{split}.jsonl').read_bytes()) for split in rows}
    write_json(ROOT/'corpus/metadata/l2_dataset.json',{'config':{'section_near_duplicate_threshold':0.88,'passage_near_duplicate_threshold':0.88,'max_passages_per_work':10,'descriptive_class_threshold_percent':65},'audit':audit,'counts':{k:len(v) for k,v in rows.items()},'hashes':hashes})
    return {'audit':audit,'counts':{k:len(v) for k,v in rows.items()},'hashes':hashes}

def _stanzas(records):
    out=[];current=[]
    for number,line in records:
        if line.strip():current.append((number,line))
        elif current:out.append(current);current=[]
    if current:out.append(current)
    return out

if __name__=='__main__':print(json.dumps(build(),indent=2))
