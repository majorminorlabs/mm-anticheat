import assert from 'node:assert/strict';
import test from 'node:test';
import { assertPhase1Schema, validatePhase1Schema } from '../src/pipeline/phase1-schemas.mjs';

const claim = { claim_id: 'run-1-claim-1', claim: 'The record contains 42 entries.', source_ids: ['source-1'], evidence: [{ source_id: 'source-1', excerpt: 'The record contains 42 entries.' }], confidence: 'high' };
const terraClaim = { claim_id: 'run-1-claim-1', claim: 'The record contains 42 entries.', source_ids: ['source-1'], evidence: [{ source_id: 'source-1', start_offset: 0, end_offset: 31, claim_ids: ['run-1-claim-1'], evidence_role: 'must_use', reason: 'Supports the record count.' }], confidence: 'high' };
const usage = { provider: 'codex', model: 'gpt-5.6-terra', reasoning: 'high', stage: 'research', attempt: 1, input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, reasoning_output_tokens: 1, credits: 0.4, estimated_cost_usd: 0.01, wall_ms: 100 };

test('Production v1 schemas accept the research, draft, revision, evidence, and usage contracts', () => {
  assert.doesNotThrow(() => assertPhase1Schema('claim_to_source_evidence', claim));
  assert.doesNotThrow(() => assertPhase1Schema('research_blocker', { blocker_id: 'blocker-1', question: 'What changed?', reason: 'The official record is absent.', required_action: 'Obtain the record.', source_ids: ['source-1'] }));
  assert.doesNotThrow(() => assertPhase1Schema('terra_research_evidence', {
    research_questions: [{ question_id: 'question-1', question: 'What changed?', answerable: true }],
    selected_source_ids: ['source-1'], optional_source_ids: [], excluded_sources: [], claims: [terraClaim], contradictions: [], freshness_risks: [], missing_evidence: [], blockers: [], draft_constraints: ['Stay within the retained source.'], ready_to_draft: true
  }));
  const claimSupport = [{ claim_id: 'run-1-claim-1', evidence_ids: ['evidence-001'], article_anchor: 'paragraph-1', treatment: 'paraphrase' }];
  assert.doesNotThrow(() => assertPhase1Schema('luna_draft', { headline: 'Headline', dek: 'Dek', body_markdown: 'Body', claim_support: claimSupport, warnings: [] }));
  assert.doesNotThrow(() => assertPhase1Schema('luna_revision', { headline: 'Headline', dek: 'Dek', body_markdown: 'Revised body', claim_support: claimSupport, warnings: [], changed_claim_ids: ['run-1-claim-1'], revision_notes: ['Tightened the qualification.'] }));
  assert.doesNotThrow(() => assertPhase1Schema('model_usage', usage));
});

test('schemas reject missing evidence, unexpected properties, and invalid usage', () => {
  const missingEvidence = { ...claim, evidence: [] };
  assert.ok(validatePhase1Schema('claim_to_source_evidence', missingEvidence).some(error => /evidence.*at least 1/.test(error)));
  assert.ok(validatePhase1Schema('luna_draft', { headline: 'H', dek: 'D', body_markdown: 'B', claim_support: [], warnings: [], extra: true }).some(error => /extra is not allowed/.test(error)));
  assert.ok(validatePhase1Schema('model_usage', { ...usage, attempt: 0 }).some(error => /attempt/.test(error)));
  assert.throws(() => assertPhase1Schema('luna_revision', { headline: 'H', dek: 'D', body_markdown: 'draft', claim_support: [{ claim_id: 'c', evidence_ids: ['e'], article_anchor: 'p1', treatment: 'paraphrase' }], warnings: [], changed_claim_ids: [], revision_notes: [], unexpected: 'nope' }), error => error.code === 'PHASE1_SCHEMA_INVALID');
});

test('Terra blockers accept the observed string form and keep blocked and ready states distinct', () => {
  const base = {
    research_questions: [{ question_id: 'question-1', question: 'What changed?', answerable: true }],
    selected_source_ids: ['source-1'], optional_source_ids: [], excluded_sources: [], claims: [terraClaim], required_facts: [], prohibited_claims: [],
    ledgers: { quotations: [], proper_names: [], numbers: [] }, claim_targets: ['run-1-claim-1'], unresolved_research_questions: [], contradictions: [], freshness_risks: [], missing_evidence: [], draft_constraints: ['Stay within the retained source.']
  };
  const blocked = { ...base, blockers: [{ blocker_id: 'blocker-1', question: 'What changed?', reason: 'The official record is absent.', required_action: 'Obtain the official record.', source_ids: ['source-1'] }], ready_to_draft: false };
  assert.doesNotThrow(() => assertPhase1Schema('terra_research_evidence', blocked));
  assert.doesNotThrow(() => assertPhase1Schema('terra_research_evidence', { ...base, blockers: [], ready_to_draft: true }));
  assert.deepEqual(validatePhase1Schema('terra_research_evidence', { ...base, blockers: ['The official record is absent.'], ready_to_draft: false }), []);
  assert.ok(validatePhase1Schema('terra_research_evidence', { ...base, blockers: [], ready_to_draft: false }).length === 0);
});
