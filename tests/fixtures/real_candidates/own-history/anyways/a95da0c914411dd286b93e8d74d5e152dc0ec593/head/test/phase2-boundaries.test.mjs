import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deterministicReview } from '../src/pipeline/deterministic-review.mjs';
import { createSupabasePhase2Persistence, persistPhase2Stage } from '../src/pipeline/phase2-persistence.mjs';
import { lunaDraftPrompt, lunaRevisionPrompt, terraPrompt } from '../src/pipeline/phase2-prompts.mjs';
import { createPhase2Run, phase2RunFor } from '../src/pipeline/phase2-state.mjs';

const packet = { version: 'pipeline-v1-evidence-packet-v1', checksum: 'checksum', frozen_evidence_packet_sha256: 'checksum', sources: [{ source_id: 'source-1', url: 'https://example.com', excerpt: 'The record changed the workflow.' }], claims: [{ claim_id: 'claim-1', claim: 'The record changed the workflow.', evidence: [{ evidence_id: 'evidence-001', source_id: 'source-1', excerpt: 'The record changed the workflow.', claim_ids: ['claim-1'] }] }], claim_targets: ['claim-1'], required_facts: [{ fact_id: 'fact-1', text: 'The record changed the workflow.', source_ids: ['source-1'] }], prohibited_claims: ['The record was fictional.'], ledgers: { quotations: [], proper_names: [], numbers: [] }, unresolved_research_questions: [], blockers: [], draft_constraints: [], totals: { source_count: 1 } };
const candidate = { title: 'A commissioned story', commission: { brief: 'Explain the change.', section_id: 'systems', story_form: 'meanwhile', beats: ['cities'], tags: [] }, classification: { primary_section: 'systems' } };

test('deterministic Phase 2 review separates factual blocks, editorial fixes, and advisory warnings', () => {
  const result = deterministicReview({ candidate, packet, draft: { headline: 'A commissioned story', dek: 'The change.', section: 'systems', beats: ['cities'], source_ids: ['source-1'], claim_ids: ['claim-1'], claim_support: [{ claim_id: 'claim-1', evidence_ids: ['evidence-001'], article_anchor: 'paragraph-1', treatment: 'paraphrase' }], warnings: [], claims: [], body_markdown: '# A commissioned story\n\nThe record was fictional.\n\nA short paragraph.' } });
  assert.equal(result.status, 'blocked');
  assert.ok(result.blocking_factual_errors.some(item => item.includes('Prohibited claim')));
  assert.ok(result.required_editorial_fixes.some(item => item.includes('word count')));
  assert.equal(result.source_link_mode, 'deterministic_claim_links');
  assert.equal(result.advisory_style_warnings.some(item => item.includes('inline source links')), false);
});

test('Phase 2 prompts carry the assignment and frozen packet without external references or prior draft text', () => {
  const terra = terraPrompt({ candidate, sourceInventory: packet, researchQuestions: ['What changed?'] });
  const draft = lunaDraftPrompt({ candidate, packet });
  const revision = lunaRevisionPrompt({ candidate, packet, draft: { headline: 'Draft', body_markdown: 'prior body', claims: [] }, findings: { blocking_factual_errors: [] } });
  assert.match(terra, /SYSTEM-FETCHED SOURCE INVENTORY/);
  assert.match(terra, /blockers must be an array of structured objects, never strings/);
  assert.match(terra, /"blocker_id":"blocker-1"/);
  assert.match(draft, /FROZEN EVIDENCE PACKET/);
  assert.doesNotMatch(draft, /prior body/);
  assert.match(revision, /DETERMINISTIC FINDINGS/);
  assert.match(revision, /prior body/);
});

test('parameterized Phase 2 persistence is idempotent and does not use generated SQL sync', async () => {
  const calls = [];
  const persistence = createSupabasePhase2Persistence({ client: { async rpc(name, args) { calls.push({ name, args }); return { data: { stage: args.p_stage }, error: null }; } } });
  const state = { phase2_persistence: [] }; const run = { id: 'run-1', candidate_id: 'external-1' };
  const payload = { frozen_evidence_packet_sha256: 'checksum', evidence_packet: packet };
  await persistPhase2Stage({ state, run, stage: 'evidence_packet', payload, persistence });
  await persistPhase2Stage({ state, run, stage: 'evidence_packet', payload, persistence });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'persist_pipeline_phase2_stage_v3');
  assert.equal(calls[0].args.p_terra_evidence_contract_version, 'terra-evidence-offsets-v1');
  assert.equal(calls[0].args.p_candidate_external_id, 'external-1');
  assert.equal(calls[0].args.p_readiness_inventory_sha256, null);
  assert.equal(calls[0].args.p_frozen_evidence_packet_sha256, 'checksum');
  assert.equal(state.phase2_persistence.length, 1);
});

