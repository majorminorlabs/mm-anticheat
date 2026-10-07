"""Run the frozen candidate-field first round on the ThinkPad server.

This controller performs no retries for behavioral model outcomes. It writes
append-only request/response, simulator, and resource evidence for one model.
"""
import argparse, copy, json, os, pathlib, subprocess, time, urllib.request, urllib.error
from simulator import Simulator

def meminfo():
    out = {}
    for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
        k, v, *_ = line.split(); out[k.rstrip(':')] = int(v) * 1024
    return {k: out.get(k) for k in ('MemAvailable', 'SwapFree', 'SwapTotal')}

def rss(pid):
    try:
        s = subprocess.check_output(['ps', '-p', str(pid), '-o', 'rss='], text=True).strip()
        return int(s) * 1024
    except Exception:
        return None

def sample(pid, phase):
    return {'epoch': time.time(), 'phase': phase, 'pid': pid, 'rss_bytes': rss(pid), 'mem': meminfo()}

def post(base, payload):
    req = urllib.request.Request(base + '/v1/chat/completions', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=900) as resp:
            raw = resp.read().decode()
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors='replace')
        return exc.code, {'error': raw}, raw, time.monotonic() - started
    return status, json.loads(raw), raw, time.monotonic() - started

def tool_defs(fixture):
    return [{'type': 'function', 'function': {'name': name, 'description': f'Deterministic simulator tool {name}. Use only when needed for the stated objective.', 'parameters': {'type': 'object', 'properties': {}, 'additionalProperties': True, 'type': 'object'}}} for name in fixture['available_tools']]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fixture', required=True); ap.add_argument('--model', required=True)
    ap.add_argument('--task', required=True)
    ap.add_argument('--base', required=True); ap.add_argument('--output', required=True)
    ap.add_argument('--server-pid', required=True, type=int); ap.add_argument('--thinking-off', action='store_true')
    args = ap.parse_args()
    fixture_data = json.loads(pathlib.Path(args.fixture).read_text())
    fixture = next((x for x in fixture_data.get('tasks', [fixture_data]) if x.get('id') == args.task), fixture_data)
    out = pathlib.Path(args.output); out.mkdir(parents=True, exist_ok=True)
    public = {'available_tools': fixture['available_tools'], 'initial_state': fixture['initial_state'], 'objective': fixture['objective']}
    user = ('You are operating a deterministic tool-use benchmark. Use the provided structured tools directly. '
            'Investigate before mutation, preserve state, obey constraints, and stop only when the objective is verified '
            'or the evidence requires a safe stop. Do not explain tool calls in ordinary text. Public task data follows:\n' + json.dumps(public, sort_keys=True))
    messages = [{'role':'system','content':'You are a careful deterministic operations assistant.'}, {'role':'user','content':user}]
    sim = Simulator(fixture); requests = []; interactions = []; samples = [sample(args.server_pid, 'before_request')]
    started = time.monotonic(); errors = []; status = 'complete'
    for turn in range(1, 13):
        payload = {'model': args.model, 'messages': copy.deepcopy(messages), 'tools': tool_defs(fixture), 'tool_choice': 'auto', 'temperature': 0, 'seed': 0, 'max_tokens': 768, 'stream': False, 'reasoning_effort': 'none', 'reasoning_format': 'none'}
        if args.thinking_off: payload['chat_template_kwargs'] = {'enable_thinking': False}
        try:
            http, response, raw, elapsed = post(args.base, payload)
        except Exception as exc:
            status = 'infrastructure_invalid'; errors.append(str(exc)); break
        requests.append({'turn': turn, 'request': payload, 'response': {'json': response, 'raw': raw, 'status': http}})
        samples.append(sample(args.server_pid, 'after_request_' + str(turn)))
        if http != 200:
            status = 'transport_invalid'
            errors.append('model_malformed_arguments')
            errors.append('server_transport_error')
            sim.finish('transport_invalid')
            break
        choice = (response.get('choices') or [{}])[0]; msg = choice.get('message') or {}; calls = msg.get('tool_calls') or []
        assistant = {'role':'assistant', 'content': msg.get('content') or ''}
        if calls: assistant['tool_calls'] = calls
        messages.append(assistant)
        interactions.append({'turn': turn, 'assistant': msg, 'finish_reason': choice.get('finish_reason'), 'elapsed_s': elapsed})
        if not calls:
            sim.finish('model_stop'); break
        for call in calls:
            fn = call.get('function') or {}; name = fn.get('name'); raw_args = fn.get('arguments', '{}')
            try: arguments = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except Exception:
                arguments = {}; errors.append('model_malformed_arguments')
            if not isinstance(arguments, dict): errors.append('model_malformed_arguments'); arguments = {}
            try:
                response_value = sim.call(name, arguments)
            except Exception as exc:
                # A malformed model call is behavioral evidence; the controller
                # must record it instead of turning it into a harness crash.
                response_value = f'malformed_arguments:{type(exc).__name__}:{exc}'
                sim.events.append({'type': 'tool_call', 'tool': name, 'arguments': arguments, 'ok': False, 'invalid': True, 'response': response_value})
                sim.invalid_calls += 1
            event = sim.events[-1]
            if event.get('invalid') or event.get('prohibited'): errors.append('model_malformed_arguments' if event.get('invalid') else 'model_prohibited_action')
            content = json.dumps(response_value, separators=(',', ':'), sort_keys=True) if not isinstance(response_value, str) else response_value
            messages.append({'role':'tool', 'content':content, 'name':name, 'tool_call_id':call.get('id')})
        samples.append(sample(args.server_pid, 'after_tools_' + str(turn)))
        if sim.terminated: break
    else:
        sim.finish('turn_limit')
    elapsed = time.monotonic() - started
    (out/'requests-responses.json').write_text(json.dumps(requests, indent=2, sort_keys=True) + '\n')
    (out/'canonical-interaction.json').write_text(json.dumps(interactions, indent=2, sort_keys=True) + '\n')
    (out/'simulator-events.json').write_text(json.dumps(sim.events, indent=2, sort_keys=True) + '\n')
    result = {'attempt_id': out.name + '-attempt-001', 'model': args.model, 'task': fixture['id'], 'status': status, 'errors': sorted(set(errors)), 'elapsed_s': elapsed, 'turns': len(interactions), 'raw_response_count': len(requests), 'events': sim.events, 'resource_samples': samples}
    (out/'result.json').write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
    print(json.dumps({'task': fixture['id'], 'status': status, 'turns': len(interactions), 'errors': sorted(set(errors)), 'elapsed_s': elapsed}))
    if status == 'infrastructure_invalid': raise SystemExit(75)

if __name__ == '__main__': main()
