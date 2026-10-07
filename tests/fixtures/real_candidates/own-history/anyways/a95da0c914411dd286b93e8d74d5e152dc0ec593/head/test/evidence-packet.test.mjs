import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEvidencePacket } from '../src/pipeline/evidence-packet.mjs';

const sources = [
  { id: 'commentary-1', source_type: 'commentary', title: 'Commentary', url: 'https://commentary.example/a', text: 'Interpretation.' },
  { id: 'primary-1', source_type: 'primary_research', title: 'Official record', url: 'https://official.example/a', text: 'The official record says 42.', facts: [{ fact_id: 'fact-42', statement: 'The number is 42.' }], quotes: [{ text: 'The number is 42.', speaker: 'Director', source_id: 'primary-1' }] },
  { id: 'original-1', source_type: 'original_reporting', title: 'Original reporting', url: 'https://reporting.example/a', text: 'A reporter independently confirmed the change.', proper_names: [{ name: 'A. Reporter', type: 'person', source_id: 'original-1' }], numbers: [{ value: '42', context: 'record count', source_id: 'original-1' }] },
  { id: 'derivative-1', source_type: 'derivative_reporting', title: 'Derivative report', url: 'https://derivative.example/a', text: 'A derivative account repeats the event.' },
  { id: 'unusable-1', title: 'Paywalled', url: 'https://bad.example/a', text: '', error: 'paywall' },
  { id: 'reference-1', kind: 'reference_article', title: 'Prior reference article', url: 'https://reference.example/a', text: 'This generated reference must never enter the packet.' },
  { id: 'draft-1', kind: 'prior_draft', title: 'Prior draft', url: 'https://draft.example/a', text: 'This prior draft must never enter the packet.' }
];

test('packet classifies, orders, bounds, deduplicates, and retains ledgers and blockers', () => {
  const packet = buildEvidencePacket({
    sources: [...sources, { ...sources[2], id: 'original-duplicate' }],
    requiredFacts: [{ fact_id: 'fact-required', text: 'The decision took effect Tuesday.', source_ids: ['primary-1'] }],
    prohibitedClaims: ['Do not claim causation.'],
    unresolvedResearchQuestions: ['Was the change adopted nationally?'],
    blockers: ['The national adoption record is missing.']
  });
  assert.deepEqual(packet.sources.map(source => source.source_id), ['primary-1', 'original-1', 'original-duplicate', 'derivative-1', 'commentary-1']);
  assert.equal(packet.sources.find(source => source.source_id === 'original-duplicate').duplicate_of, 'original-1');
  assert.equal(packet.sources.find(source => source.source_id === 'original-duplicate').excerpt, undefined);
  assert.deepEqual(packet.excluded_sources.map(source => source.source_id), ['draft-1', 'reference-1', 'unusable-1']);
  assert.equal(packet.required_facts.some(fact => fact.fact_id === 'fact-required'), true);
  assert.equal(packet.prohibited_claims[0], 'Do not claim causation.');
  assert.equal(packet.ledgers.quotations[0].speaker, 'Director');
  assert.equal(packet.ledgers.proper_names[0].name, 'A. Reporter');
  assert.equal(packet.ledgers.numbers[0].value, '42');
  assert.deepEqual(packet.unresolved_research_questions, ['Was the change adopted nationally?']);
  assert.deepEqual(packet.blockers, ['The national adoption record is missing.']);
  assert.equal(packet.totals.excerpt_characters, [...packet.sources].reduce((sum, source) => sum + (source.excerpt_characters || 0), 0));
  assert.ok(packet.totals.packet_characters > 0);
  assert.ok(packet.totals.estimated_tokens > 0);
  assert.equal(packet.diagnostics.deduplicated_source_text_count, 1);
  assert.equal(packet.sources.some(source => /prior draft|reference article|must never/i.test(JSON.stringify(source))), false);
});

test('packet ordering and checksum are deterministic regardless of input order', () => {
  const left = buildEvidencePacket({ sources });
  const right = buildEvidencePacket({ sources: [...sources].reverse() });
  assert.deepEqual(left.sources, right.sources);
  assert.deepEqual(left.excluded_sources, right.excluded_sources);
  assert.equal(left.checksum, right.checksum);
});

test('packet truncates each source at the configured excerpt bound', () => {
  const packet = buildEvidencePacket({ sources: [{ id: 'source-1', source_type: 'primary', title: 'One', url: 'https://example.test', text: 'abcdefghij' }], limits: { maxSourceExcerptCharacters: 5 } });
  assert.equal(packet.sources[0].excerpt, 'abcde');
  assert.equal(packet.sources[0].excerpt_characters, 5);
  assert.equal(packet.sources[0].excerpt_truncated, true);
});

test('packet fails closed with the contribution that exceeded the total limit', () => {
  assert.throws(
    () => buildEvidencePacket({ sources: [
      { id: 'a', source_type: 'primary', text: '12345' },
      { id: 'b', source_type: 'primary', text: '67890' }
    ], limits: { maxTotalExcerptCharacters: 7 } }),
    error => error.code === 'EVIDENCE_PACKET_LIMIT_EXCEEDED'
      && error.details.limit_name === 'total_excerpt_characters'
      && error.details.exceeded_by.source_id === 'b'
  );
});

test('reference articles and prior generated drafts are excluded without leaking their text', () => {
  const packet = buildEvidencePacket({ sources: [
    { id: 'usable', source_type: 'primary', title: 'Stored source', url: 'https://source.example', text: 'Allowed evidence.' },
    { id: 'reference', is_reference: true, title: 'Reference', url: 'https://reference.example', text: 'SECRET REFERENCE TEXT' },
    { id: 'draft', is_prior_draft: true, title: 'Draft', url: 'https://draft.example', text: 'SECRET DRAFT TEXT' }
  ] });
  const serialized = JSON.stringify(packet);
  assert.doesNotMatch(serialized, /SECRET REFERENCE TEXT|SECRET DRAFT TEXT/);
  assert.deepEqual(packet.excluded_sources.map(item => item.source_id), ['draft', 'reference']);
});
