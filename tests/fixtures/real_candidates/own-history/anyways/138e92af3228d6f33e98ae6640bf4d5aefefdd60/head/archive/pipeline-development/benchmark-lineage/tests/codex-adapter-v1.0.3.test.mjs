import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodexSubscriptionBenchmarkAdapter,
  DISABLED_CODEX_FEATURES,
  EXPECTED_CODEX_CLI_VERSION,
  GENERIC_CODEX_AGENT,
  codexArguments,
  decodeCodexJsonl
} from '../versions/v1.0.3/src/adapters/codex.mjs';

function childProcess({ stdout = '', stderr = '', code = 0, signal = null, close = true, ignoreTerm = false, onStdin = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: value => onStdin?.(value) };
  child.signals = [];
  child.kill = sentSignal => {
    child.signals.push(sentSignal);
    if (sentSignal === 'SIGTERM' && ignoreTerm) return true;
    queueMicrotask(() => child.emit('close', null, sentSignal));
    return true;
  };
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    if (close) child.emit('close', code, signal);
  });
  return child;
}

function successJsonl(content = 'READY') {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'test' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item-1', type: 'reasoning', text: 'private reasoning summary' } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'item-2', type: 'agent_message', text: content } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } })
  ].join('\n') + '\n';
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-adapter-test-'));
  const authFile = path.join(root, 'auth.json');
  await fsp.writeFile(authFile, '{"test":true}\n', { mode: 0o600 });
  return { root, authFile };
}

function routedSpawn({ authStatus = 'Logged in using ChatGPT\n', authStatusOnStderr = false, version = `${EXPECTED_CODEX_CLI_VERSION}\n`, exec } = {}) {
  return (executable, args, options) => {
    if (args[0] === '--version') return childProcess({ stdout: version });
    if (args[0] === 'login') return childProcess(authStatusOnStderr ? { stderr: authStatus } : { stdout: authStatus });
    return exec(executable, args, options);
  };
}

test('v1.0.3 constructs the exact isolated Codex argument contract', () => {
  const args = codexArguments({ model: 'gpt-model', reasoning: 'xhigh', outputFile: '/private/last.txt' });
  assert.deepEqual(args.slice(0, 6), [
    'exec', '--strict-config', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check'
  ]);
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-model');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('agents.enabled=false'));
  assert.ok(args.includes('approval_policy="never"'));
  for (const feature of DISABLED_CODEX_FEATURES) {
    assert.ok(args.some((value, index) => value === '--disable' && args[index + 1] === feature));
  }
  assert.deepEqual(args.slice(-8), ['--sandbox', 'read-only', '--color', 'never', '--json', '--output-last-message', '/private/last.txt', '-']);
});

test('v1.0.3 decoder preserves final completed message exactly and extracts usage', () => {
  const content = '  ```json\n{"ok": true}\n```\n';
  const decoded = decodeCodexJsonl(successJsonl(content), { outputFileContent: content, stderr: 'nonfatal' });
  assert.equal(decoded.content, content);
  assert.deepEqual(decoded.usage, { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 });
  assert.equal(decoded.events.length, 5);
});

test('v1.0.3 decoder rejects malformed, missing, contradictory, and tool output', () => {
  assert.throws(
    () => decodeCodexJsonl('{not-json}\n', { outputFileContent: '' }),
    error => error.code === 'CODEX_MALFORMED_JSONL' && error.details.raw_stdout === '{not-json}\n'
  );
  assert.throws(
    () => decodeCodexJsonl(`${JSON.stringify({ type: 'turn.completed', usage: {} })}\n`, { outputFileContent: '' }),
    error => error.code === 'CODEX_MISSING_ASSISTANT_CONTENT'
  );
  assert.throws(
    () => decodeCodexJsonl(successJsonl('one'), { outputFileContent: 'two' }),
    error => error.code === 'CODEX_OUTPUT_MISMATCH'
  );
  const tool = `${JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pwd' } })}\n`;
  assert.throws(
    () => decodeCodexJsonl(tool, { outputFileContent: '' }),
    error => error.code === 'CODEX_UNEXPECTED_TOOL_EVENT'
      && error.details.offending_event.item.type === 'command_execution'
  );
});

test('v1.0.3 rejects an incompatible CLI version before generation', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let calls = 0;
  const adapter = new CodexSubscriptionBenchmarkAdapter({
    model: 'gpt-test', reasoning: 'high', authFile: files.authFile, allowPaidGeneration: true,
    spawnImpl: routedSpawn({ version: 'codex-cli 0.145.0\n', exec: () => { calls += 1; } })
  });
  await assert.rejects(() => adapter.generate({ prompt: 'test', stage: 'draft' }), error => error.code === 'CODEX_VERSION_MISMATCH');
  assert.equal(calls, 0);
});

test('v1.0.3 rejects missing authentication before spawning generation', async () => {
  const adapter = new CodexSubscriptionBenchmarkAdapter({
    model: 'gpt-test', reasoning: 'high', authFile: '/definitely/missing/auth.json', allowPaidGeneration: true,
    spawnImpl: routedSpawn({ exec: () => { throw new Error('generation must not start'); } })
  });
  await assert.rejects(() => adapter.generate({ prompt: 'test', stage: 'draft' }), error => error.code === 'CODEX_AUTH_UNAVAILABLE');
});

