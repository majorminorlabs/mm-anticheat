import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const { Phase2Orchestrator } = await import('../src/pipeline/phase2-orchestrator.mjs');
const { PHASE2_VERSION } = await import('../src/pipeline/phase2-state.mjs');

const candidate = () => ({
  id: 'candidate-1', title: 'The local record changed the workflow', url: 'https://example.com/report', description: 'The local record changed the workflow.', status: 'pitch_ready',
  commission: { brief: 'Explain what the local record changed and why the reader should care.', section_id: 'systems', story_form: 'meanwhile', beats: ['cities'], tags: ['records'], notes: '', source_urls: ['https://example.com/report', 'https://example.net/analysis', 'https://example.org/context'] },
  classification: { primary_section: 'systems', story_form: 'meanwhile', editorial_pitch: { accepted: true, research_requirement: 'required' } }
});

const stateFor = () => ({ candidates: [candidate()], documents: [], research_packets: [], reviews: [], review_actions: [], runs: [] });
const sourceId = `source:candidate-1:${crypto.createHash('sha256').update('https://example.com/report').digest('hex').slice(0, 24)}`;
const sourceText = 'The local record changed the workflow. Editors documented the practical effect for readers and operators.';
const body = `# The local record changed the workflow\n\n*What the record means for the people using the system.*\n\n${Array.from({ length: 260 }, (_, index) => `token${index}`).join(' ')}`;
const terraClaim = { claim_id: 'claim-1', claim: 'The record changed the workflow.', source_ids: [sourceId], evidence: [{ source_id: sourceId, start_offset: 0, end_offset: sourceText.length, claim_ids: ['claim-1'], evidence_role: 'must_use', reason: 'Supports the workflow claim.' }], confidence: 'high' };
const terra = { research_questions: [{ question_id: 'question-1', question: 'What changed?', answerable: true }], selected_source_ids: [sourceId], optional_source_ids: [], excluded_sources: [], claims: [terraClaim], required_facts: [{ fact_id: 'fact-1', text: 'The local record changed the workflow.', source_ids: [sourceId] }], prohibited_claims: [], ledgers: { quotations: [], proper_names: [], numbers: [] }, claim_targets: ['claim-1'], unresolved_research_questions: [], contradictions: [], freshness_risks: [], missing_evidence: [], blockers: [], draft_constraints: ['Attribute the change to the retained source.'], ready_to_draft: true };
const claimSupport = [{ claim_id: 'claim-1', evidence_ids: ['evidence-001'], article_anchor: 'paragraph-1', treatment: 'paraphrase' }];
const draft = { headline: 'The local record changed the workflow', dek: 'What the record means for the people using the system.', body_markdown: body, section: 'systems', lens: 'The record reveals a practical change.', beats: ['cities'], claim_support: claimSupport, warnings: [] };
const revision = { ...draft, changed_claim_ids: [], revision_notes: [] };
const response = value => ({ raw: JSON.stringify(value), metrics: { model_usage: { provider: 'codex', model: 'test-model', reasoning: 'high', stage: 'test', attempt: 1, input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, credits: 0, estimated_cost_usd: 0, wall_ms: 1 } } });
const fetcher = async url => ({ ok: true, canonical_url: url, fetched_at: new Date().toISOString(), text: url === 'https://example.com/report' ? sourceText : `${sourceText} Independent context from ${url}.` });

function adapters({ blocked = false } = {}) {
  const calls = { research: 0, draft: 0, revision: 0 };
  return {
    calls,
    terraAdapter: { async generate() { calls.research++; return response(blocked ? { ...terra, blockers: [{ blocker_id: 'blocker-1', question: 'What changed?', reason: 'The official record is incomplete.', required_action: 'Research again.', source_ids: [sourceId] }], ready_to_draft: false } : terra); } },
    draftAdapter: { async generate() { calls.draft++; return response(draft); } },
    revisionAdapter: { async generate() { calls.revision++; return response(revision); } }
  };
}

