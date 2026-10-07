import assert from 'node:assert/strict';
import test from 'node:test';
import { Phase2Orchestrator } from '../src/pipeline/phase2-orchestrator.mjs';
import { PHASE2_SOURCE_REQUIREMENTS, sourceSufficiencyGate } from '../src/pipeline/phase2-source-gate.mjs';

const candidateFor = (storyForm = 'meanwhile') => ({
  id: 'source-gate-candidate',
  title: 'A source-backed change',
  url: 'https://example.com/story',
  description: 'A source-backed change matters to readers.',
  status: 'pitch_ready',
  commission: { brief: 'Explain the source-backed change.', section_id: 'systems', story_form: storyForm, source_urls: ['https://example.com/story'] },
  classification: { primary_section: 'systems', story_form: storyForm, editorial_pitch: { accepted: true } }
});

const documentFor = (id, { classification = 'original_reporting', text = `Independent reporting for ${id}.`, originalSource = null } = {}) => ({
  id,
  content: text,
  source_type: classification,
  canonical_url: `https://${id}.example.test/report`,
  provenance: originalSource ? { original_source_url: originalSource } : {}
});

test('source requirements are explicit per story form and fail on the commissioned Meanwhile floor', () => {
  assert.deepEqual(PHASE2_SOURCE_REQUIREMENTS.meanwhile, { minimumAccessibleSources: 3, minimumIndependentSources: 2, minimumPrimarySources: 0 });
  assert.deepEqual(PHASE2_SOURCE_REQUIREMENTS.systems, { minimumAccessibleSources: 10, minimumIndependentSources: 6, minimumPrimarySources: 2 });
  const result = sourceSufficiencyGate({ candidate: candidateFor('meanwhile'), documents: [documentFor('one')] });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'research_blocked');
  assert.ok(result.missing.some(item => item.blocker_id === 'source-count'));
  assert.ok(result.missing.some(item => item.blocker_id === 'independent-source-count'));
});

test('duplicate or syndicated derivative coverage counts once for independence', () => {
  const origin = 'https://origin.example.test/report';
  const result = sourceSufficiencyGate({
    candidate: candidateFor('meanwhile'),
    documents: [
      documentFor('one', { classification: 'derivative_reporting', originalSource: origin }),
      documentFor('two', { classification: 'derivative_reporting', originalSource: origin }),
      documentFor('three', { classification: 'derivative_reporting', originalSource: origin })
    ]
  });
  assert.equal(result.counts.accessible, 3);
  assert.equal(result.counts.independent, 1);
  assert.equal(result.counts.derivative, 3);
  assert.equal(result.counts.duplicate_or_syndicated_groups, 2);
  assert.equal(result.missing.some(item => item.blocker_id === 'independent-source-count'), true);
});

test('primary-source requirements are evaluated by form', () => {
  const documents = Array.from({ length: 6 }, (_, index) => documentFor(`source-${index}`));
  const result = sourceSufficiencyGate({ candidate: candidateFor('worth-your-time'), documents });
  assert.equal(result.counts.accessible, 6);
  assert.equal(result.counts.primary, 0);
  assert.equal(result.missing.some(item => item.blocker_id === 'primary-source-availability'), true);
});

