import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const opsScript = path.join(repoRoot, 'bin', 'anyways-ops.mjs');

test('credential-free discovery ignores the retired default source file', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-ops-'));
  try {
    await fs.writeFile(path.join(stateDir, 'sources.json'), JSON.stringify([{
      id: 'legacy-general-tech',
      name: 'Legacy general technology feed',
      type: 'rss',
      url: 'https://example.com/feed.xml',
      enabled: true,
      default_section: 'systems',
      focuses: ['technology']
    }]));
    const env = { ...process.env, ANYWAYS_PIPELINE_STATE_DIR: stateDir };
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    delete env.ANYWAYS_PIPELINE_SOURCES_FILE;

    let commandError;
    try {
      await execFile(process.execPath, [opsScript, 'discover'], { cwd: repoRoot, env });
    } catch (error) {
      commandError = error;
    }

    assert(commandError, 'credential-free discovery should fail closed');
    const payload = JSON.parse(commandError.stdout.trim());
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'PIPELINE_STATE_NOT_CONFIGURED');
    assert.match(payload.error.message, /ANYWAYS_PIPELINE_SOURCES_FILE/);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
