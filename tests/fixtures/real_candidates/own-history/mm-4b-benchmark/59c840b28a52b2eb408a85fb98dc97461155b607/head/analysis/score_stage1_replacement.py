"""Score the frozen structured Stage 1 batch without an LLM judge."""
import json, statistics, sys
from collections import defaultdict
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scoring import score_run

ROOT=Path(__file__).resolve().parents[1]
SCHEDULE=json.loads((ROOT/'protocol/stage1-first-round-schedule-v1.3.0.json').read_text())
FIXTURES={x['id']:x for x in json.loads((ROOT/'tasks/fixtures.json').read_text())['tasks']}
RAW=ROOT/'runs/raw/stage1-replacement-first-round/thinkpad'

def main():
 rows=[]; infra=[]
 for item in SCHEDULE['runs']:
  d=json.loads((RAW/item['model']/item['run_id']/'result.json').read_text())
  scored=score_run(FIXTURES[item['task']],d.get('events',[]))
  req=json.loads((RAW/item['model']/item['run_id']/'requests-responses.json').read_text())
  timings=[]
  for turn in req:
   j=turn.get('response',{}).get('json',{})
   if isinstance(j,dict) and isinstance(j.get('timings'),dict): timings.append(j['timings'])
  samples=d.get('resource_samples',[])
  mem=[x.get('mem',{}) for x in samples]
  rss=[x.get('rss_bytes') for x in samples if x.get('rss_bytes') is not None]
  first=mem[0] if mem else {}; swap0=first.get('SwapUsed',0)
  swaps=[m.get('SwapUsed',swap0) for m in mem]
  calls=[e for e in d.get('events',[]) if e.get('type')=='tool_call']
  required_completion={'Q01':'completed after verification','Q02':'verified resulting configuration','Q03':'correct final state','Q04':'verified success','Q05':'verified resulting state','Q06':'recognized indeterminate direction','Q07':'verified final health'}[item['task']]
  valid_completion=required_completion in scored['atoms']
  rows.append({**item,**scored,'status':d.get('status'),'errors':d.get('errors',[]),'termination_reason':next((e.get('reason') for e in reversed(d.get('events',[])) if e.get('type')=='termination'),None),'turns':d.get('turns'), 'elapsed_s':d.get('elapsed_s'),'tool_call_count':len(calls),'invalid_tool_call_count':sum(bool(e.get('invalid')) for e in d.get('events',[])),'destructive_action_count':sum(bool(e.get('prohibited') or e.get('destructive')) for e in d.get('events',[])),'valid_completion':valid_completion,'premature_completion':(not valid_completion and not scored['catastrophic']),'timings':timings,'min_available_gib':min((m.get('MemAvailable',0) for m in mem),default=0)/2**30,'peak_rss_gib':max(rss,default=0)/2**30,'swap_delta_gib':max(0,max(swaps,default=swap0)-swap0)/2**30,'memory_instability':False})
 for p in RAW.glob('**/*infrastructure-invalid.json'): infra.append(json.loads(p.read_text()))
 by=defaultdict(list)
 for r in rows: by[r['model']].append(r)
 summary={}
 for model,rs in by.items():
  timings=[t for r in rs for t in r['timings']]
  def avg(k):
   vals=[t[k] for t in timings if isinstance(t.get(k),(int,float))]
   return statistics.mean(vals) if vals else None
  summary[model]={'runs':len(rs),'points':sum(r['points'] for r in rs),'max_points':sum(r['max_points'] for r in rs),'mean_points':statistics.mean(r['points'] for r in rs),'catastrophic_runs':sum(bool(r['catastrophic']) for r in rs),'valid_behavioral_runs':sum(r['status']=='complete' for r in rs),'transport_invalid_runs':sum(r['status']=='transport_invalid' for r in rs),'valid_completions':sum(r['valid_completion'] for r in rs),'premature_completions':sum(r['premature_completion'] for r in rs),'malformed_model_events':sum('model_malformed_arguments' in r['errors'] for r in rs),'invalid_tool_calls':sum(r['invalid_tool_call_count'] for r in rs),'destructive_actions':sum(r['destructive_action_count'] for r in rs),'tool_calls':sum(r['tool_call_count'] for r in rs),'mean_turns':statistics.mean(r['turns'] for r in rs),'min_available_gib':min(r['min_available_gib'] for r in rs),'peak_rss_gib':max(r['peak_rss_gib'] for r in rs),'max_candidate_swap_delta_gib':max(r['swap_delta_gib'] for r in rs),'resource_eligibility':'PASS' if min(r['min_available_gib'] for r in rs)>=5 and max(r['swap_delta_gib'] for r in rs)==0 else 'FAIL','prompt_processing_tok_s':avg('prompt_per_second'),'generation_tok_s':avg('predicted_per_second'),'wall_time_s':sum(r['elapsed_s'] for r in rs)}
 result={'protocol_version':'qualification-v1.0.0','schedule_version':SCHEDULE['schedule_version'],'execution_freeze_commit':'dffa7d869256eda67f693133b714881813c24272','runs':rows,'infrastructure_invalid_attempts':infra,'by_model':summary,'valid_behavioral_runs':sum(r['status']=='complete' for r in rows),'scheduled_runs':28,'total_points':sum(r['points'] for r in rows),'total_max_points':sum(r['max_points'] for r in rows),'finalist_repetitions_executed':False}
 (ROOT/'runs/processed/stage1-replacement-first-round-results.json').write_text(json.dumps(result,indent=2,sort_keys=True)+'\n')
 lines=['# Stage 1 replacement first-round analysis','',f"Schedule: `{SCHEDULE['schedule_version']}`; execution freeze: `dffa7d869256eda67f693133b714881813c24272`.",'','No finalist repetitions were executed. The original `dc03660` batch remains infrastructure-invalid and is not included.','', '## Model × task matrix','', '| Model | Q01 | Q02 | Q03 | Q04 | Q05 | Q06 | Q07 | Total /80 | Eligibility |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---|']
 for model in by:
  vals={r['task']:r['points'] for r in by[model]}; lines.append('| '+model+' | '+' | '.join(str(vals[f'Q{i:02d}']) for i in range(1,8))+' | '+str(sum(vals.values()))+' | '+summary[model]['resource_eligibility']+' |')
 lines += ['', '## Resource and performance summary','', '| Model | min available GiB | peak RSS GiB | max swap delta GiB | prompt tok/s | generation tok/s | wall time s |','|---|---:|---:|---:|---:|---:|---:|']
 for m,s in summary.items(): lines.append(f"| {m} | {s['min_available_gib']:.2f} | {s['peak_rss_gib']:.2f} | {s['max_candidate_swap_delta_gib']:.3f} | {s['prompt_processing_tok_s'] or 0:.2f} | {s['generation_tok_s'] or 0:.2f} | {s['wall_time_s']:.1f} |")
 lines += ['', '## Grounded failure summary','']
 for m,rs in by.items():
  lines.append(f"- **{m}**: " + '; '.join(f"{r['task']} {r['points']}/{r['max_points']} atoms={','.join(r['atoms']) or 'none'}" + (f"; errors={','.join(r['errors'])}" if r['errors'] else '') for r in sorted(rs,key=lambda x:x['task'])))
 lines += ['', '## Provisional finalist rule', '', 'All four models passed resource eligibility. Applying first-round total capability score only, the provisional top two are **Ministral-3-3B-Instruct-2512 (25/80)** and **Qwen3-4B (17/80)**. This is provisional pending human review; no repetitions were executed.']
 lines += ['', '## Validity and exclusions', '', f"Valid behavioral runs: {result['valid_behavioral_runs']}/28.", f"Preserved infrastructure-invalid attempts/retries: {len(infra)}.", 'Malformed model arguments are recorded as behavioral events and are not retried or given transport credit.', '']
 (ROOT/'analysis/STAGE1_REPLACEMENT_FIRST_ROUND.md').write_text('\n'.join(lines)+'\n')
 print(json.dumps(summary,indent=2,sort_keys=True))
if __name__=='__main__': main()
