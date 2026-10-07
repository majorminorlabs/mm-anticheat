import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

const { Phase2Orchestrator } = await import('../src/pipeline/phase2-orchestrator.mjs');
const { PHASE2_VERSION } = await import('../src/pipeline/phase2-state.mjs');
const { stableJson } = await import('../src/pipeline/evidence-packet.mjs');

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

test('bounded V1 acquisition expands a seed pitch before the source gate', async () => {
  const acquisitionCandidate = {
    ...candidate(),
    id: 'acquisition-candidate',
    title: 'The local record changed the workflow',
    commission: { ...candidate().commission, story_form: 'while-youre-here', source_urls: ['https://example.com/report'] },
    classification: { ...candidate().classification, story_form: 'while-youre-here', editorial_pitch: { accepted: true, research_requirement: 'none', lens: 'A practical explanation of how the record changed the workflow for readers.', evidence_plan: ['Explain the documented workflow change for readers.', 'Describe the practical effect in context.'] } }
  };
  const state = { candidates: [acquisitionCandidate], documents: [], research_packets: [], reviews: [], review_actions: [], runs: [] };
  const fetcher = async url => ({ ok: true, canonical_url: url, fetched_at: new Date().toISOString(), text: `The local record changed the workflow. Independent reporting about ${url} explains the practical effect for readers.` });
  const results = [2, 3, 4, 5].map(index => ({ title: `Independent report ${index}`, url: `https://independent-${index}.example/report`, snippet: 'local record workflow readers', provider: 'test', rank: index }));
  const researchRouter = {
    async search(input) { return { query: input.text, results, coverage: { shouldEscalate: false }, warnings: [], usage: { searchRequests: 1, pagesFetched: 0, entries: [] } }; },
    async fetchPages(items, { fetcher: fetchPage }) { return { pages: await Promise.all(items.map(async item => ({ ...(await fetchPage(item.url)), search_result: item }))), warnings: [] }; }
  };
  const run = { id: 'acquisition-run', source_fetches: [], events: [] };
  const documents = await new Phase2Orchestrator({ fetcher, researchRouter }).retrieveSources({ state, candidate: acquisitionCandidate, run });
  assert.equal(documents.length, 5);
  assert.equal(run.source_searches.length, 3);
  assert.equal(run.source_acquisition.limits.max_search_queries, 3);
  assert.equal(run.source_acquisition.limits.max_retained_sources, 12);
  assert.equal(run.source_acquisition.retained_search_sources, 4);
  assert.ok(run.source_fetches.some(item => item.acquisition === 'bounded_search'));
});

