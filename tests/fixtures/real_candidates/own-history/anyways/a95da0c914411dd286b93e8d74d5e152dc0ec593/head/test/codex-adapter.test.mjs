import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CODEX_GENERATION_DEADLINE_MS,
  DISABLED_CODEX_FEATURES,
  GENERIC_CODEX_AGENT,
  ProductionCodexAdapter,
  codexArguments,
  decodeCodexJsonl
} from '../src/pipeline/codex-adapter.mjs';

function childProcess({ stdout = '', stderr = '', code = 0, close = true, ignoreTerm = false, onStdin = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: value => onStdin?.(value) };
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (signal === 'SIGTERM' && ignoreTerm) return true;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (close) child.emit('close', code, null);
  });
  return child;
}

function successJsonl(content = 'READY') {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'test' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'reasoning', type: 'reasoning', text: 'private summary' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'message', type: 'agent_message', text: content } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 2, output_tokens: 5 } })
  ].join('\n') + '\n';
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'anyways-phase1-codex-test-'));
  const authFile = path.join(root, 'auth.json');
  await fsp.writeFile(authFile, '{"token":"secret-value"}\n', { mode: 0o600 });
  return { root, authFile };
}

function routedSpawn({ generation, version = 'codex-cli 0.146.0\n', login = 'Logged in using ChatGPT\n' } = {}) {
  return (executable, args, options) => {
    if (args[0] === '--version') return childProcess({ stdout: version });
    if (args[0] === 'login') return childProcess({ stdout: login });
    return generation(executable, args, options);
  };
}

test('adapter arguments preserve the isolated read-only no-tools contract', () => {
  const args = codexArguments({ model: 'gpt-5.6-terra', reasoning: 'high', outputFile: '/tmp/last-message.txt' });
  assert.deepEqual(args.slice(0, 6), ['exec', '--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check']);
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('agents.enabled=false'));
  assert.ok(args.includes('approval_policy="never"'));
  for (const feature of DISABLED_CODEX_FEATURES) assert.ok(args.some((value, index) => value === '--disable' && args[index + 1] === feature));
  assert.deepEqual(args.slice(-8), ['--sandbox', 'read-only', '--color', 'never', '--json', '--output-last-message', '/tmp/last-message.txt', '-']);
});

test('JSONL decoder preserves exact final assistant content and usage', () => {
  const content = '  # exact\n\nbody  \n';
  const decoded = decodeCodexJsonl(successJsonl(content), { outputFileContent: content, stderr: 'diagnostic' });
  assert.equal(decoded.content, content);
  assert.deepEqual(decoded.usage, { input_tokens: 12, cached_input_tokens: 2, output_tokens: 5 });
});

test('JSONL decoder rejects malformed output, output mismatch, and tool events', () => {
  assert.throws(() => decodeCodexJsonl('{nope}\n', { outputFileContent: '' }), error => error.code === 'CODEX_MALFORMED_JSONL');
  assert.throws(() => decodeCodexJsonl(successJsonl('one'), { outputFileContent: 'two' }), error => error.code === 'CODEX_OUTPUT_MISMATCH');
  assert.throws(() => decodeCodexJsonl(`${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } })}\n`, { outputFileContent: '' }), error => error.code === 'CODEX_UNEXPECTED_TOOL_EVENT');
});

test('version and authentication checks fail closed before generation', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let generationCalls = 0;
  const mismatch = new ProductionCodexAdapter({
    model: 'gpt-5.6-terra', reasoning: 'high', authFile: files.authFile, enabled: true,
    spawnImpl: routedSpawn({ version: 'codex-cli old\n', generation() { generationCalls += 1; throw new Error('must not generate'); } })
  });
  await assert.rejects(() => mismatch.generate({ prompt: 'request' }), error => error.code === 'CODEX_VERSION_MISMATCH');
  assert.equal(generationCalls, 0);

  const missingAuth = new ProductionCodexAdapter({
    model: 'gpt-5.6-terra', reasoning: 'high', authFile: path.join(files.root, 'missing-auth.json'), enabled: true,
    spawnImpl: routedSpawn({ generation() { generationCalls += 1; throw new Error('must not generate'); } })
  });
  await assert.rejects(() => missingAuth.generate({ prompt: 'request' }), error => error.code === 'CODEX_AUTH_UNAVAILABLE');
  assert.equal(generationCalls, 0);
});

test('provider subprocesses add the configured absolute Codex directory to a minimal PATH', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  try {
    const observed = [];
    const adapter = new ProductionCodexAdapter({
      model: 'gpt-5.6-luna',
      reasoning: 'high',
      executable: '/Users/dippo/.nvm/versions/node/v24.14.1/bin/codex',
      spawnImpl(executable, args, options) {
        observed.push({ executable, args, path: options.env.PATH });
        return childProcess({ stdout: 'codex-cli 0.146.0\n' });
      }
    });
    await adapter.verifyCli();
    assert.equal(observed[0].executable, '/Users/dippo/.nvm/versions/node/v24.14.1/bin/codex');
    assert.equal(observed[0].path.split(path.delimiter)[0], '/Users/dippo/.nvm/versions/node/v24.14.1/bin');
  } finally {
    process.env.PATH = originalPath;
  }
});

