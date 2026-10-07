import assert from 'node:assert/strict';
import test from 'node:test';
import { canRunPipelineV1, isPipelineV1Job, pipelineV1AllowedJobId, pipelineV1Enabled } from '../src/pipeline/feature-flags.mjs';
import { validateLunaEvidenceReferences } from '../src/pipeline/phase2-orchestrator.mjs';
import { validateSolPolish } from '../src/pipeline/sol-polish.mjs';

test('Pipeline V1 is disabled by default and requires both the flag and job version', () => {
  assert.equal(pipelineV1Enabled({}), false);
  assert.equal(pipelineV1Enabled({ PIPELINE_V1_ENABLED: 'false' }), false);
  assert.equal(isPipelineV1Job({}), false);
  assert.equal(canRunPipelineV1({ pipeline_version: 'v1' }, {}), false);
  assert.equal(canRunPipelineV1({ pipeline_version: 'v1' }, { PIPELINE_V1_ENABLED: 'true' }), true);
  assert.equal(canRunPipelineV1({}, { PIPELINE_V1_ENABLED: 'true' }), false);
  assert.equal(pipelineV1AllowedJobId({}), null);
  assert.equal(canRunPipelineV1({ pipeline_version: 'v1' }, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }, 'job-1'), true);
  assert.equal(canRunPipelineV1({ pipeline_version: 'v1' }, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }, 'job-2'), false);
  assert.equal(canRunPipelineV1({ pipeline_version: 'v1', job_id: 'job-1' }, { PIPELINE_V1_ALLOWED_JOB_ID: 'job-1' }), true);
  assert.equal(canRunPipelineV1({ pipeline_version: 'v1' }, { PIPELINE_V1_ENABLED: 'true', PIPELINE_V1_ALLOWED_JOB_ID: 'other' }, 'job-1'), true);
});

test('multi-anchor claim support is allowed when treatment and evidence remain consistent', () => {
  const packet = {
    sources: [{ source_id: 'source-1' }],
    claims: [{ claim_id: 'claim-1', claim: 'The record changed the workflow.', evidence: [{ evidence_id: 'evidence-1', source_id: 'source-1', claim_ids: ['claim-1'] }] }],
    claim_targets: ['claim-1']
  };
  const output = { claim_support: [
    { claim_id: 'claim-1', evidence_ids: ['evidence-1'], article_anchor: 'paragraph-1', treatment: 'paraphrase' },
    { claim_id: 'claim-1', evidence_ids: ['evidence-1'], article_anchor: 'paragraph-3', treatment: 'paraphrase' }
  ] };
  assert.doesNotThrow(() => validateLunaEvidenceReferences(output, packet, { commission: { section_id: 'systems' } }));
});

test('Sol validation preserves article structure, links, quotes, and reader-visible numbers', () => {
  const original = { headline: 'A retained headline', dek: 'A retained dek.', body_markdown: '# A retained headline\n\nThe record says “the system changed” in 2026.\n\nReaders can verify the source at [the record](https://example.com/record).' };
  const polished = { ...original, body_markdown: '# A retained headline\n\nThe record says “the system changed” in 2026.\n\nReaders can check the source at [the record](https://example.com/record).', changes: [{ location: 'paragraph-3', before: 'Readers can verify', after: 'Readers can check', reason: 'clarity' }], warnings: [] };
  assert.equal(validateSolPolish({ original, polished, packet: { sources: [{ title: 'The record', url: 'https://example.com/record' }] } }).claim_support_preserved, true);
  assert.throws(() => validateSolPolish({ original, polished: { ...polished, body_markdown: polished.body_markdown.replace('2026', '2027') }, packet: {} }), /SOL_POLISH_CONTRACT_INVALID/);
});
