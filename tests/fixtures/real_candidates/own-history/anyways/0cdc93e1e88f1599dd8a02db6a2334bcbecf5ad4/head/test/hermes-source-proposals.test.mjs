import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseArgs } from '../bin/hermes-source-proposals.mjs';

test('Hermes bridge parses bounded claim and submit commands', () => {
  assert.deepEqual(parseArgs(['claim', '--limit', '2', '--lease-seconds', '900']), {
    command: 'claim',
    flags: { limit: '2', leaseSeconds: '900' }
  });
  assert.deepEqual(parseArgs(['submit', '--proposal-id', 'proposal-1', '--package-file', './package.json']), {
    command: 'submit',
    flags: { proposalId: 'proposal-1', packageFile: './package.json' }
  });
});
test('Hermes bridge uses the anon-key Auth boundary rather than a service-role key', async () => {
  const bridge = await readFile(new URL('../bin/hermes-source-proposals.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /SUPABASE_ANON_KEY/);
  assert.match(bridge, /signInWithPassword/);
  assert.doesNotMatch(bridge, /SUPABASE_SERVICE_ROLE_KEY/);
});