test('successful generation uses a private home and workspace, copies credentials securely, isolates AGENTS, and cleans up', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let privateRoot;
  let prompt;
  let generationCalls = 0;
  const adapter = new ProductionCodexAdapter({
    model: 'gpt-5.6-luna', reasoning: 'high', authFile: files.authFile, enabled: true,
    spawnImpl: routedSpawn({ generation(_executable, args, options) {
      generationCalls += 1;
      privateRoot = path.dirname(options.env.CODEX_HOME);
      assert.equal(options.cwd, path.join(privateRoot, 'workspace'));
      assert.equal(fs.statSync(privateRoot).mode & 0o777, 0o700);
      assert.equal(fs.statSync(options.env.CODEX_HOME).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(options.env.CODEX_HOME, 'auth.json')).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(options.env.CODEX_HOME, 'AGENTS.md')).mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(path.join(options.env.CODEX_HOME, 'AGENTS.md'), 'utf8'), GENERIC_CODEX_AGENT);
      assert.deepEqual(fs.readdirSync(options.env.CODEX_HOME).sort(), ['AGENTS.md', 'auth.json']);
      const outputFile = args[args.indexOf('--output-last-message') + 1];
      fs.writeFileSync(outputFile, 'READY');
      return childProcess({ stdout: successJsonl('READY'), stderr: '{"token":"secret-value"}\n', onStdin: value => { prompt = value; } });
    } })
  });
  const result = await adapter.generate({ prompt: 'request', stage: 'draft' });
  assert.equal(result.raw, 'READY');
  assert.equal(prompt, 'request');
  assert.equal(generationCalls, 1);
  assert.equal(result.metrics.adapter_transport.attempts, 1);
  assert.equal(result.metrics.model_usage.provider, 'codex');
  assert.equal(result.metrics.model_usage.attempt, 1);
  assert.doesNotMatch(result.metrics.adapter_transport.raw_stderr, /secret-value/);
  assert.equal(fs.existsSync(privateRoot), false);
});

test('nonzero generation retains sanitized diagnostics and cleans failure', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let privateRoot;
  const adapter = new ProductionCodexAdapter({
    model: 'gpt-5.6-terra', reasoning: 'high', authFile: files.authFile, enabled: true,
    spawnImpl: routedSpawn({ generation(_executable, _args, options) {
      privateRoot = path.dirname(options.env.CODEX_HOME);
      return childProcess({ stdout: 'partial', stderr: 'provider denied secret-value', code: 7 });
    } })
  });
  await assert.rejects(() => adapter.generate({ prompt: 'request' }), error => error.code === 'CODEX_NONZERO_EXIT' && error.details.raw_stdout === 'partial' && !error.details.raw_stderr.includes('secret-value'));
  assert.equal(fs.existsSync(privateRoot), false);
});

test('timeout sends SIGTERM then SIGKILL, makes one generation attempt, and cleans up', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let generationChild;
  let privateRoot;
  let attempts = 0;
  const adapter = new ProductionCodexAdapter({
    model: 'gpt-5.6-terra', reasoning: 'high', authFile: files.authFile, enabled: true, timeoutMs: 5, killGraceMs: 5,
    spawnImpl: routedSpawn({ generation(_executable, _args, options) {
      attempts += 1;
      privateRoot = path.dirname(options.env.CODEX_HOME);
      generationChild = childProcess({ close: false, ignoreTerm: true });
      return generationChild;
    } })
  });
  await assert.rejects(() => adapter.generate({ prompt: 'request', stage: 'research' }), error => error.code === 'CODEX_ADAPTER_TIMEOUT' && error.details.no_retry === true);
  assert.deepEqual(generationChild.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(privateRoot), false);
});

test('cancellation sends termination signals and does not retry', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let generationChild;
  let attempts = 0;
  const controller = new AbortController();
  const adapter = new ProductionCodexAdapter({
    model: 'gpt-5.6-luna', reasoning: 'high', authFile: files.authFile, enabled: true, timeoutMs: 200, killGraceMs: 5,
    spawnImpl: routedSpawn({ generation() { attempts += 1; generationChild = childProcess({ close: false, ignoreTerm: true }); return generationChild; } })
  });
  const running = adapter.generate({ prompt: 'request', stage: 'revision', signal: controller.signal });
  await new Promise(resolve => {
    const timer = setInterval(() => {
      if (!generationChild) return;
      clearInterval(timer);
      controller.abort();
      resolve();
    }, 1);
  });
  await assert.rejects(() => running, error => error.code === 'CODEX_CANCELLED' && error.details.no_retry === true);
  assert.deepEqual(generationChild.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(attempts, 1);
});

test('production adapter keeps the configured generation deadline', () => {
  assert.equal(CODEX_GENERATION_DEADLINE_MS, 600_000);
});
