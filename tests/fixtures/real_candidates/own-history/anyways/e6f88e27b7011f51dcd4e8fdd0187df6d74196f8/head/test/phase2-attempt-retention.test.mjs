import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Phase2Orchestrator } from '../src/pipeline/phase2-orchestrator.mjs';
import { saveState } from '../src/pipeline/state.mjs';

const urls = ['https://example.com/report', 'https://example.net/report', 'https://example.org/report'];
const sourceText = 'The local record changed the workflow. Editors documented the practical effect for readers and operators.';
const sourceId = `source:retention-candidate:${crypto.createHash('sha256').update(urls[0]).digest('hex').slice(0, 24)}`;

const candidate = () => ({
  id: 'retention-candidate', title: 'The local record changed the workflow', url: urls[0], description: 'The local record changed the workflow.', status: 'pitch_ready',
  commission: { brief: 'Explain the local record.', section_id: 'systems', story_form: 'meanwhile', source_urls: urls },
  classification: { primary_section: 'systems', story_form: 'meanwhile', editorial_pitch: { accepted: true } }
});

const stateFor = () => ({ candidates: [candidate()], documents: [], research_packets: [], reviews: [], review_actions: [], runs: [] });
const fetcher = async url => ({ ok: true, canonical_url: url, text: url === urls[0] ? sourceText : `${sourceText} Independent context from ${url}.` });
const usage = { provider: 'codex', model: 'gpt-5.6-terra', reasoning: 'high', stage: 'research', attempt: 1, input_tokens: 8818, cached_input_tokens: 0, output_tokens: 1787, reasoning_output_tokens: 135, credits: 0.977, estimated_cost_usd: 0.49, wall_ms: 45_700 };
const responseFor = raw => ({
  raw,
  metrics: {
    model_usage: usage,
    wall_ms: usage.wall_ms,
    adapter_transport: { raw_stdout: '{"type":"turn.completed","token":"secret-provider-token"}', raw_stderr: 'Authorization: Bearer secret-provider-token', exit_code: 0, request_id: 'provider-request-1' }
  }
});

const failedTerra = {
  research_questions: [{ question_id: 'question-1', question: 'What changed?', answerable: true }],
  selected_source_ids: [sourceId], optional_source_ids: [], excluded_sources: [], claims: [], required_facts: [], prohibited_claims: [],
  ledgers: { quotations: [], proper_names: [], numbers: [] }, claim_targets: [], unresolved_research_questions: [], contradictions: [], freshness_risks: [], missing_evidence: [],
  blockers: [42], draft_constraints: ['Do not claim the mechanism without the official record.'], ready_to_draft: false
};

const validTerra = {
  research_questions: [{ question_id: 'question-1', question: 'What changed?', answerable: true }],
  selected_source_ids: [sourceId], optional_source_ids: [], excluded_sources: [], claims: [], required_facts: [], prohibited_claims: [],
  ledgers: { quotations: [], proper_names: [], numbers: [] }, claim_targets: [], unresolved_research_questions: [], contradictions: [], freshness_risks: [], missing_evidence: [],
  blockers: [], draft_constraints: ['Stay within the retained source.'], ready_to_draft: true
};

test('schema-invalid Terra response retains usage, raw response, diagnostics, and no completed artifact', async () => {
  const state = stateFor();
  const calls = { research: 0, draft: 0, revision: 0 };
  const result = await new Phase2Orchestrator({
    fetcher,
    terraAdapter: { async generate() { calls.research += 1; return responseFor(JSON.stringify(failedTerra)); } },
    draftAdapter: { async generate() { calls.draft += 1; throw new Error('Luna draft must not run'); } },
    revisionAdapter: { async generate() { calls.revision += 1; throw new Error('Luna revision must not run'); } }
  }).process({ state, candidateId: 'retention-candidate', commissionAuthorization: { job_id: 'retention-job' } });

  const attempt = state.phase2_attempts.find(item => item.stage === 'research');
  assert.equal(calls.research, 1);
  assert.equal(calls.draft, 0);
  assert.equal(calls.revision, 0);
  assert.equal(result.run.status, 'failed');
  assert.equal(result.run.state, 'failed');
  assert.equal(result.error.code, 'PHASE1_SCHEMA_INVALID');
  assert.equal(state.phase2_artifacts.some(item => item.stage === 'research'), false);
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.raw_response, JSON.stringify(failedTerra));
  assert.equal(attempt.raw_provider_events.includes('secret-provider-token'), false);
  assert.equal(attempt.provider_stderr.includes('secret-provider-token'), false);
  assert.equal(attempt.provider_request_id, 'provider-request-1');
  assert.equal(attempt.provider_exit_status, 0);
  assert.equal(attempt.usage.credits, 0.977);
  assert.equal(attempt.usage.input_tokens, 8818);
  assert.equal(attempt.usage.output_tokens, 1787);
  assert.equal(attempt.usage.reasoning_output_tokens, 135);
  assert.equal(attempt.parse_outcome, 'valid');
  assert.equal(attempt.schema_outcome, 'invalid');
  assert.equal(attempt.final_stage_classification, 'schema_validation_failed');
  assert.equal(attempt.prompt_sha256.length, 64);
  assert.equal(attempt.runtime_inventory_sha256.length, 64);
  assert.equal(result.run.model_usage.length, 1);
  assert.equal(result.run.model_usage[0].credits, 0.977);
  assert.equal(result.run.estimated_cost_usd, 0.49);
  const persisted = state.phase2_persistence.find(item => item.stage === 'research');
  assert.equal(persisted.payload.phase2_attempts.find(item => item.stage === 'research').raw_response, JSON.stringify(failedTerra));
});

