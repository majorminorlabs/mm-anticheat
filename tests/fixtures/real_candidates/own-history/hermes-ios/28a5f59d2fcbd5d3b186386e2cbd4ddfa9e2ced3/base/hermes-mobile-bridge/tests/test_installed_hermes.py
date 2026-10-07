"""Opt-in E2E: installed upstream, isolated HERMES_HOME, local-only model."""
import asyncio
import json
import os
import socket
import subprocess
import sys
import uuid
from pathlib import Path
import aiohttp
from aiohttp import web
import pytest
from hermes_mobile_bridge.api import create_app, SERVICE
from conftest import eventually, serve

SOURCE = Path(os.environ.get('HERMES_SOURCE', '/Users/dippo/.hermes/hermes-agent'))
pytestmark = pytest.mark.skipif(os.environ.get('HERMES_BRIDGE_E2E') != '1', reason='Set HERMES_BRIDGE_E2E=1 for isolated installed-Hermes integration')


class LocalModel:
    def __init__(self):
        self.calls = []
        self.app = web.Application()
        self.app.router.add_post('/v1/chat/completions', self.complete)
        self.app.router.add_get('/v1/models', self.models)

    async def models(self, request):
        return web.json_response({'data': [{'id': 'bridge-local-test'}]})

    async def complete(self, request):
        body = await request.json()
        self.calls.append(body)
        messages = body['messages']
        tool_done = any(m.get('role') == 'tool' for m in messages)
        user = next((m.get('content', '') for m in reversed(messages) if m.get('role') == 'user'), '')
        wants_tool = ('exercise-tool' in str(user) or 'exercise-safe-tool' in str(user)) and not tool_done
        command = 'sleep 2' if 'exercise-safe-tool' in str(user) else "python3 -c 'import time; time.sleep(2); print(\"LOCAL_TOOL_OK\")'"
        payload = {'role': 'assistant', 'content': 'Reply from isolated local model.'}
        if wants_tool:
            payload = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_local', 'type': 'function', 'function': {'name': 'terminal', 'arguments': json.dumps({'command': command, 'timeout': 10})}}]}
        finish = 'tool_calls' if wants_tool else 'stop'
        if body.get('stream'):
            response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
            await response.prepare(request)
            delta = payload.copy()
            delta.pop('role', None)
            if 'tool_calls' in delta:
                delta['tool_calls'][0]['index'] = 0
            for chunk in [{'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}, {'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}], 'usage': {'prompt_tokens': 20, 'completion_tokens': 8, 'total_tokens': 28}}]:
                await response.write(('data: ' + json.dumps({'id': 'chatcmpl-local', 'object': 'chat.completion.chunk', 'model': 'bridge-local-test', **chunk}) + '\n\n').encode())
            await response.write(b'data: [DONE]\n\n')
            return response
        return web.json_response({'id': 'chatcmpl-local', 'object': 'chat.completion', 'created': 1, 'model': 'bridge-local-test', 'choices': [{'index': 0, 'message': payload, 'finish_reason': finish}], 'usage': {'prompt_tokens': 20, 'completion_tokens': 8, 'total_tokens': 28}})


