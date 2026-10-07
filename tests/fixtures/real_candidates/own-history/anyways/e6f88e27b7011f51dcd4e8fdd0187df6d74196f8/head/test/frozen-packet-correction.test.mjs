import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { stableJson } from '../src/pipeline/evidence-packet.mjs';
import { refreezeCorrectedFrozenPacket } from '../src/pipeline/frozen-packet-correction.mjs';

const candidate = { id: 'classification-candidate', title: 'A retained source story', description: 'A retained source story.', commission: { story_form: 'meanwhile', section_id: 'internet' }, classification: { story_form: 'meanwhile', primary_section: 'internet' } };
const sources = [
  ['source-techcrunch', 'https://techcrunch.com/story', 'TechCrunch', 'text-techcrunch'],
  ['source-reddit', 'https://www.reddit.com/r/example/comments/1/post', 'Reddit discussion', 'text-reddit'],
  ['source-boss', 'https://www.mindgems.com/products/Boss-Key/boss-key.htm', 'Boss Key', 'text-boss']
].map(([id, url, title, content], index) => ({ id, source_id: id, url, canonical_url: url, title, publisher: 'Example', source_type: 'original_reporting', classification: 'original_reporting', independence_key: `group-${index}`, primary_source: false, accessible: true, ok: true, content }));
const packetPayload = { version: 'pipeline-v1-evidence-packet-offsets-v1', sources: sources.map(source => ({ source_id: source.id, classification: source.classification, title: source.title, url: source.url })), claims: [{ claim_id: 'claim-1', claim: 'The retained source supports the story.', evidence: [{ evidence_id: 'evidence-1', source_id: 'source-techcrunch', start: 0, end: 14, claim_ids: ['claim-1'] }] }], claim_targets: ['claim-1'], required_facts: [], prohibited_claims: [], ledgers: { quotations: [], proper_names: [], numbers: [] }, unresolved_research_questions: [], blockers: [], draft_constraints: ['Keep the retained claim qualified.'] };
const oldChecksum = crypto.createHash('sha256').update(stableJson(packetPayload)).digest('hex');

test('refreezing corrects source classifications without changing retained evidence inputs', () => {
  const result = refreezeCorrectedFrozenPacket({ packet: { ...packetPayload, frozen_evidence_packet_sha256: oldChecksum }, candidate, documents: sources });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.notEqual(result.packet.frozen_evidence_packet_sha256, oldChecksum);
  assert.equal(result.packet.supersedes_frozen_evidence_packet_sha256, oldChecksum);
  assert.equal(result.packet.claims[0].evidence[0].start, 0);
  assert.equal(result.packet.claims[0].evidence[0].end, 14);
  assert.equal(result.packet.draft_constraints[0], packetPayload.draft_constraints[0]);
  assert.deepEqual(result.packet.sources.map(source => [source.source_id, source.classification, source.primary_source]), [
    ['source-techcrunch', 'original_reporting', false],
    ['source-reddit', 'commentary', false],
    ['source-boss', 'primary', true]
  ]);
  assert.equal(result.sourceGate.ok, true);
  assert.equal(result.sourceGate.counts.accessible, 3);
  assert.equal(result.sourceGate.counts.independent, 3);
  assert.equal(result.sourceGate.counts.primary, 1);
  assert.equal(result.classificationChanges.length, 2);
  assert.equal(result.correctedDocuments[1].content, sources[1].content);
});