test('invalid Terra offsets fail closed after one provider attempt, retain raw usage, and never call Luna', async () => {
  const state = stateFor();
  const calls = { research: 0, draft: 0, revision: 0 };
  const invalidOffsetTerra = {
    ...validTerra,
    claims: [{ claim_id: 'claim-1', claim: 'The record changed the workflow.', source_ids: [sourceId], evidence: [{ source_id: sourceId, start_offset: 0, end_offset: sourceText.length + 1, claim_ids: ['claim-1'], evidence_role: 'must_use', reason: 'Supports the claim.' }], confidence: 'high' }],
    claim_targets: ['claim-1']
  };
  const raw = JSON.stringify(invalidOffsetTerra);
  const result = await new Phase2Orchestrator({
    fetcher,
    terraAdapter: { async generate() { calls.research += 1; return responseFor(raw); } },
    draftAdapter: { async generate() { calls.draft += 1; throw new Error('Luna draft must not run after invalid offsets'); } },
    revisionAdapter: { async generate() { calls.revision += 1; throw new Error('Luna revision must not run after invalid offsets'); } }
  }).process({ state, candidateId: 'retention-candidate', commissionAuthorization: { job_id: 'offset-job' } });

  const attempt = state.phase2_attempts.find(item => item.stage === 'research');
  assert.equal(result.error.code, 'PHASE2_SCHEMA_INVALID');
  assert.equal(calls.research, 1);
  assert.equal(calls.draft, 0);
  assert.equal(calls.revision, 0);
  assert.equal(attempt.raw_response, raw);
  assert.equal(attempt.usage.credits, 0.977);
  assert.equal(attempt.schema_outcome, 'invalid');
  assert.ok(attempt.validation_errors.some(error => error.includes('beyond the frozen source text')));
  assert.equal(state.phase2_artifacts.some(item => item.stage === 'evidence_packet'), false);
});

test('invalid JSON retains provider usage and raw content before parsing, with no automatic retry or duplicate charge', async () => {
  const state = stateFor();
  let calls = 0;
  const raw = '{"truncated":true';
  const adapter = { async generate() { calls += 1; return responseFor(raw); } };
  const first = await new Phase2Orchestrator({ fetcher, terraAdapter: adapter }).process({ state, candidateId: 'retention-candidate', commissionAuthorization: { job_id: 'parse-job' } });
  assert.equal(first.error.code, 'PHASE2_INVALID_JSON');
  assert.equal(calls, 1);
  const attempt = state.phase2_attempts.find(item => item.stage === 'research');
  assert.equal(attempt.raw_response, raw);
  assert.equal(attempt.parse_outcome, 'invalid');
  assert.equal(attempt.usage.credits, 0.977);
  assert.equal(state.phase2_runs[0].model_usage.length, 1);
  const resumed = await new Phase2Orchestrator({ fetcher, terraAdapter: { async generate() { throw new Error('automatic retry forbidden'); } } }).process({ state, candidateId: 'retention-candidate', commissionAuthorization: { job_id: 'parse-job' } });
  assert.equal(resumed.resumed, true);
  assert.equal(calls, 1);
  assert.equal(state.phase2_runs[0].model_usage.length, 1);
});

test('downstream persistence failure is classified while the in-memory provider attempt remains auditable', async () => {
  const state = stateFor();
  let draftCalls = 0;
  const persistence = {
    async persistStage(record) {
      if (record.stage === 'research') {
        const error = new Error('synthetic persistence outage');
        error.code = 'PHASE2_PERSISTENCE_FAILED';
        throw error;
      }
    }
  };
  const result = await new Phase2Orchestrator({
    fetcher,
    persistence,
    terraAdapter: { async generate() { return responseFor(JSON.stringify(validTerra)); } },
    draftAdapter: { async generate() { draftCalls += 1; throw new Error('draft must not run after persistence failure'); } }
  }).process({ state, candidateId: 'retention-candidate', commissionAuthorization: { job_id: 'persistence-job' } });
  const attempt = state.phase2_attempts.find(item => item.stage === 'research');
  assert.equal(result.run.status, 'failed');
  assert.equal(result.error.code, 'PHASE2_PERSISTENCE_FAILED');
  assert.equal(draftCalls, 0);
  assert.equal(attempt.status, 'complete');
  assert.equal(attempt.retention_status, 'state_retained_persistence_failed');
  assert.equal(attempt.raw_response, JSON.stringify(validTerra));
  assert.equal(attempt.usage.credits, 0.977);
  assert.equal(result.run.model_usage.length, 1);
});

test('raw phase2 state survives a restrictive local artifact write', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'anyways-phase2-retention-test-'));
  const file = path.join(directory, 'state.json');
  try {
    const state = { phase2_attempts: [{ raw_response: '{"private":true}' }] };
    await saveState(file, state);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), state);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
