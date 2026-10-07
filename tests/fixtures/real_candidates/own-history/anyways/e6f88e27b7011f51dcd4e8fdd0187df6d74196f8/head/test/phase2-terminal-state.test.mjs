import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightEvidencePacket } from '../src/pipeline/evidence-packet.mjs';
import { Phase2Orchestrator } from '../src/pipeline/phase2-orchestrator.mjs';
import { createPhase2Run, phase2TerminalInvariant } from '../src/pipeline/phase2-state.mjs';

const candidate = {
  id: 'oversized-candidate',
  title: 'An oversized evidence input',
  description: 'A deterministic preflight case.',
  status: 'pitch_ready',
  commission: {
    brief: 'Explain the retained evidence boundary.',
    section_id: 'systems',
    story_form: 'meanwhile',
    beats: ['internet'],
    tags: [],
    notes: '',
    source_urls: ['https://source.example/one', 'https://source.example/two', 'https://source.example/three']
  },
  classification: { primary_section: 'systems', story_form: 'meanwhile', editorial_pitch: { accepted: true } }
};

const stateFor = () => ({
  candidates: [structuredClone(candidate)],
  documents: [],
  research_packets: [],
  reviews: [],
  review_actions: [],
  runs: [],
  phase2_runs: [],
  phase2_attempts: [],
  phase2_artifacts: [],
  phase2_reviews: [],
  phase2_persistence: []
});

test('preflight reports the shared packet metrics and rejects oversized retained input', () => {
  const sources = ['one', 'two', 'three'].map(id => ({ id, source_type: 'original_reporting', title: id, url: `https://source.example/${id}`, text: `${id}-${'x'.repeat(30_000)}` }));
  assert.throws(
    () => preflightEvidencePacket({ sources, preserveSourceText: true, includeRetainedText: true, limits: { maxTotalExcerptCharacters: 100_000 } }),
    error => error.code === 'EVIDENCE_PACKET_LIMIT_EXCEEDED'
      && error.details.limit_name === 'packet_characters'
      && error.details.preflight.serialized_inventory_characters > error.details.preflight.configured_limits.maxPacketCharacters
      && error.details.preflight.retained_source_text_characters > 90_000
      && error.details.preflight.per_source_contribution.length === 3
      && error.details.preflight.metadata_contribution.characters > 0
      && error.details.preflight.ledger_contribution.characters > 0
      && error.details.preflight.largest_contributors.length === 5
  );
});

test('oversized evidence input terminalizes before provider setup and performs cleanup', async () => {
  const state = stateFor();
  const calls = { terra: 0, draft: 0, revision: 0 };
  let checkpoints = 0;
  const adapter = stage => ({ model: `${stage}-test`, async generate() { calls[stage]++; throw new Error(`${stage} must not run`); } });
  const result = await new Phase2Orchestrator({
    retrievalLimits: { sourceChars: 30_000, maxTotalExcerptCharacters: 100_000 },
    fetcher: async url => ({ ok: true, canonical_url: url, text: `${url}-${'x'.repeat(30_000)}`, raw: `${url}-raw` }),
    terraAdapter: adapter('terra'),
    draftAdapter: adapter('draft'),
    revisionAdapter: adapter('revision'),
    checkpoint: async () => { checkpoints++; }
  }).process({ state, candidateId: candidate.id, commissionAuthorization: { job_id: 'oversized-commission' } });

  const run = result.run;
  assert.equal(result.candidate.status, 'research_blocked');
  assert.equal(result.candidate.phase2_state, 'research_blocked');
  assert.equal(run.status, 'blocked');
  assert.equal(run.state, 'research_blocked');
  assert.equal(run.error.classification, 'evidence_input_limit_exceeded');
  assert.equal(run.error.code, 'EVIDENCE_PACKET_LIMIT_EXCEEDED');
  assert.ok(run.started_at);
  assert.ok(run.finished_at);
  assert.equal(run.provider_call_count, 0);
  assert.equal(run.retry_count, 0);
  assert.ok(run.error.details.preflight.serialized_inventory_characters > 64_000);
  assert.equal(calls.terra + calls.draft + calls.revision, 0);
  assert.equal(state.phase2_attempts.length, 1);
  assert.equal(state.phase2_attempts[0].stage, 'source_inventory');
  assert.equal(state.phase2_attempts[0].status, 'failed');
  assert.ok(state.phase2_attempts[0].finished_at);
  assert.equal(state.phase2_attempts.some(attempt => attempt.status === 'running'), false);
  assert.ok(checkpoints > 0);
  assert.equal(phase2TerminalInvariant({ state, run, candidate: result.candidate }).ok, true);
});

test('terminal invariant accepts legitimate blocked runs and rejects running runs', () => {
  const blockedState = { phase2_attempts: [] };
  const blockedRun = createPhase2Run('candidate', { job_id: 'job' });
  blockedRun.status = 'blocked';
  blockedRun.state = 'research_blocked';
  blockedRun.finished_at = new Date().toISOString();
  assert.equal(phase2TerminalInvariant({ state: blockedState, run: blockedRun, candidate: { phase2_state: 'research_blocked' } }).ok, true);

  const runningRun = createPhase2Run('candidate', { job_id: 'job' });
  assert.equal(phase2TerminalInvariant({ state: { phase2_attempts: [] }, run: runningRun, candidate: { phase2_state: 'researching' } }).ok, false);
});