async def test_installed_source_end_to_end(tmp_path):
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    assert commit.startswith('2a4c9afd7bd')
    model = LocalModel()
    model_runner, model_port = await serve(model.app)
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    sock.close()
    home, work = tmp_path / 'hermes-home', tmp_path / 'work'
    home.mkdir(mode=0o700)
    work.mkdir()
    (home / 'config.yaml').write_text(f'''model:
  default: bridge-local-test
  provider: custom
  base_url: http://127.0.0.1:{model_port}/v1
  api_key: local-test-only
  api_mode: chat_completions
agent:
  max_turns: 4
  reasoning_effort: none
toolsets: [terminal, file]
display:
  tool_progress: all
terminal:
  backend: local
  cwd: {work}
memory:
  memory_enabled: false
  user_profile_enabled: false
''')
    # No host provider credentials are inherited. Upstream receives a dummy
    # local-model key in its isolated config, not the production .env.
    env = {k: v for k, v in os.environ.items() if not any(x in k.upper() for x in ('API_KEY', 'TOKEN', 'SECRET', 'HERMES_', 'ANTHROPIC_', 'OPENAI_', 'OPENROUTER_', 'NOUS_')) and k not in {'PYTHONPATH', 'PYTHONHOME'}}
    env.update(HERMES_HOME=str(home), HERMES_DASHBOARD_SESSION_TOKEN='u' * 32, HERMES_TUI_TOOLSETS='terminal,file', PYTHONUNBUFFERED='1')
    log = open(tmp_path / 'hermes-local.log', 'w')
    python = SOURCE / 'venv/bin/python'
    proc = None
    bridge_runner = None
    client = None
    try:
        proc = subprocess.Popen([str(python), '-c', f'from hermes_cli.web_server import start_server; start_server(port={port}, open_browser=False)'], cwd=SOURCE, env=env, stdout=log, stderr=log)
        async with aiohttp.ClientSession() as probe:
            async with asyncio.timeout(40):
                while True:
                    if proc.poll() is not None:
                        raise AssertionError('Isolated Hermes exited; inspect local test log')
                    try:
                        async with probe.get(f'http://127.0.0.1:{port}/api/status') as res:
                            if res.status == 200:
                                break
                    except aiohttp.ClientError:
                        pass
                    await asyncio.sleep(.2)
        cfg = {'state_dir': str(tmp_path / 'bridge-state'), 'event_limit': 1000, 'run_event_limit': 500, 'event_days': 7, 'upload_limit': 1024 * 1024, 'artifact_limit': 2 * 1024 * 1024, 'backends': {'default': {'url': f'http://127.0.0.1:{port}', 'token': 'u' * 32, 'boards': ['default'], 'workspaces': {'test': str(work)}, 'artifact_roots': [str(work / '.hermes/desktop-attachments')], 'installed_commit': commit}}}
        app = create_app(cfg)
        service = app[SERVICE]
        _, token = service.store.token('integration', ['read', 'chat.control', 'tasks.manage', 'approvals.respond'], ['default'])
        bridge_runner, bp = await serve(app)
        client = aiohttp.ClientSession(headers={'Authorization': 'Bearer ' + token})
        await eventually(lambda: service.backends['default'].connected, timeout=20)
        async def request(method, path, body=None, expected=200):
            async with client.request(method, f'http://127.0.0.1:{bp}/mobile/v1' + path, json=body, headers={'Idempotency-Key': str(uuid.uuid4())}) as res:
                out = await res.json()
                assert res.status == expected, out
                return out
        c = await request('POST', '/conversations', {'title': 'Local integration', 'workspace': 'test'}, 201)
        r = await request('POST', f"/conversations/{c['id']}/runs", {'text': 'Say hello using the local model.'}, 202)
        await eventually(lambda: service.store.get('runs', r['id'])['state'] in {'complete', 'failed'}, timeout=40)
        finished = await request('GET', f"/runs/{r['id']}")
        assert finished['state'] == 'complete', finished
        assert finished['assistant_text'] == 'Reply from isolated local model.'
        transcript = await request('GET', f"/conversations/{c['id']}")
        assert any(m.get('role') == 'assistant' for m in transcript['messages'])
        await request('PATCH', f"/conversations/{c['id']}", {'title': 'Renamed integration'})
        assert (await request('GET', '/conversations?q=local'))['conversations']
        assert (await request('GET', f"/conversations/{c['id']}/usage"))['tokens']['total'] > 0
        uploaded = await request('POST', '/attachments', {'conversation_id': c['id'], 'name': 'evidence.txt', 'content_type': 'text/plain', 'content_base64': 'TG9jYWwgZXZpZGVuY2U='}, 201)
        assert uploaded['attached'] and uploaded['artifact']
        job = await request('POST', '/cron', {'prompt': 'Local future work', 'schedule': 'every 1h', 'name': 'isolated-job'}, 201)
        await request('POST', f"/cron/{job['id']}/disable", {})
        await request('PATCH', f"/cron/{job['id']}", {'name': 'edited-job'})
        assert not (await request('GET', f"/cron/{job['id']}"))['job']['enabled']
        await request('POST', f"/cron/{job['id']}/enable", {})
        trigger = await request('POST', f"/cron/{job['id']}/run-now", {})
        assert trigger['scheduler_required'] and not trigger['execution_started']
        await request('DELETE', f"/cron/{job['id']}", {})
        caps = await request('GET', '/capabilities')
        if caps['profiles']['default']['features']['kanban']:
            card = await request('POST', '/kanban/tasks', {'title': 'Local card', 'triage': True}, 201)
            await request('PATCH', f"/kanban/tasks/{card['id']}", {'status': 'todo', 'body': 'Test dependency'})
            assert (await request('GET', f"/kanban/tasks/{card['id']}"))['task']['body'] == 'Test dependency'
            child = await request('POST', '/kanban/tasks', {'title': 'Dependent card', 'parents': [card['id']], 'workspace': 'test'}, 201)
            child_detail = await request('GET', f"/kanban/tasks/{child['id']}")
            assert child_detail['links']['parents'] == [card['id']]
            await request('PATCH', f"/kanban/tasks/{card['id']}", {'assignee': 'default'})
            await request('PATCH', f"/kanban/tasks/{card['id']}", {'status': 'ready'})
            # Seed an actual canonical claim/heartbeat through upstream helpers,
            # without running a dispatcher or spawning a Kanban agent worker.
            script = "from hermes_cli import kanban_db as kb; c=kb.connect(board='default'); assert kb.claim_task(c," + repr(card['upstream_id']) + ",claimer='bridge-integration'); assert kb.heartbeat_worker(c," + repr(card['upstream_id']) + ",note='integration'); c.close()"
            seeded = await asyncio.to_thread(subprocess.run, [str(python), '-c', script], cwd=SOURCE, env=env, capture_output=True, timeout=10)
            assert seeded.returncode == 0, 'Canonical claim/heartbeat setup failed'
            claimed = await request('GET', f"/kanban/tasks/{card['id']}")
            assert claimed['task']['raw_state'] == 'running'
            assert claimed['attempts'][0]['last_heartbeat_at']
            await request('POST', f"/kanban/tasks/{card['id']}/reclaim", {'reason': 'isolated integration'})
            reclaimed = await request('GET', f"/kanban/tasks/{card['id']}")
            assert reclaimed['task']['raw_state'] == 'ready'
            assert reclaimed['attempts'][0]['outcome'] == 'reclaimed'
            await request('POST', f"/kanban/tasks/{card['id']}/reassign", {'profile': ''})
            await request('DELETE', f"/kanban/tasks/{child['id']}", {})
            await request('DELETE', f"/kanban/tasks/{card['id']}", {})
        # Fresh conversation ensures this request actually executes a tool.
        tc = await request('POST', '/conversations', {'title': 'Tool integration', 'workspace': 'test'}, 201)
        tr = await request('POST', f"/conversations/{tc['id']}/runs", {'text': 'exercise-tool'}, 202)
        def tool_started():
            return service.store.db.execute("SELECT COUNT(*) FROM events WHERE run_id=? AND type='tool.started'", (tr['id'],)).fetchone()[0] > 0
        await eventually(tool_started, timeout=40)
        ack = await request('POST', f"/runs/{tr['id']}/steer", {'text': 'change direction after the tool'})
        assert ack['status'] == 'queued'
        stop = await request('POST', f"/runs/{tr['id']}/stop", {})
        assert stop['acknowledged'] and not stop['termination_confirmed']
        await eventually(lambda: service.store.get('runs', tr['id'])['state'] in {'cancelled', 'failed'}, timeout=30)
        assert (await request('GET', f"/runs/{tr['id']}"))['state'] == 'cancelled'
        sc = await request('POST', '/conversations', {'title': 'Steering integration', 'workspace': 'test'}, 201)
        sr = await request('POST', f"/conversations/{sc['id']}/runs", {'text': 'exercise-safe-tool'}, 202)
        await eventually(lambda: service.store.db.execute("SELECT COUNT(*) FROM events WHERE run_id=? AND type='tool.started'", (sr['id'],)).fetchone()[0] > 0, timeout=40)
        await request('POST', f"/runs/{sr['id']}/steer", {'text': 'steering-consumption-evidence'})
        await eventually(lambda: service.store.get('runs', sr['id'])['state'] in {'complete', 'failed'}, timeout=30)
        assert service.store.get('runs', sr['id'])['state'] == 'complete'
        assert any('steering-consumption-evidence' in json.dumps(call['messages']) for call in model.calls)
        # Restart the bridge against the still-live installed backend and the
        # same journal. Phone bearer and completed run IDs remain valid.
        await client.close()
        await bridge_runner.cleanup()
        app = create_app(cfg)
        service = app[SERVICE]
        bridge_runner, bp = await serve(app)
        client = aiohttp.ClientSession(headers={'Authorization': 'Bearer ' + token})
        await eventually(lambda: service.backends['default'].connected, timeout=20)
        assert (await request('GET', f"/runs/{r['id']}"))['state'] == 'complete'
        # Real Hermes process restart during a controlled tool execution.
        rc = await request('POST', '/conversations', {'title': 'Restart integration', 'workspace': 'test'}, 201)
        rr = await request('POST', f"/conversations/{rc['id']}/runs", {'text': 'exercise-safe-tool'}, 202)
        await eventually(lambda: service.store.db.execute("SELECT COUNT(*) FROM events WHERE run_id=? AND type='tool.started'", (rr['id'],)).fetchone()[0] > 0, timeout=40)
        before_restart = len(model.calls)
        generation = service.backends['default'].generation
        proc.kill()  # simulate abrupt Hermes loss, rather than waiting for uvicorn drain
        await asyncio.to_thread(proc.wait, 5)
        await eventually(lambda: service.store.get('runs', rr['id'])['state'] == 'unknown')
        proc = subprocess.Popen([str(python), '-c', f'from hermes_cli.web_server import start_server; start_server(port={port}, open_browser=False)'], cwd=SOURCE, env=env, stdout=log, stderr=log)
        await eventually(lambda: service.backends['default'].connected and service.backends['default'].generation > generation, timeout=30)
        assert (await request('GET', f"/runs/{rr['id']}"))['state'] == 'unknown'
        assert len(model.calls) == before_restart
        home_result = await request('GET', '/home')
        assert home_result['recent_completions']
        await request('DELETE', f"/conversations/{c['id']}", {})
        print(json.dumps({'installed_commit': commit, 'model_requests': len(model.calls), 'kanban_mounted': caps['profiles']['default']['features']['kanban'], 'final_state': finished['state'], 'tool_stop_state': 'cancelled'}))
    finally:
        if client:
            await client.close()
        if bridge_runner:
            await bridge_runner.cleanup()
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                await asyncio.to_thread(proc.wait, 8)
            except subprocess.TimeoutExpired:
                proc.kill()
                await asyncio.to_thread(proc.wait)
        log.close()
        await model_runner.cleanup()
