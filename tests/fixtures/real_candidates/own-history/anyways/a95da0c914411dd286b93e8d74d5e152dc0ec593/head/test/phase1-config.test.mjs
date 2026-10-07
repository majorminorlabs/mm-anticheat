import assert from 'node:assert/strict';
import test from 'node:test';
import { PIPELINE_CONFIG, PRODUCTION_MODELS } from '../src/pipeline/config.mjs';

test('the frozen production discovery route uses the approved pitch model', () => {
  assert.equal(PIPELINE_CONFIG.pitchModel, 'gpt-5.6-luna');
  assert.equal(PIPELINE_CONFIG.pitchReasoningEffort, 'high');
});

test('production V1 exposes the approved discovery, Terra, Luna, and manual Sol assignments', () => {
  assert.deepEqual(PRODUCTION_MODELS.discovery, { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'high', roles: ['discovery', 'pitch'] });
  assert.deepEqual(PRODUCTION_MODELS.research, { provider: 'codex', model: 'gpt-5.6-terra', reasoning: 'high', roles: ['research', 'evidence_selection'] });
  assert.deepEqual(PRODUCTION_MODELS.draft, { provider: 'codex', model: 'gpt-5.6-luna', reasoning: 'high', roles: ['article_draft'] });
  assert.deepEqual(PRODUCTION_MODELS.polish, { provider: 'codex', model: 'gpt-5.6-sol', reasoning: 'medium', roles: ['manual_copy_polish'] });
});
