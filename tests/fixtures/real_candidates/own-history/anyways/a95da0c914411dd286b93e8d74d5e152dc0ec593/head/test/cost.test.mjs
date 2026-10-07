import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCodexUsage } from '../src/pipeline/cost.mjs';

test('cost accounting applies cached-input and output rates without double-counting reasoning tokens', () => {
  const usage = calculateCodexUsage({
    model: 'gpt-5.6-terra', reasoning: 'high', stage: 'research', attempt: 1, wallMs: 123.4, creditUsd: 0.04,
    usage: { input_tokens: 1_000_000, cached_input_tokens: 100_000, output_tokens: 10_000, reasoning_output_tokens: 4_000 }
  });
  assert.equal(usage.credits, 48.5);
  assert.equal(usage.estimated_cost_usd, 1.94);
  assert.equal(usage.reasoning_output_tokens, 4_000);
  assert.equal(usage.wall_ms, 123);
});

test('Luna High uses its distinct production rate and unknown models remain unpriced', () => {
  assert.equal(calculateCodexUsage({ model: 'gpt-5.6-luna', usage: { input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 1_000_000 } }).credits, 35);
  assert.equal(calculateCodexUsage({ model: 'unapproved-model', usage: { input_tokens: 10, output_tokens: 10 } }).credits, null);
});
