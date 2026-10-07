import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Newsroom uses one Coverage Focus form on canonical and pitches discovery routes', async () => {
  const source = await fs.readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(source, /Coverage Focus/);
  assert.match(source, /localStorage\.getItem\(DISCOVERY_FOCUS_STORAGE_KEY\)/);
  assert.match(source, /DEFAULT_DISCOVERY_FOCUS_ID/);
  assert.match(source, /editorialBatchFormMarkup\(\)/);
  assert.match(source, /if \(pathname === '\/newsroom\/review'\) return reviewQueue\(\);/);
  assert.match(source, /if \(pathname === '\/newsroom\/pitches'\) return pitchesInbox\(\);/);
  assert.match(source, /focus_id: focusId/);
  assert.match(source, /Manual discovery/);
  assert.match(source, /Run manual discovery/);
  assert.match(source, /Scheduled Source Graph discovery runs automatically/);
  assert.match(source, /Active failures/);
});

test('Coverage Focus persistence migration defaults historical batches to All and snapshots retries', async () => {
  const migration = await fs.readFile(new URL('../supabase/migrations/20260805160000_discovery_coverage_focus.sql', import.meta.url), 'utf8');
  assert.match(migration, /requested_focus_id text not null default 'all'/);
  assert.match(migration, /jsonb_build_object\('batch_run_id',run\.id,'focus_id',p_requested_focus_id\)/);
  assert.match(migration, /requested coverage focus is not recognized/);
  assert.match(migration, /coalesce\(parameters ->> 'focus_id', 'all'\) = target/);
});
