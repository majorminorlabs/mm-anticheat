import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EditorialPipeline, validateStoryFormLength } from '../src/pipeline/workflow.mjs';

const good = { primary_section: 'systems', recurring_beats: ['ai'], tags: ['data-centers'], reader_consequence: 'Residents can see the tradeoff.', what_this_allows_people_to_become: 'informed participants', fit_score: 86, decision: 'proceed', reasoning: 'It reveals power and access.', uncertainty: '' };
const input = { brief: 'A county approved a data center after a water disclosure rule.', sources: [{ id: 's1', title: 'County filing', url: 'https://example.test/filing', content: 'The county approved the project and requires monthly water disclosure.' }] };

test('pipeline persists raw output and passes a valid strict stage', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-pipeline-'));
  const adapter = { model: 'qwen3:14b', async generate() { return { raw: JSON.stringify(good), metrics: {} }; } };
  const result = await new EditorialPipeline({ adapter, artifactDir: dir }).run({ ...input, stages: ['classification'], runId: 'valid' });
  assert.equal(result.status, 'complete');
  assert.equal(result.image_review.status, 'human_review_required');
  const artifact = JSON.parse(await fs.readFile(path.join(dir, 'valid', 'classification.attempt-1.json')));
  assert.equal(artifact.raw_response, JSON.stringify(good));
});

test('pipeline retries once then fails closed with retained validation errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-pipeline-'));
  let calls = 0; const adapter = { model: 'qwen3:14b', async generate() { calls++; return { raw: '{}', metrics: {} }; } };
  const result = await new EditorialPipeline({ adapter, artifactDir: dir }).run({ ...input, stages: ['classification'], runId: 'invalid' });
  assert.equal(calls, 2); assert.equal(result.status, 'blocked'); assert.equal(result.stages.classification.status, 'failed_closed');
  const artifact = JSON.parse(await fs.readFile(path.join(dir, 'invalid', 'classification.attempt-2.json')));
  assert.ok(artifact.validation_errors.length);
});

test('synthesis cannot advance without source mappings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-pipeline-'));
  const invalid = { supported_facts: ['A'], uncertain_facts: [], conflicting_claims: [], timeline: [], claim_to_source: [], missing_evidence: [], exclude_from_article: [], suggested_angle: 'A' };
  const adapter = { model: 'qwen3:14b', async generate() { return { raw: JSON.stringify(invalid), metrics: {} }; } };
  const result = await new EditorialPipeline({ adapter, artifactDir: dir }).run({ ...input, stages: ['synthesis'], runId: 'mappings' });
  assert.equal(result.status, 'blocked'); assert.match(result.stages.synthesis.attempts[1].validation_errors.join(' '), /source mappings/);
});

test('verification cannot advance without source-backed supported claims', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-pipeline-'));
  const invalid = { claims: [{ claim: 'A', status: 'unsupported', source_ids: [], note: 'No source.' }], can_advance: true };
  const adapter = { model: 'qwen3:14b', async generate() { return { raw: JSON.stringify(invalid), metrics: {} }; } };
  const result = await new EditorialPipeline({ adapter, artifactDir: dir }).run({ ...input, stages: ['verification'], runId: 'verification' });
  assert.equal(result.status, 'blocked'); assert.match(result.stages.verification.attempts[1].validation_errors.join(' '), /cannot advance/);
});

test('draft and final style pass enforce the selected story-form range', () => {
  const prior = { synthesis: { output: { story_form: 'meanwhile' } } };
  assert.deepEqual(validateStoryFormLength('short', prior), ['body must be 250-500 words for Meanwhile...; received 1']);
  assert.deepEqual(validateStoryFormLength(Array(251).fill('reported').join(' '), prior), []);
});

test('slop stage uses bounded recovery and preserves complete body only', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-pipeline-'));
  const finalBody = Array(250).fill('reported').join(' '); let calls = 0; const adapter = { model: 'qwen3:14b', async generate() { calls++; return calls === 1 ? { raw: '{"revised_body":"partial', metrics: { truncated: true } } : { raw: JSON.stringify({ revised_body: finalBody, changes: [], warnings: [] }), metrics: { truncated: false } }; } };
  const result = await new EditorialPipeline({ adapter, artifactDir: dir }).run({ ...input, stages: ['slop'], initialStages: { synthesis: { status: 'passed', output: { story_form: 'meanwhile' } }, draft: { status: 'passed', output: { headline: 'H', dek: 'D', body_markdown: finalBody } }, proofreading: { status: 'passed', output: { issues: [], minimal_edit: '' } } }, runId: 'slop-recovery' });
  assert.equal(result.status, 'complete'); assert.equal(calls, 2); assert.equal(result.stages.slop.output.revised_body, finalBody); assert.ok(result.stages.slop.attempts[0].validation_errors.includes('SLOP_OUTPUT_TRUNCATED'));
});

test('slop stage fails closed after invalid JSON and never accepts partial article text', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-pipeline-'));
  const adapter = { model: 'qwen3:14b', async generate() { return { raw: '{"revised_body":"partial', metrics: { truncated: true } }; } };
  const result = await new EditorialPipeline({ adapter, artifactDir: dir }).run({ ...input, stages: ['slop'], initialStages: { synthesis: { status: 'passed', output: { story_form: 'meanwhile' } }, draft: { status: 'passed', output: { headline: 'H', dek: 'D', body_markdown: Array(250).fill('reported').join(' ') } }, proofreading: { status: 'passed', output: { issues: [], minimal_edit: '' } } }, runId: 'slop-fail' });
  assert.equal(result.status, 'blocked'); assert.equal(result.stages.slop.attempts.length, 3); assert.ok(result.stages.slop.attempts.every(attempt => attempt.validation_errors.includes('SLOP_OUTPUT_INVALID_JSON')));
});
