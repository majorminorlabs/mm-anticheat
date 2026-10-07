import test from 'node:test';
import assert from 'node:assert/strict';
import { canRetryNewsroomPipelineJob, candidatePipelineAction, isPipelineV1Job, pipelineReviewHref, researchAgainDetails, researchAgainRequest, validateNewsroomJobRequest } from '../src/newsroom-pipeline-controls.mjs';
import { distinctSourceCount, discoveryEnrichmentRetryable, editorReadyPitch, normalizeEditorialRejectionReason, pitchInboxStatus, pitchRecord } from '../src/pipeline/discovery-pitch.mjs';

test('validates only Newsroom-supported job requests', () => {
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'discover', priority: 50 }), { job_type: 'discover', parameters: { focus_id: 'all' }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'run_editorial_batch' }), { job_type: 'run_editorial_batch', parameters: { focus_id: 'all', section_id: null, story_form: null, target_count: 10 }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'run_editorial_batch', focus_id: 'chains', section_id: 'products', story_form: 'receipts', target_count: 3 }), { job_type: 'run_editorial_batch', parameters: { focus_id: 'chains', section_id: 'products', story_form: 'receipts', target_count: 3 }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'generate_idea_pitches', prompt: 'Something interesting about RWAs.' }), { job_type: 'generate_idea_pitches', parameters: { prompt: 'Something interesting about RWAs.' }, priority: 50 });
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'generate_idea_pitches', prompt: 'Too short' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'run_editorial_batch', focus_id: 'unknown' }));
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64) }), { job_type: 'process_candidate', parameters: { candidate_id: 'a'.repeat(64) }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'enrich_discovery_candidate', candidate_id: 'a'.repeat(64) }), { job_type: 'enrich_discovery_candidate', parameters: { candidate_id: 'a'.repeat(64) }, priority: 50 });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'sol-medium', length: 'feature' }).parameters, { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'sol-medium', length: 'feature', writer_model: 'gpt-5.6-sol', writer_reasoning: 'medium' });
  assert.deepEqual(validateNewsroomJobRequest({ job_type: 'create_editorial_pitch', brief: 'Explain why wallets have become a new kind of public identity.', section_id: 'products', story_form: 'meanwhile', beats: 'wallets, infrastructure', tags: 'wallet identity', source_urls: 'https://example.com/report', notes: 'Follow the behavior, not the app.' }), { job_type: 'create_editorial_pitch', parameters: { brief: 'Explain why wallets have become a new kind of public identity.', section_id: 'products', story_form: 'meanwhile', beats: ['wallets', 'infrastructure'], tags: ['wallet-identity'], source_urls: ['https://example.com/report'], notes: 'Follow the behavior, not the app.' }, priority: 50 });
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'commission_article', brief: 'Bypass discovery and write this article.' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'sync_candidate' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'nope' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'old-default', length: 'standard' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'luna-high', length: 'old-default' }));
  assert.throws(() => validateNewsroomJobRequest({ job_type: 'create_editorial_pitch', brief: 'Too short', section_id: 'internet', story_form: 'meanwhile', source_urls: 'https://example.com' }));
});

test('discovery pitch records are only commissionable after canonical enrichment fields persist', () => {
  const raw = { id: 'raw', external_id: 'a'.repeat(64), title: 'Raw lead', status: 'discovered', canonical_url: 'https://news.test/raw', classification: { discovery_enrichment: { status: 'processing' } } };
  const processing = pitchRecord(raw);
  assert.equal(pitchInboxStatus(raw, processing), 'processing');
  assert.equal(editorReadyPitch(processing), false);

  const enriched = {
    ...raw,
    status: 'pitch_ready',
    classification: {
      discovery_enrichment: { status: 'succeeded' },
      primary_section: 'products',
      story_form: 'receipts',
      recurring_beats: ['infrastructure'],
      editorial_pitch: {
        accepted: true,
        headline: 'A retained headline',
        reader_takeaway: 'A concise pitch editors can assign.',
        why_now: 'The timing changes what readers need to know.',
        primary_section: 'products',
        story_form: 'receipts',
        beats: ['infrastructure']
      }
    }
  };
  const ready = pitchRecord(enriched);
  assert.equal(ready.pitch, 'A concise pitch editors can assign.');
  assert.equal(ready.why, 'The timing changes what readers need to know.');
  assert.equal(ready.lens, 'products');
  assert.equal(ready.section, 'receipts');
  assert.equal(ready.sourceCount, 1);
  assert.equal(pitchInboxStatus(enriched, ready), 'pitch');
  assert.equal(editorReadyPitch(ready), true);
});