test('Phase 2 completes the commissioned path with one Terra and one Luna Draft call', async () => {
  const state = stateFor(); const mocks = adapters();
  const result = await new Phase2Orchestrator({ ...mocks, fetcher }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'commission-1' } });
  assert.equal(result.candidate.status, 'ready_for_review', JSON.stringify(result));
  assert.equal(result.candidate.phase2_state, 'ai_review_ready');
  assert.equal(result.review.pipeline_version, PHASE2_VERSION);
  assert.equal(result.review.terra_evidence_contract_version, 'terra-evidence-offsets-v1');
  assert.equal(result.review.frozen_evidence_packet_sha256, result.review.evidence_packet.frozen_evidence_packet_sha256);
  assert.equal(result.review.evidence_packet.terra_evidence_contract_version, 'terra-evidence-offsets-v1');
  assert.deepEqual(result.review.evidence_packet.draft_constraints, ['Attribute the change to the retained source.']);
  assert.deepEqual(result.review.research.draft_constraints, result.review.evidence_packet.draft_constraints);
  assert.equal(result.review.evidence_packet.claims[0].evidence[0].excerpt, sourceText);
  assert.equal(result.review.evidence_packet.sources[0].excerpt, undefined);
  assert.equal(result.review.evidence_packet.claims[0].evidence[0].excerpt_sha256.length, 64);
  assert.equal(result.review.evidence_packet.claims[0].evidence[0].source_text_sha256.length, 64);
  assert.equal(state.phase2_attempts.find(item => item.stage === 'draft').frozen_evidence_packet_sha256, result.review.frozen_evidence_packet_sha256);
  assert.equal(state.phase2_attempts.some(item => item.stage === 'revision'), false);
  assert.equal(result.review.revision, null);
  assert.equal(mocks.calls.research, 1); assert.equal(mocks.calls.draft, 1); assert.equal(mocks.calls.revision, 0);
  assert.equal(state.phase2_attempts.filter(item => item.status === 'complete').length, 5);
  const resumed = await new Phase2Orchestrator({ ...mocks, fetcher: async () => { throw new Error('should not refetch after completion'); } }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'commission-1' } });
  assert.equal(resumed.resumed, true, JSON.stringify({ resumed, run: state.phase2_runs.at(-1), review: state.reviews.at(-1)?.deterministic_review }));
  assert.equal(mocks.calls.research, 1); assert.equal(mocks.calls.draft, 1); assert.equal(mocks.calls.revision, 0);
});

test('Terra blockers stop before drafting, retain the blocker, and expose Research Again', async () => {
  const state = stateFor(); const mocks = adapters({ blocked: true });
  const result = await new Phase2Orchestrator({ ...mocks, fetcher }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'commission-1' } });
  assert.equal(result.candidate.status, 'research_blocked');
  assert.equal(result.candidate.phase2_state, 'research_blocked');
  assert.equal(result.research_again_required, true, JSON.stringify(result));
  assert.equal(result.run.error.blockers[0].blocker_id, 'blocker-1');
  assert.equal(result.run.error.blockers[0].question, 'What changed?');
  assert.equal(result.run.error.blockers[0].required_action, 'Research again.');
  assert.equal(mocks.calls.research, 1); assert.equal(mocks.calls.draft, 0); assert.equal(mocks.calls.revision, 0);
  assert.equal(result.run.events.at(-1).human_action, 'research_again');
  const unchanged = await new Phase2Orchestrator({ ...mocks, fetcher: async () => { throw new Error('must wait for explicit research authorization'); } }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'commission-1' } });
  assert.equal(unchanged.research_again_required, true);
  assert.equal(mocks.calls.research, 1);
  await new Phase2Orchestrator({ ...mocks, fetcher }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'commission-2', action: 'research_again' } });
  assert.equal(mocks.calls.research, 2);
});

test('invalid Luna evidence references terminalize Draft without Revision or retry', async () => {
  const state = stateFor();
  const mocks = adapters();
  const invalidDraft = { ...draft, claim_support: [{ ...claimSupport[0], evidence_ids: ['unknown-evidence'] }] };
  const result = await new Phase2Orchestrator({
    fetcher,
    terraAdapter: mocks.terraAdapter,
    draftAdapter: { async generate() { mocks.calls.draft++; return response(invalidDraft); } },
    revisionAdapter: { async generate() { mocks.calls.revision++; throw new Error('Revision must not run after invalid Draft.'); } }
  }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'commission-invalid-draft' } });
  assert.equal(result.run.status, 'failed');
  assert.equal(result.error.code, 'PHASE2_SCHEMA_INVALID');
  assert.equal(mocks.calls.research, 1);
  assert.equal(mocks.calls.draft, 1);
  assert.equal(mocks.calls.revision, 0);
  const attempt = state.phase2_attempts.find(item => item.stage === 'draft');
  assert.equal(attempt.status, 'failed');
  assert.equal(attempt.raw_response, JSON.stringify(invalidDraft));
});

test('automatic Luna Revision is rejected even when a revision authorization is supplied', async () => {
  const state = stateFor();
  const calls = { research: 0, draft: 0, revision: 0 };
  await assert.rejects(() => new Phase2Orchestrator({
    fetcher,
    terraAdapter: { async generate() { calls.research++; return response(terra); } },
    draftAdapter: { async generate() { calls.draft++; return response(draft); } },
    revisionAdapter: { async generate() { calls.revision++; return response(revision); } }
  }).process({ state, candidateId: 'candidate-1', commissionAuthorization: { job_id: 'revision-job', action: 'run_revision' } }), error => error.code === 'PHASE2_REVISION_DISABLED');
  assert.equal(calls.research, 0);
  assert.equal(calls.draft, 0);
  assert.equal(calls.revision, 0);
});
