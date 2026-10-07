import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const migrationPath = new URL('../supabase/migrations/20260802100000_pipeline_v1_commission_canonical.sql', import.meta.url);
const workerPath = new URL('../src/worker.mjs', import.meta.url);
const opsPath = new URL('../bin/anyways-ops.mjs', import.meta.url);

test('canonical V1 commissioning migration and Worker use one exact RPC contract', async () => {
  const migration = await fs.readFile(migrationPath, 'utf8');
  const worker = await fs.readFile(workerPath, 'utf8');
  const ops = await fs.readFile(opsPath, 'utf8');
  assert.match(migration, /create or replace function public\.commission_editorial_pitch_v1\(\s*p_candidate_external_id text,\s*p_priority integer,\s*p_requested_by uuid,\s*p_research_requirement text\s*\) returns uuid/i);
  assert.match(migration, /'pipeline_version', 'v1'/);
  assert.match(migration, /'research_requirement', p_research_requirement/);
  assert.match(migration, /source, priority, max_attempts, requested_by/);
  assert.match(migration, /'newsroom', p_priority, 1, p_requested_by/);
  assert.match(migration, /grant execute on function public\.commission_editorial_pitch_v1\(text, integer, uuid, text\) to service_role/i);
  assert.match(worker, /v1Requested \? 'commission_editorial_pitch_v1'/);
  assert.match(worker, /p_research_requirement: job\.parameters\.research_requirement/);
  assert.doesNotMatch(worker, /v1Requested \? 'commission_pipeline_v1_editorial_pitch'/);
  assert.match(ops, /assignment_checksum: local\.commission\.assignment_checksum \|\| local\.commission\.readiness_inventory\.assignment_checksum/);
});
