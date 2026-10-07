import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('pitch_ready enum commits in its own migration before later references', () => {
  const enumMigration = read('../supabase/migrations/20260730010000_editorial_pitch_gate.sql');
  const projection = read('../supabase/migrations/20260730010100_editorial_pitch_gate_projection.sql');
  assert.match(enumMigration, /alter type public\.pipeline_candidate_status add value if not exists 'pitch_ready'/);
  assert.doesNotMatch(enumMigration, /\bbegin\s*;/i);
  assert.match(projection, /'pitch_ready'::public\.pipeline_candidate_status/);
});

test('discovery projection cannot resurrect rejected or mutate non-discovery candidates', () => {
  const migration = read('../supabase/migrations/20260730010100_editorial_pitch_gate_projection.sql');
  assert.match(migration, /status in \('discovered','watching'\)/);
  assert.doesNotMatch(migration, /status in \('discovered','watching','rejected'\)/);
  assert.match(migration, /updated_at = case when public\.candidate_stories\.status in \('discovered','watching'\) then now\(\) else public\.candidate_stories\.updated_at end/);
});

test('commissioning validates, locks, records authority, and claims an active job before research', () => {
  const migration = read('../supabase/migrations/20260730010200_commission_editorial_pitch.sql');
  assert.match(migration, /for update/);
  assert.match(migration, /editorial_pitch_is_valid\(candidate\.classification\)/);
  assert.match(migration, /commissioned_job_id/);
  assert.match(migration, /create or replace function public\.claim_editorial_pitch_processing/);
  assert.match(migration, /status in \('claimed','running'\)/);
  assert.match(migration, /cancellation_requested_at is null/);
  assert.match(migration, /create trigger protect_editorial_pitch_gate/);
  assert.match(migration, /new\.status in \('pitch_ready','researching','research_blocked','verification_failed'\)/);
  assert.match(migration, /new\.classification -> 'editorial_pitch' is distinct from old\.classification -> 'editorial_pitch'/);
  assert.match(migration, /create or replace function public\.reject_editorial_pitch/);
});

test('editorial pitch validation accepts the current Web3 sections and retains legacy in-flight pitches', () => {
  const migration = read('../supabase/migrations/20260808250000_align_editorial_pitch_section_validation.sql');
  for (const section of ['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture']) {
    assert.match(migration, new RegExp(`'${section}'`));
  }
  for (const section of ['internet', 'taste', 'systems', 'modern-life', 'builders', 'media']) {
    assert.match(migration, new RegExp(`'${section}'`));
  }
  assert.match(migration, /create or replace function public\.editorial_pitch_is_valid/);
  assert.match(migration, /grant execute on function public\.editorial_pitch_is_valid\(jsonb\) to service_role/);
});

test('idea commissions use controller-compatible arrays and retain a retry path', () => {
  const migration = read('../supabase/migrations/20260808240000_fix_idea_commission_queue.sql');
  assert.match(migration, /'beats', '\[\]'::jsonb/);
  assert.match(migration, /original\.job_type not in \('create_editorial_pitch','discover','process_candidate'\)/);
  assert.match(migration, /submit_focused_editorial_pitch\(original\.parameters/);
  assert.match(migration, /parameters ->> 'notes', ''\) like 'Origin: manual idea\.%'/);
  assert.match(migration, /parameters_repaired/);
});

test('idea commission feedback names the actual next newsroom stage', () => {
  const app = read('../src/app.mjs');
  assert.match(app, /focused pitch will appear under Pitches after processing/);
  assert.match(app, /Choose Commission reporting there to start source acquisition/);
  assert.doesNotMatch(app, /Commissioned\. It will appear in On Deck when writing is complete/);
});

test('generated idea commissions retain an explicit On Deck origin', () => {
  const ops = read('../bin/anyways-ops.mjs');
  const migration = read('../supabase/migrations/20260808243000_show_idea_commissions_on_deck.sql');
  const app = read('../src/app.mjs');
  assert.match(ops, /commissioned: true, commissioning_origin: 'editorial_idea'/);
  assert.match(migration, /job\.parameters ->> 'notes'/);
  assert.match(migration, /editorial_pitch,commissioned/);
  assert.match(app, /Open commissioned pitch/);
});

