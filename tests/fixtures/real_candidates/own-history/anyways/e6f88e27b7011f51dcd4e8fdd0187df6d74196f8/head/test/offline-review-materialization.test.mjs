import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeOfflineReview } from '../src/pipeline/offline-review-materialization.mjs';

const candidate = { id: 'candidate-1', title: 'A story', commission: { story_form: 'meanwhile', section_id: 'internet', beats: [] }, classification: { primary_section: 'internet', editorial_pitch: { accepted: true, lens: 'A lens' } } };
const run = { id: 'run-1', candidate_id: candidate.id, research_requirement: 'none', model_usage: [{ stage: 'draft', credits: 1 }], estimated_cost_usd: null };
const packet = { version: 'packet-v1', frozen_evidence_packet_sha256: 'packet-sha', sources: [{ source_id: 'source-1', url: 'https://example.test/story', title: 'Source', classification: 'original_reporting', primary_source: false }], claim_targets: ['claim-1'], claims: [{ claim_id: 'claim-1', claim: 'A supported fact', source_ids: ['source-1'], evidence: [{ evidence_id: 'evidence-1', source_id: 'source-1', claim_ids: ['claim-1'], excerpt: 'A supported fact.' }] }], draft_constraints: [], required_facts: [], prohibited_claims: [] };
const draft = { headline: 'A story', dek: 'A dek', body_markdown: '# A story\n\n*A dek*\n\nA supported fact.', claim_support: [{ claim_id: 'claim-1', evidence_ids: ['evidence-1'], article_anchor: 'paragraph-1', treatment: 'paraphrase' }], warnings: [] };

test('offline materialization validates the existing Draft without provider construction', () => {
  const result = materializeOfflineReview({ candidate, run, packet, draft, retainedDocuments: [{ id: 'source-1', content: 'A supported fact.', title: 'Source' }] });
  assert.equal(result.review.frozen_evidence_packet_sha256, packet.frozen_evidence_packet_sha256);
  assert.equal(result.review.source_links[0].url, 'https://example.test/story');
  assert.equal(result.materialization.provider_calls_added, 0);
});
