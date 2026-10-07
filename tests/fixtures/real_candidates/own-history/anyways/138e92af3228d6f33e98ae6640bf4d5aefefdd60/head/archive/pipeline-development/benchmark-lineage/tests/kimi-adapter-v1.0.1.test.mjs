import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import {
  KimiCodeBenchmarkAdapter,
  NO_TOOL_AGENT,
  kimiArguments
} from '../versions/v1.0.1/src/adapters/kimi-code.mjs';

function childProcess({ stdout = '', stderr = '', code = 0, onSpawn = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => child.emit('close', null);
  queueMicrotask(() => {
    onSpawn?.();
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

test('v1.0.1 Kimi arguments follow CLI 0.29.2 ordering and bind the prompt value', () => {
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
    'text',
    '--prompt',
    'frozen prompt'
  ]);
  assert.equal(args[args.indexOf('--prompt') + 1], 'frozen prompt');
  assert.equal(args.includes('-p'), false);
});

test('v1.0.1 Kimi adapter remains model-agnostic and parses successful stdout', async () => {
  let captured;
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'provider/model-not-k3',
    allowPaidGeneration: true,
    spawnImpl(executable, args, options) {
      captured = { executable, args, options };
      return childProcess({ stdout: '  {"ok":true}\n', stderr: 'nonfatal diagnostic\n' });
    }
  });
  const result = await adapter.generate({ prompt: 'test prompt', stage: 'draft' });
  assert.equal(result.raw, '{"ok":true}');
  assert.equal(result.stage, 'draft');
  assert.equal(captured.args[captured.args.indexOf('--model') + 1], 'provider/model-not-k3');
  assert.equal(captured.args[captured.args.indexOf('--prompt') + 1], 'test prompt');
  assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(captured.options.shell, undefined);
});

test('v1.0.1 Kimi adapter creates private temporary inputs and removes its workspace', async () => {
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
      return childProcess({ stdout: 'ok' });
    }
  });
  await adapter.generate({ prompt: 'test', stage: 'reviewer' });
  assert.equal(fs.existsSync(workspace), false);
  assert.equal(fs.existsSync(agentFile), false);
  assert.equal(fs.existsSync(skillsDirectory), false);
});

test('v1.0.1 Kimi adapter propagates nonzero exits with stderr and cleans up', async () => {
  let workspace;
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'kimi-code/test',
    allowPaidGeneration: true,
    spawnImpl(_executable, _args, options) {
      workspace = options.cwd;
      return childProcess({ stderr: 'provider rejected request', code: 7 });
    }
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'test', stage: 'draft' }),
    /Kimi exited 7: provider rejected request/
  );
  assert.equal(fs.existsSync(workspace), false);
});

test('v1.0.1 Kimi adapter rejects zero exit with empty stdout and retains diagnostics', async () => {
  const adapter = new KimiCodeBenchmarkAdapter({
    model: 'kimi-code/test',
    allowPaidGeneration: true,
    spawnImpl: () => childProcess({ stdout: ' \n', stderr: 'empty completion' })
  });
  await assert.rejects(
    () => adapter.generate({ prompt: 'test', stage: 'draft' }),
    /Kimi exited 0 with empty stdout: empty completion/
  );
});