test('On Deck candidate projection only filters valid candidate enum values', () => {
  const app = read('../src/app.mjs');
  assert.match(app, /candidate_stories'\)\.select\([^\n]+\.not\('status', 'in', '\(archived,rejected_by_editor\)'\)/);
  assert.doesNotMatch(app, /candidate_stories'\)\.select\([^\n]+\.not\('status', 'in', '\(published,archived,rejected_by_editor\)'\)/);
});

test('newsroom auth bootstrap recovers from expired or unavailable sessions', () => {
  const app = read('../src/app.mjs');
  assert.match(app, /Newsroom session check unavailable/);
  assert.match(app, /sb\.auth\.getSession\(\)/);
  assert.match(app, /Newsroom profile unavailable/);
  assert.match(app, /optionalData\(sb\.from\('stories'\)\.select\([^\n]+, 'on deck stories'\)/);
  assert.match(app, /const loginForm = document\.querySelector\('#login'\);/);
  assert.match(app, /form\.querySelector\('\[data-publish\]'\)\?\.addEventListener/);
});

test('local operations expose no raw research, direct commission, or unvalidated retry command', () => {
  const ops = read('../bin/anyways-ops.mjs');
  const command = read('../bin/anyways-pipeline-command.mjs');
  assert.doesNotMatch(ops, /command === 'research'/);
  assert.doesNotMatch(ops, /command === 'commission'/);
  assert.doesNotMatch(ops, /command === 'retry'/);
  assert.match(ops, /claim_editorial_pitch_processing/);
  assert.doesNotMatch(command, /commission_article:/);
  assert.doesNotMatch(command, /retry_run:/);
});

test('controller replay metadata reaches the production command adapter', () => {
  const command = read('../bin/anyways-pipeline-command.mjs');
  assert.match(command, /'--replay-from-stage', value\('--replay-from-stage'\)/);
  assert.match(command, /'--parent-run-id', value\('--parent-run-id'\)/);
  assert.match(command, /'--replay-attempt-id', value\('--replay-attempt-id'\)/);
});

test('discovery enrichment is routed to the existing heavy-model controller path', () => {
  const types = read('../apps/controller/src/jobs/types.ts');
  const runner = read('../apps/controller/src/pipeline/runner.ts');
  const resources = read('../apps/controller/src/resources/classes.ts');
  const command = read('../bin/anyways-pipeline-command.mjs');
  assert.match(types, /enrich_discovery_candidate/);
  assert.match(runner, /enrich_discovery_candidate.*--candidate-id/);
  assert.match(resources, /commission_article', 'create_editorial_pitch', 'enrich_discovery_candidate'/);
  assert.match(command, /enrich_discovery_candidate:.*\['enrich'/);
});

test('discovery enrichment retry RPC is editor-gated and does not broaden the pipeline schema', () => {
  const migration = read('../supabase/migrations/20260804120000_discovery_pitch_enrichment.sql');
  assert.match(migration, /alter type public\.pipeline_job_type add value if not exists 'enrich_discovery_candidate'/i);
  assert.match(migration, /create or replace function public\.submit_discovery_pitch_enrichment/i);
  assert.match(migration, /perform public\.assert_pipeline_newsroom_service\(\)/i);
  assert.match(migration, /role in \('admin', 'editor'\)/i);
  assert.match(migration, /status not in \('discovered', 'rejected'\)/i);
  assert.match(migration, /status[^\n]*not in \('failed', 'processing'\)/i);
  assert.match(migration, /status in \('queued', 'claimed', 'running'\)/i);
  assert.match(migration, /grant execute on function public\.submit_discovery_pitch_enrichment\(text, integer, uuid\) to service_role/i);
  assert.doesNotMatch(migration, /drop table|truncate|delete from public\.candidate_stories/i);
});

test('enrichment persists model taxonomy instead of source-default beats', () => {
  const ops = read('../bin/anyways-ops.mjs');
  assert.match(ops, /const recurringBeats = \[\.\.\.new Set\(\(pitch\.beats \|\| \[\]\)/);
  assert.doesNotMatch(ops, /const recurringBeats = \[\.\.\.new Set\(\(beats \|\| \[\]\)/);
});

test('discovery enrichment retains legacy commission arrays and processing tolerates older records', () => {
  const ops = read('../bin/anyways-ops.mjs');
  const orchestrator = read('../src/pipeline/orchestrator.mjs');
  assert.match(ops, /beats: recurringBeats,\s+tags: Array\.isArray\(local\.classification\?\.tags\) \? local\.classification\.tags : \[\],\s+notes:/);
  assert.match(orchestrator, /\(Array\.isArray\(candidate\.commission\.beats\) \? candidate\.commission\.beats : \[\]\)\.join\(', '\)/);
  assert.match(orchestrator, /\(Array\.isArray\(candidate\.commission\.tags\) \? candidate\.commission\.tags : \[\]\)\.join\(', '\)/);
});

test('pitches inbox keeps enriched inbox statuses in the bounded projection', () => {
  const app = read('../src/app.mjs');
  assert.match(app, /\.in\('status', \['discovered', 'rejected'\]\)/);
  assert.match(app, /\.eq\('status', 'pitch_ready'\)/);
  assert.match(app, /\.limit\(500\), 'editorial pitches'/);
  assert.match(app, /\.limit\(100\), 'ready editorial pitches'/);
});

test('batch discovery tracks newly seen URLs and caps advancement at its target', () => {
  const ops = read('../bin/anyways-ops.mjs');
  assert.match(ops, /known\.add\(item\.url\)/);
  assert.match(ops, /if \(selected\.length >= batch\.target_count\) break/);
  assert.match(ops, /deterministicNovelty\(candidate, \[\.\.\.existing, \.\.\.selected/);
  assert.match(ops, /requiredSupabase/);
});

test('a failed batch releases the active-run lock with its error recorded', () => {
  const ops = read('../bin/anyways-ops.mjs');
  assert.match(ops, /activeEditorialBatch = \{ id: batch\.id, client \}/);
  assert.match(ops, /status: 'failed'/);
  assert.match(ops, /finished_at: new Date\(\)\.toISOString\(\)/);
  assert.match(ops, /summary: \{ error: \{ code: error\?\.code/);
});