test('only an explicit documented human override can bypass a source gate', () => {
  const blocked = { candidate: candidateFor('meanwhile'), documents: [documentFor('one')] };
  assert.equal(sourceSufficiencyGate(blocked).ok, false);
  const overridden = sourceSufficiencyGate({
    ...blocked,
    override: { approved: true, actor: 'editor-1', reason: 'The remaining source is a uniquely authoritative record.', approved_at: '2026-07-31T12:00:00Z', authorization_id: 'override-1' }
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.overridden, true);
  assert.equal(overridden.automatic_override, false);
  assert.equal(overridden.override.authorization_id, 'override-1');
});

test('HTTP 403, empty body, extraction failure, and duplicate inaccessible diagnostics remain visible as optional warnings', () => {
  const result = sourceSufficiencyGate({
    candidate: candidateFor('meanwhile'),
    documents: [],
    fetchDiagnostics: [
      { source_id: 'source-403', url: 'https://example.com/403', ok: false, accessible: false, status: 403, error: 'HTTP 403', extraction_status: 'failed' },
      { source_id: 'source-empty', url: 'https://example.com/empty', ok: true, accessible: false, status: 200, error: 'empty_extracted_text', extraction_status: 'empty' },
      { source_id: 'source-extraction', url: 'https://example.com/extraction', ok: true, accessible: false, status: 200, error: 'reader_failed', extraction_status: 'failed' },
      { source_id: 'source-duplicate', url: 'https://example.com/403', ok: false, accessible: false, status: 403, error: 'duplicate_requested_source', duplicate: true }
    ]
  });
  assert.equal(result.inaccessible.length, 3);
  assert.equal(result.optional_inaccessible.length, 3);
  assert.equal(result.mandatory_inaccessible.length, 0);
  assert.equal(result.warnings.length, 3);
  assert.ok(result.warnings.some(item => item.category === 'optional_source_unavailable' && item.status === 403));
  assert.ok(result.warnings.some(item => item.error === 'empty_extracted_text'));
  assert.ok(result.warnings.some(item => item.error === 'reader_failed'));
});

test('a valid approved snapshot satisfies accessibility when the live URL returns 403', async () => {
  const urls = ['https://example.com/one', 'https://example.com/two', 'https://example.com/three'];
  const candidate = candidateFor('meanwhile');
  candidate.commission.source_urls = urls;
  candidate.known_sources = urls.map((url, index) => ({
    id: `known-${index}`,
    url,
    title: candidate.title,
    approved_snapshot: { id: `snapshot-${index}`, approved: true, text: `Approved retained source text ${index} for the source-backed change.` }
  }));
  const orchestrator = new Phase2Orchestrator({ fetcher: async () => ({ ok: false, status: 403, error: 'HTTP 403' }) });
  const run = { id: 'run-snapshot', events: [], source_fetches: [] };
  const documents = await orchestrator.retrieveSources({ state: {}, candidate, run });
  assert.equal(documents.length, 3);
  assert.ok(documents.every(document => document.extraction.source === 'approved_snapshot'));
  assert.ok(run.source_fetches.filter(item => !item.duplicate).every(item => item.snapshot_used === true && item.access_mode === 'approved_snapshot'));
  const gate = sourceSufficiencyGate({ candidate, documents, fetchDiagnostics: run.source_fetches });
  assert.equal(gate.ok, true);
  assert.equal(gate.inaccessible.length, 0);
});

test('deterministic source failure blocks before Terra and creates no provider attempt', async () => {
  const candidate = candidateFor('systems');
  const state = { candidates: [candidate], documents: [], research_packets: [], reviews: [], review_actions: [], runs: [] };
  let terraCalls = 0;
  const result = await new Phase2Orchestrator({
    fetcher: async () => ({ ok: false, status: 403, error: 'HTTP 403' }),
    terraAdapter: { async generate() { terraCalls += 1; throw new Error('Terra must not run'); } }
  }).process({ state, candidateId: candidate.id, commissionAuthorization: { job_id: 'source-gate-job' } });
  assert.equal(terraCalls, 0);
  assert.equal(result.run.status, 'blocked');
  assert.equal(result.run.state, 'research_blocked');
  assert.equal(result.run.error.code, 'PHASE2_SOURCE_INSUFFICIENT');
  assert.equal(result.run.model_usage.length, 0);
  assert.equal(state.phase2_attempts.length, 0);
  assert.ok(result.run.error.blockers.some(item => item.blocker_id === 'source-count'));
  assert.equal(result.run.source_gate.mandatory_inaccessible.length, 0);
  assert.equal(result.run.source_gate.optional_inaccessible.length, 1);
});

test('optional 403 does not block when usable thresholds are met', () => {
  const candidate = candidateFor('meanwhile');
  const url = candidate.commission.source_urls[0];
  const result = sourceSufficiencyGate({
    candidate,
    documents: [documentFor('one'), documentFor('two'), documentFor('three')],
    fetchDiagnostics: [{ source_id: 'optional-source', url, ok: false, accessible: false, status: 403, error: 'HTTP 403', extraction_status: 'failed' }]
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'ready_for_terra');
  assert.equal(result.missing.length, 0);
  assert.equal(result.warnings[0].category, 'optional_source_unavailable');
});

test('explicitly mandatory 403 blocks even when usable thresholds are met', () => {
  const url = 'https://example.com/mandatory-403';
  const candidate = candidateFor('meanwhile');
  candidate.commission.mandatory_source_urls = [url];
  const result = sourceSufficiencyGate({
    candidate,
    documents: [documentFor('one'), documentFor('two'), documentFor('three')],
    fetchDiagnostics: [{ source_id: 'mandatory-source', url, ok: false, accessible: false, status: 403, error: 'HTTP 403', extraction_status: 'failed' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_categories.includes('mandatory_source_unavailable'), true);
  assert.equal(result.mandatory_inaccessible.length, 1);
  assert.ok(result.missing.some(item => item.blocker_id.startsWith('mandatory-source-unavailable-')));
});

test('a human-authorized mandatory source list is honored without making commission URLs mandatory by default', () => {
  const candidate = candidateFor('meanwhile');
  const url = candidate.commission.source_urls[0];
  const result = sourceSufficiencyGate({
    candidate,
    documents: [documentFor('one'), documentFor('two'), documentFor('three')],
    mandatorySourceUrls: [url],
    fetchDiagnostics: [{ source_id: 'authorized-source', url, ok: false, accessible: false, status: 403, error: 'HTTP 403', extraction_status: 'failed' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.mandatory_inaccessible.length, 1);
  assert.equal(result.failure_categories.includes('mandatory_source_unavailable'), true);
});

test('a uniquely supporting required claim blocks when its source is unavailable', () => {
  const url = 'https://example.com/unique-claim-source';
  const candidate = candidateFor('meanwhile');
  candidate.commission.required_claims = [{ claim_id: 'unique-product-fact', source_urls: [url] }];
  const result = sourceSufficiencyGate({
    candidate,
    documents: [documentFor('one'), documentFor('two'), documentFor('three')],
    fetchDiagnostics: [{ source_id: 'unique-source', url, ok: false, accessible: false, status: 403, error: 'HTTP 403', extraction_status: 'failed' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_categories.includes('required_claim_unsupported'), true);
  assert.ok(result.missing.some(item => item.blocker_id.startsWith('required-claim-unsupported-')));
});

test('thresholds are evaluated after excluding inaccessible optional sources', () => {
  const result = sourceSufficiencyGate({
    candidate: candidateFor('meanwhile'),
    documents: [documentFor('one'), documentFor('two'), documentFor('three')],
    fetchDiagnostics: [
      { source_id: 'optional-1', url: 'https://example.com/optional-1', ok: false, accessible: false, status: 403, extraction_status: 'failed' },
      { source_id: 'optional-2', url: 'https://example.com/optional-2', ok: false, accessible: false, status: 403, extraction_status: 'failed' }
    ]
  });
  assert.equal(result.counts.accessible, 3);
  assert.equal(result.ok, true);
  assert.equal(result.missing.length, 0);
});

test('thresholds_not_met blocks when usable inventory remains below the form floor', () => {
  const result = sourceSufficiencyGate({
    candidate: candidateFor('meanwhile'),
    documents: [documentFor('one'), documentFor('two')],
    fetchDiagnostics: [{ source_id: 'optional-1', url: 'https://example.com/optional-1', ok: false, accessible: false, status: 403, extraction_status: 'failed' }]
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure_categories.includes('thresholds_not_met'), true);
  assert.ok(result.missing.some(item => item.blocker_id === 'source-count'));
});
