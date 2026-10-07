import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import {
  KimiCodeBenchmarkAdapter,
  NO_TOOL_AGENT,
  decodeKimiJsonl,
  kimiArguments
} from '../versions/v1.0.2/src/adapters/kimi-code.mjs';

function childProcess({ stdout = '', stderr = '', code = 0, close = true, onSpawn = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = null;
  child.kill = signal => {
    child.killedWith = signal;
    child.emit('close', null);
  };
  queueMicrotask(() => {
    onSpawn?.();
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (close) child.emit('close', code);
  });
  return child;
}

test('v1.0.2 Kimi arguments select stream-json and bind the prompt value', () => {
  const args = kimiArguments({
    model: 'kimi-code/any-alias',
    agentFile: '/tmp/agent.md',
    skillsDirectory: '/tmp/empty',
    prompt: 'frozen prompt'
  });
  assert.deepEqual(args, [
    '--agent-file',
    '/tmp/agent.md',
    '--skills-dir',
    '/tmp/empty',
    '--model',
    'kimi-code/any-alias',
    '--output-format',
    'stream-json',
    '--prompt',
    'frozen prompt'
  ]);
});

test('v1.0.2 decoder extracts one assistant envelope and ignores status envelopes', () => {
  const stdout = [
    JSON.stringify({ role: 'meta', type: 'system.version', version: '0.29.2' }),
    JSON.stringify({ role: 'assistant', content: 'READY' }),
    JSON.stringify({ role: 'meta', type: 'session.resume_hint', content: 'not model output' })
  ].join('\n') + '\n';
  assert.equal(decodeKimiJsonl(stdout), 'READY');
});

test('v1.0.2 decoder concatenates multiple assistant envelopes without adding separators', () => {
  const stdout = [
    JSON.stringify({ role: 'assistant', content: '{\n  "value": ' }),
    JSON.stringify({ role: 'tool', content: 'ignored' }),
    JSON.stringify({ role: 'assistant', content: 'true\n}' })
  ].join('\n');
  assert.equal(decodeKimiJsonl(stdout), '{\n  "value": true\n}');
});

test('v1.0.2 decoder preserves whitespace, bullets, prose, and fenced JSON exactly', () => {
  const content = '  • Here is the result:\n```json\n{"ok":true}\n```\n';
  assert.equal(decodeKimiJsonl(JSON.stringify({ role: 'assistant', content })), content);
});

test('v1.0.2 decoder rejects malformed JSONL and retains raw diagnostics', () => {
  const stdout = '{"role":"assistant","content":"ok"}\nnot-json\n';
  assert.throws(
    () => decodeKimiJsonl(stdout, { stderr: 'wire warning' }),
    error => error.code === 'KIMI_MALFORMED_JSONL'
      && error.details.raw_stdout === stdout
      && error.details.raw_stderr === 'wire warning'
  );
});

test('v1.0.2 decoder rejects output with no assistant content', () => {
  const stdout = `${JSON.stringify({ role: 'meta', type: 'system.version' })}\n`;
  assert.throws(
    () => decodeKimiJsonl(stdout),
    error => error.code === 'KIMI_MISSING_ASSISTANT_CONTENT'
  );
});

test('v1.0.2 adapter is model-agnostic and retains stdout and stderr on success', async () => {
  let captured;
  const stdout = `${JSON.stringify({ role: 'assistant', content: '{"ok":true}' })}\n`;
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'provider/model-not-k3',
    allowPaidGeneration: true,
    spawnImpl(executable, args, options) {
      captured = { executable, args, options };
      return childProcess({ stdout, stderr: 'nonfatal diagnostic\n' });
    }
  });
  const result = await adapter.generate({ prompt: 'test prompt', stage: 'draft' });
  assert.equal(result.raw, '{"ok":true}');
  assert.equal(result.stage, 'draft');
  assert.equal(result.metrics.adapter_transport.raw_stdout, stdout);
  assert.equal(result.metrics.adapter_transport.raw_stderr, 'nonfatal diagnostic\n');
  assert.equal(captured.args[captured.args.indexOf('--model') + 1], 'provider/model-not-k3');
  assert.equal(captured.args[captured.args.indexOf('--prompt') + 1], 'test prompt');
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(captured.options.shell, undefined);
});

test('v1.0.2 adapter propagates nonzero exits with raw diagnostics', async () => {
  const stdout = `${JSON.stringify({ role: 'assistant', content: 'partial' })}\n`;
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'kimi-code/test',
    allowPaidGeneration: true,
    spawnImpl: () => childProcess({ stdout, stderr: 'provider rejected request', code: 7 })
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'test', stage: 'draft' }),
    error => error.code === 'KIMI_NONZERO_EXIT'
      && error.details.raw_stdout === stdout
      && error.details.raw_stderr === 'provider rejected request'
      && error.details.exit_code === 7
  );
});

test('v1.0.2 adapter preserves timeout behavior and cleans its workspace', async () => {
  let child;
  let workspace;
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'kimi-code/test',
    timeoutMs: 5,
    allowPaidGeneration: true,
    spawnImpl(_executable, _args, options) {
      workspace = options.cwd;
      child = childProcess({ close: false });
      return child;
    }
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'test', stage: 'draft' }),
    error => error.code === 'KIMI_ADAPTER_TIMEOUT'
      && error.details.timeout_layer === 'adapter_deadline'
  );
  assert.equal(child.killedWith, 'SIGTERM');
  assert.equal(fs.existsSync(workspace), false);
});

test('v1.0.2 adapter creates private temporary inputs and removes its workspace', async () => {
  let workspace;
  let agentFile;
  let skillsDirectory;
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'kimi-code/test',
    allowPaidGeneration: true,
    spawnImpl(_executable, args, options) {
      workspace = options.cwd;
      agentFile = args[args.indexOf('--agent-file') + 1];
      skillsDirectory = args[args.indexOf('--skills-dir') + 1];
      assert.equal(fs.existsSync(workspace), true);
      assert.equal(fs.readFileSync(agentFile, 'utf8'), NO_TOOL_AGENT);
      assert.equal((fs.statSync(agentFile).mode & 0o777).toString(8), '600');
      assert.equal(fs.statSync(skillsDirectory).isDirectory(), true);
      return childProcess({ stdout: `${JSON.stringify({ role: 'assistant', content: 'ok' })}\n` });
    }
  });
  await adapter.generate({ prompt: 'test', stage: 'reviewer' });
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.existsSync(agentFile), false);
  assert.equal(fs.existsSync(skillsDirectory), false);
});
