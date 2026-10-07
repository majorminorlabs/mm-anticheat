import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkCodexReadiness } from '../src/codex-readiness.js';

async function fixture(body: string, executable = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'anyways-codex-readiness- with spaces-'));
  const file = path.join(root, 'codex wrapper');
  await writeFile(file, `#!/bin/sh\n${body}\n`);
  await chmod(file, executable ? 0o700 : 0o600);
  return { root, file };
}

test('minimal PATH is irrelevant when the configured absolute executable is valid', async t => {
  const files = await fixture("if [ \"$1\" = '--version' ]; then printf 'codex-cli 0.146.0\\n'; elif [ \"$1\" = 'login' ]; then printf 'Logged in using ChatGPT\\n'; else exit 9; fi");
  t.after(() => rm(files.root, { recursive: true, force: true }));
  const previous = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';
  t.after(() => { process.env.PATH = previous; });
  const result = await checkCodexReadiness({ codexExecutable: files.file });
  assert.equal(result.ok, true);
  assert.equal(result.executable, files.file);
  assert.equal(result.version, 'codex-cli 0.146.0');
});

test('missing and non-executable paths fail before any provider invocation', async () => {
  const missing = await checkCodexReadiness({ codexExecutable: '/tmp/anyways-codex-does-not-exist' });
  assert.equal(missing.ok, false);
  const files = await fixture("printf 'codex-cli 0.146.0\\n'", false);
  try {
    const result = await checkCodexReadiness({ codexExecutable: files.file });
    assert.equal(result.ok, false);
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test('version mismatch fails closed', async t => {
  const files = await fixture("if [ \"$1\" = '--version' ]; then printf 'codex-cli old\\n'; else exit 9; fi");
  t.after(() => rm(files.root, { recursive: true, force: true }));
  const result = await checkCodexReadiness({ codexExecutable: files.file });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /version/);
});