test('v1.0.3 accepts the CLI login status from retained stderr diagnostics', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  const adapter = new CodexSubscriptionBenchmarkAdapter({
    model: 'gpt-test', reasoning: 'low', authFile: files.authFile, allowPaidGeneration: true,
    spawnImpl: routedSpawn({
      authStatusOnStderr: true,
      exec(_executable, args) {
        fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], 'READY');
        return childProcess({ stdout: successJsonl() });
      }
    })
  });
  assert.equal((await adapter.generate({ prompt: 'test', stage: 'smoke' })).raw, 'READY');
});

test('v1.0.3 creates a private isolated home, sends prompt over stdin, retains diagnostics, and cleans success', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let privateRoot;
  let prompt;
  let capturedArgs;
  const adapter = new CodexSubscriptionBenchmarkAdapter({
    model: 'gpt-model-neutral', reasoning: 'medium', authFile: files.authFile, allowPaidGeneration: true,
    spawnImpl: routedSpawn({
      exec(_executable, args, options) {
        capturedArgs = args;
        privateRoot = path.dirname(options.env.CODEX_HOME);
        assert.equal(options.cwd, path.join(privateRoot, 'workspace'));
        assert.equal((fs.statSync(privateRoot).mode & 0o777), 0o700);
        assert.equal((fs.statSync(options.env.CODEX_HOME).mode & 0o777), 0o700);
        assert.equal((fs.statSync(path.join(options.env.CODEX_HOME, 'auth.json')).mode & 0o777), 0o600);
        assert.equal((fs.statSync(path.join(options.env.CODEX_HOME, 'AGENTS.md')).mode & 0o777), 0o600);
        assert.equal(fs.readFileSync(path.join(options.env.CODEX_HOME, 'AGENTS.md'), 'utf8'), GENERIC_CODEX_AGENT);
        assert.deepEqual(fs.readdirSync(options.env.CODEX_HOME).sort(), ['AGENTS.md', 'auth.json']);
        const outputFile = args[args.indexOf('--output-last-message') + 1];
        fs.writeFileSync(outputFile, 'READY');
        return childProcess({ stdout: successJsonl(), stderr: 'retained warning\n', onStdin: value => { prompt = value; } });
      }
    })
  });
  const result = await adapter.generate({ prompt: 'frozen prompt', stage: 'draft' });
  assert.equal(prompt, 'frozen prompt');
  assert.equal(result.raw, 'READY');
  assert.equal(result.metrics.adapter_transport.raw_stderr, 'retained warning\n');
  assert.equal(result.metrics.adapter_transport.attempts, 1);
  assert.equal(capturedArgs[capturedArgs.indexOf('--model') + 1], 'gpt-model-neutral');
  assert.ok(capturedArgs.includes('model_reasoning_effort="medium"'));
  assert.equal(fs.existsSync(privateRoot), false);
});

test('v1.0.3 propagates nonzero exit with stdout/stderr and cleans failure', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let privateRoot;
  const adapter = new CodexSubscriptionBenchmarkAdapter({
    model: 'gpt-test', reasoning: 'low', authFile: files.authFile, allowPaidGeneration: true,
    spawnImpl: routedSpawn({
      exec(_executable, _args, options) {
        privateRoot = path.dirname(options.env.CODEX_HOME);
        return childProcess({ stdout: 'partial\n', stderr: 'provider denied\n', code: 7 });
      }
    })
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'test', stage: 'draft' }),
    error => error.code === 'CODEX_NONZERO_EXIT'
      && error.details.raw_stdout === 'partial\n'
      && error.details.raw_stderr === 'provider denied\n'
      && error.details.exit_code === 7
  );
  assert.equal(fs.existsSync(privateRoot), false);
});

test('v1.0.3 timeout sends TERM then KILL, makes one attempt, and cleans up', async t => {
  const files = await fixture();
  t.after(() => fsp.rm(files.root, { recursive: true, force: true }));
  let generationChild;
  let privateRoot;
  let attempts = 0;
  const adapter = new CodexSubscriptionBenchmarkAdapter({
    model: 'gpt-test', reasoning: 'low', authFile: files.authFile, allowPaidGeneration: true,
    timeoutMs: 5, killGraceMs: 5,
    spawnImpl: routedSpawn({
      exec(_executable, _args, options) {
        attempts += 1;
        privateRoot = path.dirname(options.env.CODEX_HOME);
        generationChild = childProcess({ close: false, ignoreTerm: true });
        return generationChild;
      }
    })
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'test', stage: 'draft' }),
    error => error.code === 'CODEX_ADAPTER_TIMEOUT'
      && error.details.timeout_layer === 'adapter_deadline'
      && error.details.no_retry === true
  );
  assert.deepEqual(generationChild.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(attempts, 1);
  assert.equal(fs.existsSync(privateRoot), false);
});