test('Phase 2 migration adds the rollback-safe artifact boundary without changing legacy tables', async () => {
  const migration = await readFile(new URL('../supabase/migrations/20260731130000_pipeline_phase2_artifacts.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.pipeline_phase2_artifacts/);
  assert.match(migration, /stage in \('source_inventory', 'research'/);
  assert.match(migration, /persist_pipeline_phase2_stage/);
  const contractMigration = await readFile(new URL('../supabase/migrations/20260731150000_pipeline_phase2_terra_evidence_contract.sql', import.meta.url), 'utf8');
  assert.match(contractMigration, /add column if not exists terra_evidence_contract_version/);
  assert.match(contractMigration, /persist_pipeline_phase2_stage_v2/);
  assert.match(contractMigration, /terra-evidence-offsets-v1/);
  const checksumMigration = await readFile(new URL('../supabase/migrations/20260801120000_pipeline_phase2_checksum_namespace.sql', import.meta.url), 'utf8');
  assert.match(checksumMigration, /holdout_run_id/);
  assert.match(checksumMigration, /case_run_id/);
  assert.match(checksumMigration, /readiness_inventory_sha256/);
  assert.match(checksumMigration, /frozen_evidence_packet_sha256/);
  assert.match(checksumMigration, /persist_pipeline_phase2_stage_v3/);
  assert.match(migration, /on conflict \(candidate_id, pipeline_run_id, stage\) do update/);
  assert.doesNotMatch(migration, /alter table public\.candidate_stories.*pipeline_candidate_status/i);
});

test('Phase 2 never infers the Terra evidence contract version from a legacy run', () => {
  const state = { phase2_runs: [{ id: 'legacy-run', candidate_id: 'candidate-1', pipeline_version: 'pipeline-v1', status: 'failed' }] };
  assert.equal(phase2RunFor(state, 'candidate-1'), null);
  assert.equal(createPhase2Run('candidate-1').terra_evidence_contract_version, 'terra-evidence-offsets-v1');
});

test('runtime RPC calls match the repaired migration signatures and retired revision is fail-closed', async () => {
  const controls = await readFile(new URL('../supabase/migrations/20260731140000_pipeline_phase2_controls.sql', import.meta.url), 'utf8');
  const polish = await readFile(new URL('../supabase/migrations/20260801130000_pipeline_v1_sol_polish.sql', import.meta.url), 'utf8');
  const commissionCompatibility = await readFile(new URL('../supabase/migrations/20260801131500_pipeline_v1_commission_compatibility.sql', import.meta.url), 'utf8');
  const commissionWrapperFix = await readFile(new URL('../supabase/migrations/20260801133000_pipeline_v1_commission_wrapper_fix.sql', import.meta.url), 'utf8');
  assert.match(controls, /create or replace function public\.commission_pipeline_v1_editorial_pitch\(\s*p_candidate_external_id text,\s*p_priority integer default 50,\s*p_requested_by uuid default null\s*\) returns jsonb/i);
  assert.match(controls, /create or replace function public\.research_again_pipeline_v1\(\s*p_candidate_external_id text,\s*p_priority integer default 50,\s*p_requested_by uuid default null\s*\) returns jsonb/i);
  assert.match(controls, /drop function if exists public\.authorize_pipeline_v1_revision\(text, integer, uuid\)/i);
  assert.match(controls, /authorize_pipeline_v1_revision\(\s*p_candidate_external_id text,\s*p_priority integer default 50,\s*p_requested_by uuid default null,\s*p_revision_instructions text default null\s*\) returns jsonb[\s\S]*?Pipeline V1 Luna Revision is retired/i);
  assert.doesNotMatch(controls, /parameters ->> 'authorization' = 'run_revision'/i);
  assert.doesNotMatch(controls, /values\([^\n]*'run_revision'/i);
  assert.match(polish, /create or replace function public\.commission_pipeline_v1_editorial_pitch\(\s*p_candidate_external_id text,\s*p_priority integer default 50,\s*p_requested_by uuid default null,\s*p_research_requirement text default null\s*\) returns jsonb/i);
  assert.match(commissionCompatibility, /submitted := public\.commission_editorial_pitch\(\s*p_candidate_external_id::text,\s*p_priority::integer,\s*p_requested_by::uuid\s*\)/i);
  assert.match(commissionWrapperFix, /parameters = parameters \|\| jsonb_build_object\('pipeline_version', 'v1'\), max_attempts = 1/i);
  assert.match(polish, /create or replace function public\.authorize_pipeline_v1_sol_polish\(\s*p_candidate_external_id text,\s*p_priority integer default 50,\s*p_requested_by uuid default null,\s*p_pipeline_v1_enabled boolean default false\s*\) returns jsonb/i);
  assert.match(polish, /action in \([^\n]*'materialize'/i);
  assert.match(polish, /grant execute on function public\.persist_pipeline_sol_polish\(text,uuid,text,uuid,text,text,text,text,text,text,jsonb,jsonb,text,text,text,text,text,jsonb,numeric,uuid\) to service_role/i);
});
