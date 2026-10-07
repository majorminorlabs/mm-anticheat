import test from 'node:test';
import assert from 'node:assert/strict';
import { bindFrozenPacketDocuments, frozenPacketSourceLinks } from '../src/pipeline/frozen-document-binder.mjs';

const candidate = { id: 'candidate-1', title: 'A story' };
const run = { id: 'run-1' };
const source = { source_id: 'source-1', url: 'https://example.test/story', title: 'Source', classification: 'original_reporting', primary_source: false };

test('frozen binder preserves packet url and retained metadata', () => {
  const { documents } = bindFrozenPacketDocuments({ candidate, run, packet: { sources: [source], claims: [] }, retainedDocuments: [{ id: 'source-1', content: 'retained text', publisher: 'Example' }] });
  assert.equal(documents[0].url, source.url);
  assert.equal(documents[0].canonical_url, source.url);
  assert.equal(documents[0].publisher, 'Example');
  assert.equal(documents[0].processing_run_id, run.id);
});

test('frozen binder fails closed on missing urls', () => {
  assert.throws(() => bindFrozenPacketDocuments({ candidate, run, packet: { sources: [{ source_id: 'source-1' }] }, retainedDocuments: [{ id: 'source-1', content: 'text' }] }), /missing a URL/);
});

test('frozen binder rejects duplicate urls and source links keep displayed urls', () => {
  assert.throws(() => bindFrozenPacketDocuments({ candidate, run, packet: { sources: [source, { ...source, source_id: 'source-2' }] }, retainedDocuments: [{ id: 'source-1', content: 'one' }, { id: 'source-2', content: 'two' }] }), /duplicate normalized URL/);
  const links = frozenPacketSourceLinks({ sources: [source], claims: [{ claim_id: 'claim-1', source_ids: ['source-1'], evidence: [{ evidence_id: 'evidence-1', source_id: 'source-1' }] }] }, [{ id: 'source-1', title: 'Source' }]);
  assert.equal(links[0].url, source.url);
  assert.deepEqual(links[0].evidence_ids, ['evidence-1']);
});