test('a frozen-packet Draft rerun skips acquisition and Terra while preserving the packet identity', async () => {
  const sourceId = 'source:candidate-frozen:source-1';
  const evidenceText = 'The retained source documents the physical friction created by the key.';
  const packetPayload = {
    version: 'pipeline-v1-evidence-packet-offsets-v1',
    terra_evidence_contract_version: 'terra-evidence-offsets-v1',
    phase2_inventory_contract_version: 'phase2-inventory-v1',
    sources: [{ source_id: sourceId, canonical_url: 'https://example.com/retained', title: 'Retained source', publisher: 'Example', source_type: 'original_reporting', classification: 'original_reporting', independence_key: 'group:retained', accessible: true, ok: true }],
    claims: [{ claim_id: 'claim-1', claim: 'The key creates physical friction.', source_ids: [sourceId], evidence: [{ evidence_id: 'evidence-001', source_id: sourceId, excerpt: evidenceText, start_offset: 0, end_offset: evidenceText.length, claim_ids: ['claim-1'], evidence_role: 'must_use', reason: 'Supports the claim.' }], confidence: 'high' }],
    claim_targets: ['claim-1'],
    required_facts: [],
    prohibited_claims: [],
    ledgers: { quotations: [], proper_names: [], numbers: [] },
    unresolved_research_questions: [],
    blockers: [],
    draft_constraints: [],
    totals: {},
    diagnostics: {},
    terra_summary: { selected_source_ids: [sourceId], optional_source_ids: [], contradictions: [], freshness_risks: [], missing_evidence: [], blockers: [], draft_constraints: [] },
    terra_usage: null,
    terra_cost: null
  };
  const frozenChecksum = crypto.createHash('sha256').update(stableJson(packetPayload)).digest('hex');
  const packet = { ...packetPayload, frozen_evidence_packet_sha256: frozenChecksum };
  const reuseCandidate = {
    ...candidate(), id: 'candidate-frozen', status: 'verification_failed', phase2_state: 'failed',
    classification: { ...candidate().classification, editorial_pitch: { ...candidate().classification.editorial_pitch, research_requirement: 'none' } }
  };
  const oldRun = {
    id: 'old-failed-run', case_run_id: 'old-failed-run', candidate_id: reuseCandidate.id, pipeline_version: PHASE2_VERSION,
    terra_evidence_contract_version: 'terra-evidence-offsets-v1', status: 'failed', state: 'failed', frozen_evidence_packet_sha256: frozenChecksum,
    source_gate: { ok: true, counts: { accessible: 1, independent: 1, primary: 0 }, requirements: { minimumAccessibleSources: 1, minimumIndependentSources: 1, minimumPrimarySources: 0 } },
    provider_call_count: 1, provider_calls: [{ stage: 'draft', started: true }], model_usage: [], estimated_cost_usd: null, attempts: [], events: [], source_fetches: [], source_searches: []
  };
  const state = {
    candidates: [reuseCandidate], documents: [], research_packets: [{ id: 'old-packet', candidate_id: reuseCandidate.id, processing_run_id: oldRun.id, packet, frozen_evidence_packet_sha256: frozenChecksum }],
    phase2_runs: [oldRun], phase2_attempts: [], phase2_artifacts: [], phase2_reviews: [], phase2_persistence: [], reviews: [], review_actions: [], runs: []
  };
  const body = `# The local record changed the workflow\n\n*What the record means for the people using the system.*\n\n${Array.from({ length: 260 }, (_, index) => `token${index}`).join(' ')}`;
  const draftResponse = { raw: JSON.stringify({ headline: reuseCandidate.title, dek: 'The physical key creates a deliberate delay.', body_markdown: body, section: 'systems', lens: 'Physical friction changes the workflow.', beats: ['cities'], claim_support: [{ claim_id: 'claim-1', evidence_ids: ['evidence-001'], article_anchor: 'paragraph-1', treatment: 'paraphrase' }], warnings: [] }), metrics: { model_usage: { provider: 'codex', model: 'test-model', reasoning: 'high', input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, credits: 0, estimated_cost_usd: 0, wall_ms: 1 } } };
  const calls = { terra: 0, draft: 0 };
  const result = await new Phase2Orchestrator({
    fetcher: async () => { throw new Error('frozen-packet rerun must not refetch'); },
    terraAdapter: { async generate() { calls.terra++; throw new Error('frozen-packet rerun must not call Terra'); } },
    draftAdapter: { async generate({ onProviderStart }) { calls.draft++; onProviderStart?.(); return draftResponse; } },
    revisionAdapter: { async generate() { throw new Error('Revision must not run'); } }
  }).process({ state, candidateId: reuseCandidate.id, commissionAuthorization: { job_id: 'new-draft-job', case_run_id: 'new-run', pipeline_version: 'v1', research_requirement: 'none', reuse_frozen_evidence_packet: true, frozen_evidence_packet: packet, frozen_evidence_packet_sha256: frozenChecksum } });
  assert.equal(result.candidate.status, 'ready_for_review', JSON.stringify(result));
  assert.equal(result.review.frozen_evidence_packet_sha256, frozenChecksum);
  assert.equal(result.run.previous_run_id, oldRun.id);
  assert.equal(result.run.reused_frozen_evidence_packet, true);
  assert.equal(calls.terra, 0);
  assert.equal(calls.draft, 1);
  assert.equal(result.run.source_searches.length, 0);
  assert.equal(result.run.events.some(event => event.type === 'frozen_packet_reused'), true);
});
