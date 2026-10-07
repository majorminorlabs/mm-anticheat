import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SourceFirstSynthesis, isTruncated, normalizeFacts, estimatedJsonCapacity } from '../src/pipeline/synthesis.mjs';

const source = { id: 'source-1', url: 'https://example.test/story', title: 'Story', content: 'A public agency announced a change on 2026-07-28. The change affects residents.' };
function adapter(outputs) { let index = 0; return { model: 'qwen3:14b', async generate({ maxTokens }) { const value = outputs[index++]; return { raw: typeof value === 'string' ? value : JSON.stringify(value), metrics: { eval_count: 100, max_tokens: maxTokens, truncated: false } }; } }; }
test('deterministic fact normalization deduplicates while preserving all source mappings', () => { const result = normalizeFacts([{source_id:'source-1',facts:[{fact_id:'source-1-f1',statement:'Agency announced a change.',support:'The agency announcement says so.',confidence:'high'}],dates:['2026-07-28'],entities:['Agency'],warnings:[]},{source_id:'source-2',facts:[{fact_id:'source-2-f1',statement:'The agency announced a change',support:'A report says so.',confidence:'medium'}],dates:['2026-07-28'],entities:['agency'],warnings:[]}]); assert.equal(result.facts.length, 1); assert.deepEqual(result.facts[0].source_ids, ['source-1','source-2']); });
test('source-first synthesis blocks a selected form that lacks its source floor', async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-synthesis-')); const runner = new SourceFirstSynthesis({artifactDir:dir,adapter:adapter([{source_id:'s1',relevant:true,relevance_score:95,retention_reason:'Primary agency announcement.',facts:[{fact_id:'source-1-f1',statement:'An agency announced a change.',support:'The source states the announcement.',confidence:'high'}],dates:['2026-07-28'],entities:['Agency'],claims:[],warnings:[]},{supported_facts:['source-1-f1'],conflicts:[],uncertainties:[],missing_evidence:[],excluded_claims:[]},{central_question:'What changes for residents?',recommended_angle:'Focus on the practical consequence.',story_form:'meanwhile',sufficiency:'sufficient'}])}); const result = await runner.run({runId:'run',brief:'A change',sources:[source],researchPlan:{central_question:'What changed?'}}); assert.equal(result.status,'failed_closed'); assert.equal(result.blocked_at,'story_form_evidence'); assert.match(result.error, /at least 3 retained sources/); });
test('truncation is detected and bounded allowance has a defined serialized capacity', () => { assert.equal(isTruncated({eval_count:700,max_tokens:700}), true); assert.ok(estimatedJsonCapacity('conflict_analysis') > 4_000); });
test('source extraction fails closed after bounded adaptive recovery', async () => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-synthesis-fail-')); const runner = new SourceFirstSynthesis({artifactDir:dir,adapter:adapter(['{"source_id":"wrong"}', '{"source_id":"wrong"}', '{"source_id":"wrong"}'])}); const result = await runner.run({runId:'run',brief:'A change',sources:[source]}); assert.equal(result.status,'failed_closed'); assert.equal(result.attempts.length,3); });
test('retains usable evidence when one submitted source cannot be extracted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'anyways-synthesis-partial-'));
  const sources = [1,2,3,4].map(index => ({ ...source, id:`source-${index}`, url:`https://example.test/${index}` }));
  const extraction = (id, token) => ({ source_id:token, relevant:true, relevance_score:90, retention_reason:'Relevant reporting.', facts:[{ fact_id:`${id}-f1`, statement:`Fact from ${id}.`, support:'The source supports this fact.', confidence:'high' }], dates:[], entities:[], claims:[], warnings:[] });
  const runner = new SourceFirstSynthesis({ artifactDir:dir, adapter:adapter([
    '{"source_id":"wrong"}', '{"source_id":"wrong"}', '{"source_id":"wrong"}',
    extraction('source-2', 's2'), extraction('source-3', 's3'), extraction('source-4', 's4'),
    { supported_facts:['source-2-f1'], conflicts:[], uncertainties:[], missing_evidence:[], excluded_claims:[] },
    { central_question:'What changed?', recommended_angle:'The meaningful shift.', story_form:'meanwhile', sufficiency:'sufficient' }
  ]) });
  const result = await runner.run({ runId:'run', brief:'A change', sources, researchPlan:{ central_question:'What changed?' }, requestedStoryForm:'meanwhile' });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.output.retained_source_ids, ['source-2','source-3','source-4']);
  assert.equal(result.output.rejected_sources.length, 1);
});
