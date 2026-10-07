import test from 'node:test';
import assert from 'node:assert/strict';
import { candidatePipelineAction, pipelineReviewHref, validateNewsroomJobRequest } from '../src/newsroom-pipeline-controls.mjs';

test('validates only Newsroom-supported job requests', () => {
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'discover', priority: 50 }), { job_type: 'discover', parameters: {}, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64) }), { job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64) }, priority: 50 });
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'sync_candidate' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'nope' }));
});

test('candidate actions prefer active jobs, then the existing review route', () => {
  const candidate = { id: 'db-id', external_id: 'a'.repeat(64), status: 'discovered' };
  assert.equal(candidatePipelineAction(candidate, [{ id: 'job', status: 'running', parameters: { candidate_id: 'a'.repeat(64) } }]).type, 'active');
  assert.deepEqual(candidatePipelineAction({ ...candidate, status: 'ready_for_review' }), { type: 'review', label: 'Open review', href: `/newsroom/review/${'a'.repeat(64)}` });
  assert.equal(pipelineReviewHref({ ...candidate, status: 'ready_for_review' }), `/newsroom/review/${'a'.repeat(64)}`);
  assert.equal(candidatePipelineAction({ ...candidate, status: 'ready_for_review' }, [], { story_id: 'story' }).type, 'story_linked');
});