test('queued discovery candidates stay out of the editorial pitch inbox until screening starts', () => {
  const queued = { status: 'discovered', title: 'Raw lead', classification: { discovery_enrichment: { status: 'queued' } } };
  assert.equal(pitchInboxStatus(queued, pitchRecord(queued)), null);
});

test('legacy raw discovery records stay blocked and expose a retry state', () => {
  const legacy = { status: 'discovered', title: 'Legacy lead', classification: {} };
  const pitch = pitchRecord(legacy);
  assert.equal(pitchInboxStatus(legacy, pitch), 'needs_attention');
  assert.equal(editorReadyPitch(pitch), false);
});

test('editorial rejections read as Passed while technical failures stay actionable', () => {
  const rejected = { status: 'rejected', title: 'A passed lead', classification: { discovery_enrichment: { status: 'rejected', reason: 'The lead does not establish a broader shift.' } } };
  const rejectedPitch = pitchRecord(rejected, 1);
  assert.equal(pitchInboxStatus(rejected, rejectedPitch), 'passed');
  assert.doesNotMatch(normalizeEditorialRejectionReason(rejected.classification.discovery_enrichment.reason), /does not establish/);
  const failed = { status: 'discovered', title: 'A failed lead', classification: { discovery_enrichment: { status: 'failed', reason: 'Pitch gate timed out.' } } };
  assert.equal(pitchInboxStatus(failed, pitchRecord(failed)), 'needs_attention');
});

test('source references are deduplicated and thin sensitive pitches warn without blocking commission', () => {
  const candidate = { canonical_url: 'https://news.test/lead' };
  const sources = [
    { id: 'one', canonical_url: 'https://news.test/lead?utm_source=x' },
    { id: 'mirror', url: 'https://news.test/lead#top' }
  ];
  assert.equal(distinctSourceCount(candidate, sources), 1);
  const pitch = pitchRecord({
    status: 'pitch_ready',
    canonical_url: candidate.canonical_url,
    classification: {
      discovery_enrichment: { status: 'succeeded' },
      editorial_pitch: { accepted: true, headline: 'A protocol change alters who can transact', reader_takeaway: 'Readers can see the new transaction constraint.', why_now: 'A new protocol rule changed the practical rules this week.', primary_section: 'markets', story_form: 'receipts', beats: ['digital art'], research_requirement: 'required' }
    }
  }, 1);
  assert.equal(pitch.beats[0], 'digital-art');
  assert.equal(pitch.warnings.length, 1);
  assert.equal(editorReadyPitch(pitch), true);
});

test('unknown persisted taxonomy never becomes a valid commissionable pitch', () => {
  const candidate = { status: 'pitch_ready', classification: { discovery_enrichment: { status: 'succeeded' }, editorial_pitch: { accepted: true, headline: 'A pitch', reader_takeaway: 'A real takeaway.', why_now: 'A timely change matters now.', primary_section: 'markets', story_form: 'meanwhile', beats: ['press-freedom'] } } };
  const pitch = pitchRecord(candidate, 1);
  assert.equal(editorReadyPitch(pitch), false);
  assert.equal(pitchInboxStatus(candidate, pitch), 'needs_attention');
});

test('legacy accepted records without retained beats stay blocked', () => {
  const candidate = { status: 'pitch_ready', classification: { primary_section: 'products', story_form: 'meanwhile', editorial_pitch: { accepted: true, headline: 'A retained pitch', reader_takeaway: 'A retained takeaway.', why_now: 'A timely change needs context.', primary_section: 'products', story_form: 'meanwhile' } } };
  const pitch = pitchRecord(candidate, 1);
  assert.equal(editorReadyPitch(pitch), false);
  assert.equal(pitchInboxStatus(candidate, pitch), 'needs_attention');
});

