import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSourceRecord, validateStorySources } from '../src/source-integrity.mjs';

const story = { title: 'Solana marketplace launches new collector tools', dek: 'A new marketplace product is live on Solana.', story_beats: [], story_tags: [] };

test('source record requires human review and a healthy URL', () => {
  const result = validateSourceRecord({ url: 'https://example.com/solana-marketplace', title: 'Launch note', publisher: 'Example', source_type: 'official', accessed_at: '2026-08-19T00:00:00Z', reviewed_at: '2026-08-19T00:00:00Z', review_status: 'approved', http_status: 200 });
  assert.equal(result.ok, true);
  assert.equal(result.host, 'example.com');
  assert.equal(validateSourceRecord({ ...result, url: 'javascript:alert(1)' }).ok, false);
});

test('story source gate requires a primary source and rejects duplicates', () => {
  const source = { id: 'source-1', url: 'https://example.com/solana-marketplace', title: 'Solana marketplace launches', publisher: 'Example', source_type: 'official', accessed_at: '2026-08-19T00:00:00Z', reviewed_at: '2026-08-19T00:00:00Z', review_status: 'approved', http_status: 200, primary_source: true };
  const passed = validateStorySources(story, [source]);
  assert.equal(passed.ok, true);
  const failed = validateStorySources(story, [{ ...source, primary_source: false }, { ...source, id: 'source-2', primary_source: false }]);
  assert.equal(failed.ok, false);
  assert.ok(failed.errors.some(error => error.code === 'duplicate_url'));
  assert.ok(failed.errors.some(error => error.code === 'no_primary_source'));
});
