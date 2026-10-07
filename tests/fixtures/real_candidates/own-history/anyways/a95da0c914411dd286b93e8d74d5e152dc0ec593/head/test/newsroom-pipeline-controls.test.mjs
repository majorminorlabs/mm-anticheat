import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePipelineAction, pipelineReviewHref, validateNewsroomJobRequest } from '../src/newsroom-pipeline-controls.mjs';

test('validates only Newsroom-supported job requests', () => {
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'discover', priority: 50 }), { job_type: 'discover', parameters: {}, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'run_editorial_batch' }), { job_type: 'run_editorial_batch', parameters: { section_id: null, story_form: null, target_count: 10 }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'run_editorial_batch', section_id: 'systems', story_form: 'receipts', target_count: 3 }), { job_type: 'run_editorial_batch', parameters: { section_id: 'systems', story_form: 'receipts', target_count: 3 }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64) }), { job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64) }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'create_editorial_pitch', brief: 'Explain why restaurant reservations have become a job people outsource.', section_id: 'modern-life', story_form: 'meanwhile', beats: 'food, luxury', tags: 'reservation culture', source_urls: 'https://example.com/report', notes: 'Follow the behavior, not the app.' }), { job_type: 'create_editorial_pitch', parameters: { brief: 'Explain why restaurant reservations have become a job people outsource.', section_id: 'modern-life', story_form: 'meanwhile', beats: ['food', 'luxury'], tags: ['reservation-culture'], source_urls: ['https://example.com/report'], notes: 'Follow the behavior, not the app.' }, priority: 50 });
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'commission_article', brief: 'Bypass discovery and write this article.' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'sync_candidate' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'nope' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'create_editorial_pitch', brief: 'Too short', section_id: 'internet', story_form: 'meanwhile', source_urls: 'https://example.com' }));
});

test('candidate actions prefer active jobs, then the existing review route', () => {
  const candidate = { id: 'db-id', external_id: 'a'.repeat(64), status: 'discovered' };
  assert.equal(candidatePipelineAction(candidate, [{ id: 'job', status: 'running', parameters: { candidate_id: 'a'.repeat(64) } }]).type, 'active');
  assert.deepEqual(candidatePipelineAction({ ...candidate, status: 'ready_for_review' }), { type: 'review', label: 'Open review', href: `/newsroom/review/${'a'.repeat(64)}` });
  assert.equal(pipelineReviewHref({ ...candidate, status: 'ready_for_review' }), `/newsroom/review/${'a'.repeat(64)}`);
  assert.equal(candidatePipelineAction({ ...candidate, status: 'ready_for_review' }, [], { story_id: 'story' }).type, 'story_linked');
  assert.equal(candidatePipelineAction(candidate), null);
  assert.equal(candidatePipelineAction({ ...candidate, status: 'rejected' }), null);
  assert.equal(candidatePipelineAction({ ...candidate, status: 'pitch_ready', classification: { editorial_pitch: { accepted: true } } }).label, 'Commission reporting');
});
