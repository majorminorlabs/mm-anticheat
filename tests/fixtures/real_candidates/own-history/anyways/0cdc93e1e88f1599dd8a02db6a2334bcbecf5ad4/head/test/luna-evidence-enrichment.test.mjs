import assert from 'node:assert/strict';
import test from 'node:test';
import { assessLunaEnrichment, enrichLunaEvidence, extractOfficialEventLinks, LUNA_ENRICHMENT_DEFAULTS } from '../src/luna-evidence-enrichment.mjs';
import { fetchOfficialEvidencePage } from '../src/source-ingestion.mjs';

const eventId = '123e4567-e89b-42d3-a456-426614174000';
const relatedId = '123e4567-e89b-42d3-a456-426614174001';
const candidate = { id: '123e4567-e89b-42d3-a456-426614174002', source_event_id: eventId, recommended_length: 'standard', primary_source: 'https://official.example/story', primary_section: 'chains', topic_tags: ['ethereum', 'scaling'] };
const event = { id: eventId, source_id: 'source-1', source_type: 'official_announcements', title: 'A strategy update', canonical_url: 'https://official.example/story', summary: 'The official feed summary is incomplete.', raw_text: 'The official feed summary is incomplete.', raw_payload: { item_xml: '<item><link>https://official.example/story</link><link>https://evil.example/not-allowed</link></item>' }, published_at: '2026-08-07T00:00:00Z' };
const source = { id: 'source-1', name: 'Official Desk', handle_or_url: 'https://official.example/feed.xml', source_type: 'official_announcements', public_display_name: 'Official Desk', review_status: 'ready', active: true, trust_level: 'official' };
const basePacket = { source_event: { id: eventId, title: event.title, summary: event.summary, canonical_url: event.canonical_url }, sources: [{ evidence_id: `event-${eventId}`, source_event_id: eventId, role: 'primary', source_url: event.canonical_url, evidence_excerpt: 'Title: A strategy update\n\nSummary: The official feed summary is incomplete.' }] };

const pageHtml = `<!doctype html><html><head><title>A strategy update</title><link rel="canonical" href="https://official.example/story"></head><body><article><h1>A strategy update</h1><p>The official team published a concrete migration plan on 2026-08-07.</p><p>The plan moves settlement to the shared layer after a nine-week test and assigns responsibility to the protocol team.</p><p>That timeline gives builders a verified sequence to prepare for, instead of a general strategy statement.</p></article></body></html>`;

function fetchPage(body = pageHtml, status = 200, headers = { 'content-type': 'text/html' }) {
  return async url => new Response(status === 200 ? body : null, { status, headers: status === 200 ? headers : { location: 'https://evil.example/redirect' } });
}

test('enrichment defaults are bounded and disabled for future automation', () => {
  assert.equal(LUNA_ENRICHMENT_DEFAULTS.enabled, false);
  assert.equal(LUNA_ENRICHMENT_DEFAULTS.max_urls_per_attempt, 3);
  assert.equal(LUNA_ENRICHMENT_DEFAULTS.max_bytes_per_page, 524288);
  assert.equal(LUNA_ENRICHMENT_DEFAULTS.timeout_ms, 8000);
});

test('official enrichment fetches only the configured host and detects meaningful evidence', async () => {
  assert.deepEqual(extractOfficialEventLinks(event, source), ['https://official.example/story']);
  const result = await enrichLunaEvidence({ candidate, event, source, basePacket, fetchImpl: fetchPage(), now: new Date('2026-08-07T01:00:00Z') });
  assert.equal(result.outcome, 'improved');
  assert.ok(result.new_evidence_chars >= 240);
  assert.ok(result.new_concrete_facts >= 2);
  assert.equal(result.fetched_urls.length, 1);
  assert.equal(result.packet.sources[0].role, 'enriched_primary');
  assert.equal(result.packet.sources[0].source_event_id, eventId);
  assert.match(result.extracted_text_spans[0].text, /nine-week test/);
});

test('enrichment retains official related context but excludes non-official context', async () => {
  const related = { id: relatedId, source_id: 'source-2', source_type: 'official_announcements', title: 'Official context', canonical_url: 'https://official.example/context', summary: 'A verified related event with concrete timeline context.', raw_text: 'A verified related event with concrete timeline context and a second official statement.' };
  const thirdParty = { id: '123e4567-e89b-42d3-a456-426614174003', source_id: 'source-3', source_type: 'blog', title: 'Third party', canonical_url: 'https://third-party.example/story', summary: 'Not an official source.', raw_text: 'Not an official source.' };
  const result = await enrichLunaEvidence({ candidate, event, source, basePacket, fetchImpl: fetchPage(), relatedEvents: [], contextEvents: [related, thirdParty], contextSources: new Map([['source-2', { name: 'Official Context', trust_level: 'official' }], ['source-3', { name: 'Third Party', trust_level: 'reliable' }]]), config: { max_urls_per_attempt: 1 } });
  assert.ok(result.packet.sources.some(item => item.source_event_id === relatedId));
  assert.equal(result.packet.sources.some(item => item.source_event_id === thirdParty.id), false);
  assert.deepEqual(result.related_event_links, [{ source_event_id: eventId, related_event_id: relatedId, relation_type: 'official_context' }]);
});

test('unchanged enrichment does not justify another Luna call', () => {
  const unchanged = assessLunaEnrichment({ basePacket, additions: [{ evidence_id: 'same', evidence_excerpt: 'Title: A strategy update. Summary: The official feed summary is incomplete.' }] });
  assert.equal(unchanged.meaningful, false);
  assert.equal(unchanged.outcome, 'unchanged');
  assert.equal(unchanged.new_concrete_facts, 0);
});

test('redirects outside the configured official host fail closed', async () => {
  await assert.rejects(() => fetchOfficialEvidencePage('https://official.example/story', { source, fetchImpl: fetchPage('', 302) }), error => error.code === 'SSRF_BLOCKED');
});

test('page fetch rejects private URLs before invoking the network', async () => {
  let called = false;
  await assert.rejects(() => fetchOfficialEvidencePage('https://127.0.0.1/story', { source, fetchImpl: async () => { called = true; return new Response(''); } }), error => error.code === 'SSRF_BLOCKED');
  assert.equal(called, false);
});
