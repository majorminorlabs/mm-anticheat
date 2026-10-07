import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { beginStage, createPhase2Run, recordStageResponse } from '../src/pipeline/phase2-state.mjs';
import { phase2CostRecord, phase2PersistencePayload } from '../src/pipeline/phase2-persistence.mjs';

test('unavailable USD remains null while credits remain recorded', () => {
  const run = createPhase2Run('telemetry-candidate');
  const state = { phase2_attempts: [], phase2_runs: [], phase2_artifacts: [], phase2_reviews: [] };
  beginStage(state, run, 'draft');
  recordStageResponse(state, run, 'draft', {
    response: { raw: '{}', metrics: {} },
    usage: { stage: 'draft', attempt: 1, credits: 0.10627, estimated_cost_usd: null, input_tokens: 1, output_tokens: 1 }
  });
  assert.equal(run.model_usage[0].credits, 0.10627);
  assert.equal(run.estimated_cost_usd, null);
});

test('review observability reads credits from usage and never falls back to numeric zero USD', async () => {
  const app = await readFile(new URL('../src/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /const phase2Credits = phase2Usage/);
  assert.match(app, /const phase2UsdEstimate = phase2Cost && typeof phase2Cost === 'object'/);
  assert.doesNotMatch(app, /phase2Cost\?\.credits/);
  assert.doesNotMatch(app, /phase2Cost\?\.estimated_cost_usd \?\? phase2Cost/);
});

test('Phase 2 persistence stores credits with a null USD estimate', () => {
  const usage = [{ credits: 0.10627, estimated_cost_usd: null }];
  assert.deepEqual(phase2CostRecord({ usage, cost: null }), { credits: 0.10627, estimated_cost_usd: null });
  assert.deepEqual(phase2PersistencePayload({ run: { id: 'run-1', candidate_id: 'candidate-1' }, stage: 'ai_review', usage, cost: null }).cost, { credits: 0.10627, estimated_cost_usd: null });
});