test('enriched pitches retain recurring beats when the nested pitch omits them', () => {
  const candidate = {
    status: 'pitch_ready',
    classification: {
      recurring_beats: ['infrastructure', 'wallets'],
      discovery_enrichment: { status: 'succeeded' },
      editorial_pitch: {
        accepted: true,
        headline: 'A defensible products pitch',
        reader_takeaway: 'A useful reader takeaway.',
        why_now: 'A timely reason to pay attention.',
        primary_section: 'products',
        story_form: 'worth-your-time'
      }
    }
  };
  const pitch = pitchRecord(candidate, 1);
  assert.deepEqual(pitch.beats, ['infrastructure', 'wallets']);
  assert.equal(editorReadyPitch(pitch), true);
  assert.equal(pitchInboxStatus(candidate, pitch), 'pitch');
  assert.equal(discoveryEnrichmentRetryable(candidate), false);
});

test('enrichment retry is limited to missing or failed discovery enrichment', () => {
  assert.equal(discoveryEnrichmentRetryable({ status: 'discovered', classification: {} }), true);
  assert.equal(discoveryEnrichmentRetryable({ status: 'discovered', classification: { discovery_enrichment: { status: 'failed' } } }), true);
  assert.equal(discoveryEnrichmentRetryable({ status: 'pitch_ready', classification: { discovery_enrichment: { status: 'succeeded' } } }), false);
  assert.equal(discoveryEnrichmentRetryable({ status: 'rejected', classification: { discovery_enrichment: { status: 'rejected' } } }), false);
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

test('Research Again is limited to explicit research blockers and preserves assignment', () => {
  const candidate = {
    id: 'db-id',
    external_id: 'a'.repeat(64),
    status: 'research_blocked',
    classification: {
      editorial_assignment: { writer: 'sol-low', length: 'standard' }
    }
  };
  const blockedJob = {
    id: 'prior-job',
    job_type: 'process_candidate',
    status: 'failed',
    parameters: { candidate_id: candidate.external_id, pipeline_version: 'v1', writer: 'sol-low', length: 'standard' },
    result: { result: { research_again_required: true, blockers: [{ reason: 'The official record is incomplete.' }] } }
  };
  const details = researchAgainDetails(candidate, blockedJob);
  assert.deepEqual(details, {
    required: true,
    active: false,
    reason: 'The official record is incomplete.',
    writer: 'sol-low',
    length: 'standard',
    assignmentComplete: true,
    priorAttemptId: 'prior-job'
  });
  assert.deepEqual(researchAgainRequest(candidate), {
    job_type: 'process_candidate',
    candidate_id: candidate.external_id,
    pipeline_version: 'v1',
    authorization: 'research_again',
    research_requirement: 'required',
    writer: 'sol-low',
    length: 'standard'
  });
  assert.equal(researchAgainRequest({ id: 'db-id', classification: candidate.classification }, { parameters: { candidate_id: candidate.external_id } }).candidate_id, candidate.external_id);
  assert.equal(researchAgainDetails({ ...candidate, status: 'verification_failed' }, { ...blockedJob, result: { result: { research_again_required: false } } }).required, false);
});

test('Research Again detects an active duplicate and keeps the action disabled state deterministic', () => {
  const candidate = { id: 'db-id', external_id: 'b'.repeat(64), status: 'research_blocked', classification: { editorial_assignment: { writer: 'luna-high', length: 'feature' } } };
  const job = { id: 'retry-job', job_type: 'process_candidate', status: 'running', parameters: { pipeline_version: 'pipeline-v1', authorization: 'research_again', writer: 'luna-high', length: 'feature' } };
  const details = researchAgainDetails(candidate, job);
  assert.equal(details.active, true);
  assert.equal(details.required, true);
  assert.equal(details.writer, 'luna-high');
  assert.equal(details.length, 'feature');
});

test('generic retry is hidden for failed Pipeline V1 jobs', () => {
  const v1 = { job_type: 'process_candidate', status: 'failed', parameters: { pipeline_version: 'v1' } };
  const legacy = { job_type: 'process_candidate', status: 'failed', parameters: {} };
  assert.equal(isPipelineV1Job(v1), true);
  assert.equal(canRetryNewsroomPipelineJob(v1), false);
  assert.equal(canRetryNewsroomPipelineJob(legacy), true);
  assert.equal(canRetryNewsroomPipelineJob({ job_type: 'discover', status: 'failed', parameters: {} }), true);
});
