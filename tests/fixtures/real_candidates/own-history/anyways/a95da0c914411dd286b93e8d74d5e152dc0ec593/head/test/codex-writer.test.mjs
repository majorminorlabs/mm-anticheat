import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { CodexWriterAdapter, codexWriterArgs } from '../src/pipeline/codex-writer.mjs';

test('Codex invocation is ephemeral, read-only, and explicitly model-pinned', () => {
  const args = codexWriterArgs({ model:'gpt-5.6-terra', reasoningEffort:'medium', workingDirectory:'/tmp' });
  assert.deepEqual(args.slice(0, 4), ['exec','--ephemeral','--ignore-user-config','--ignore-rules']);
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('read-only'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-5.6-terra');
  assert.equal(args[args.indexOf('--config') + 1], 'model_reasoning_effort="medium"');
  assert.equal(args.at(-1), '-');
});

test('pitch model timeouts reject instead of returning an advanceable pitch', async () => {
  let killed = false;
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { killed = true; };
    return child;
  };
  const writer = new CodexWriterAdapter({ spawnImpl, timeoutMs: 5 });
  await assert.rejects(
    writer.pitch({ candidate: { title: 'A lead', description: 'A raw lead', url: 'https://example.test' }, section: 'systems', requestedForm: 'meanwhile' }),
    /timed out/
  );
  assert.equal(killed, true);
});
