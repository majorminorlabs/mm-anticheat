import assert from 'node:assert/strict';
import test from 'node:test';
import { beginStage, completeStage, createPhase2Run, ensurePhase2State, failStage, markProviderCallStarted, phase2TerminalInvariant } from '../src/pipeline/phase2-state.mjs';

function fixture() {
  const state = { phase2_runs: [], phase2_attempts: [], phase2_artifacts: [], phase2_reviews: [], phase2_persistence: [] };
  const run = createPhase2Run('candidate', { job_id: 'job' });
  ensurePhase2State(state);
  state.phase2_runs.push(run);
  return { state, run };
}

function finish(run, status = 'complete') {
  run.status = status;
  run.finished_at = new Date().toISOString();
}

test('research none keeps deterministic stage attempts separate from one Luna provider call', () => {
  const { state, run } = fixture();
  beginStage(state, run, 'research');
  completeStage(state, run, 'research', { deterministic: true });
  beginStage(state, run, 'draft');
  markProviderCallStarted(state, run, 'draft', { model: 'gpt-5.6-luna' });
  completeStage(state, run, 'draft', { headline: 'Draft' });
  finish(run);
  assert.equal(run.provider_call_count, 1);
  assert.equal(run.provider_calls.length, 1);
  assert.equal(phase2TerminalInvariant({ state, run }).ok, true);
});

test('research required records Terra and Luna calls independently', () => {
  const { state, run } = fixture();
  beginStage(state, run, 'research');
  markProviderCallStarted(state, run, 'research', { model: 'gpt-5.6-terra' });
  completeStage(state, run, 'research', { ready_to_draft: true });
  beginStage(state, run, 'draft');
  markProviderCallStarted(state, run, 'draft', { model: 'gpt-5.6-luna' });
  completeStage(state, run, 'draft', { headline: 'Draft' });
  finish(run);
  assert.deepEqual(run.provider_calls.map(call => call.stage), ['research', 'draft']);
  assert.equal(run.provider_call_count, 2);
  assert.equal(phase2TerminalInvariant({ state, run }).ok, true);
});

test('failed provider preflight records zero calls even when the Draft stage attempt exists', () => {
  const { state, run } = fixture();
  beginStage(state, run, 'research');
  completeStage(state, run, 'research', { deterministic: true });
  beginStage(state, run, 'draft');
  const error = Object.assign(new Error('Codex version check failed.'), { code: 'CODEX_VERSION_CHECK_FAILED' });
  failStage(state, run, 'draft', error);
  finish(run, 'failed');
  assert.equal(run.provider_call_count, 0);
  assert.equal(run.provider_calls.length, 0);
  assert.equal(phase2TerminalInvariant({ state, run }).ok, true);
});

test('a started provider call remains counted when output validation fails', () => {
  const { state, run } = fixture();
  beginStage(state, run, 'draft');
  markProviderCallStarted(state, run, 'draft', { model: 'gpt-5.6-luna' });
  failStage(state, run, 'draft', Object.assign(new Error('invalid output'), { code: 'PHASE2_SCHEMA_INVALID' }));
  finish(run, 'failed');
  assert.equal(run.provider_call_count, 1);
  assert.equal(state.phase2_attempts[0].provider_call_started, true);
  assert.equal(phase2TerminalInvariant({ state, run }).ok, true);
});

test('duplicate provider call notification fails closed without resetting the first call', () => {
  const { state, run } = fixture();
  beginStage(state, run, 'draft');
  markProviderCallStarted(state, run, 'draft', { model: 'gpt-5.6-luna' });
  assert.throws(() => markProviderCallStarted(state, run, 'draft', { model: 'gpt-5.6-luna' }), error => error.code === 'PHASE2_DUPLICATE_PROVIDER_CALL');
  assert.equal(run.provider_call_count, 1);
  assert.equal(run.provider_calls.length, 1);
});
