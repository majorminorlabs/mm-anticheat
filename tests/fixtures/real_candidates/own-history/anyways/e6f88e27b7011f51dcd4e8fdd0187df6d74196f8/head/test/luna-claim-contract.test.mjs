import assert from 'node:assert/strict';
import test from 'node:test';
import { validateLunaEvidenceReferences } from '../src/pipeline/phase2-orchestrator.mjs';
import { lunaDraftPrompt } from '../src/pipeline/phase2-prompts.mjs';
import { validatePhase1Schema } from '../src/pipeline/phase1-schemas.mjs';

const packet = {
  sources: [{ source_id: 'source-001', text: 'A retained fact.', url: 'https://example.com/fact' }],
  claims: [{
    claim_id: 'claim-retained-002',
    claim: 'The retained fact is true.',
    source_ids: ['source-001'],
    evidence: [
      { evidence_id: 'evidence-002', source_id: 'source-001', excerpt: 'A retained fact.', claim_ids: ['claim-retained-002'] },
      { evidence_id: 'evidence-003', source_id: 'source-001', excerpt: 'A second retained fact.', claim_ids: ['claim-retained-002'] }
    ]
  }],
  claim_targets: ['claim-retained-002'],
  required_facts: [],
  prohibited_claims: [],
  ledgers: { quotations: [], proper_names: [], numbers: [] },
  draft_constraints: ['Stay within the retained evidence.'],
  version: 'pipeline-v1-evidence-packet-offsets-v1',
  frozen_evidence_packet_sha256: 'packet-checksum'
};

const candidate = { title: 'A retained story', commission: { section_id: 'internet', story_form: 'meanwhile' }, classification: { primary_section: 'internet', editorial_pitch: { accepted: true, lens: 'The retained fact matters.' } } };
const mapping = (overrides = {}) => ({ claim_id: 'claim-retained-002', evidence_ids: ['evidence-002'], article_anchor: 'paragraph-1', treatment: 'paraphrase', ...overrides });

test('same claim at multiple anchors with the same treatment passes', () => {
  const output = { claim_support: [mapping(), mapping({ article_anchor: 'paragraph-2', evidence_ids: ['evidence-003'] })] };
  assert.doesNotThrow(() => validateLunaEvidenceReferences(output, packet, candidate));
});

test('same claim at multiple anchors with different treatments fails', () => {
  const output = { claim_support: [mapping(), mapping({ article_anchor: 'paragraph-2', treatment: 'context' })] };
  assert.throws(() => validateLunaEvidenceReferences(output, packet, candidate), /contradictory treatment/);
});

test('unknown treatment fails schema validation', () => {
  const errors = validatePhase1Schema('luna_draft', { headline: 'H', dek: 'D', body_markdown: 'B', claim_support: [mapping({ treatment: 'attributed_claim' })], warnings: [] });
  assert.ok(errors.some(error => /treatment.*not permitted/.test(error)));
});

test('duplicate identical mapping fails', () => {
  const output = { claim_support: [mapping(), mapping()] };
  assert.throws(() => validateLunaEvidenceReferences(output, packet, candidate), /repeated an identical claim-support mapping/);
});

test('allowed evidence subsets pass and unknown evidence fails', () => {
  assert.doesNotThrow(() => validateLunaEvidenceReferences({ claim_support: [mapping({ evidence_ids: ['evidence-003'] })] }, packet, candidate));
  assert.throws(() => validateLunaEvidenceReferences({ claim_support: [mapping({ evidence_ids: ['evidence-unknown'] })] }, packet, candidate), /unknown evidence ID/);
});

test('prompt treatment contract matches the validator', () => {
  const prompt = lunaDraftPrompt({ candidate, packet });
  assert.match(prompt, /exactly \["paraphrase","direct_quote","context"\]/);
  assert.match(prompt, /required_treatment/);
  assert.match(prompt, /VALID MULTI-ANCHOR MAPPING EXAMPLE/);
  assert.match(prompt, /INVALID CONTRADICTORY-TREATMENT EXAMPLE/);
  assert.doesNotMatch(prompt, /attributed_claim/);
});
