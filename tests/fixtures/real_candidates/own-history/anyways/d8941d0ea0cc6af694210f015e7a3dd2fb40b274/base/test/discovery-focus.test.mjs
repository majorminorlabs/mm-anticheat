import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_DISCOVERY_FOCUS_ID, DISCOVERY_FOCUSES, DISCOVERY_FOCUS_IDS, validateDiscoveryFocusId } from '../src/pipeline/discovery-focuses.mjs';
import { retrieveDiscoverySources, selectDiscoverySources } from '../src/pipeline/discovery-sources.mjs';

const registry = [
  { id: 'collectibles-source', enabled: true, focuses: ['digital-collectibles', 'culture'], type: 'rss', url: 'https://collectibles.example/feed' },
  { id: 'culture-source', enabled: true, focuses: ['culture'], type: 'rss', url: 'https://culture.example/feed' },
  { id: 'disabled-source', enabled: false, focuses: ['digital-collectibles'], type: 'rss', url: 'https://disabled.example/feed' }
];

test('coverage registry has unique Web3 section IDs, All, and All Web3 sources as the newsroom default', () => {
  assert.equal(new Set(DISCOVERY_FOCUS_IDS).size, DISCOVERY_FOCUSES.length);
  assert.ok(DISCOVERY_FOCUS_IDS.includes('all'));
  assert.deepEqual(DISCOVERY_FOCUS_IDS, ['all', 'digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture']);
  assert.equal(DEFAULT_DISCOVERY_FOCUS_ID, 'all');
  assert.throws(() => validateDiscoveryFocusId('not-a-focus'), /Unknown discovery coverage focus/);
});

test('All resolves the exact current enabled-source set', () => {
  const selection = selectDiscoverySources(registry, 'all');
  assert.deepEqual(selection.eligible_sources.map(source => source.id), ['collectibles-source', 'culture-source']);
  assert.deepEqual(selection.excluded_source_ids, []);
});

test('Digital Collectibles filters before fetch and excluded sources produce no discovered candidates', async () => {
  const fetched = [];
  const result = await retrieveDiscoverySources({
    registry,
    focusId: 'digital-collectibles',
    fetchDocumentImpl: async url => {
      fetched.push(url);
      return { ok: true, raw: '<rss><channel></channel></rss>', url };
    }
  });
  assert.deepEqual(fetched, ['https://collectibles.example/feed']);
  assert.deepEqual(result.excluded_source_ids, ['culture-source']);
  assert.deepEqual(result.discovered, []);
  assert.equal(result.eligible_source_count, 1);
});

test('unknown source focus IDs fail source selection', () => {
  assert.throws(() => selectDiscoverySources(registry, 'unknown'), /Unknown discovery coverage focus/);
});
