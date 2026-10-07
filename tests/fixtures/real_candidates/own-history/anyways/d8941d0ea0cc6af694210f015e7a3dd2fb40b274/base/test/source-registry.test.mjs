import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  duplicateSourceKeys,
  exportSourceRegistryCSV,
  parseSourceRegistryImport,
  PRIMARY_SECTION_IDS,
  sourceIdentityKey,
  validateSourceRecord
} from '../src/source-registry.mjs';

const base = {
  name: 'Example source',
  handle_or_url: '@Example',
  platform: 'x',
  source_type: 'x_account',
  primary_class: 'community',
  description: 'A source record for tests.',
  active: true,
  priority: 5,
  trust_level: 'unknown',
  direct_publish_eligible: false,
  requires_primary_source_lookup: true,
  primary_sections: ['Culture'],
  topic_tags: ['timeline'],
  chain_tags: [],
  project_tags: [],
  poll_interval_seconds: 3600,
  public_display_name: 'Example',
  editorial_title: '',
  legal_or_real_name: '',
  x_handle: '@Example',
  reveal_identity_policy: 'always',
  recurring_character: false,
  public_bio: '',
  internal_notes: '',
  recurring_formats: [],
  internal_queue: '',
  review_status: 'review_needed'
};

test('source records normalize locators and retain a fail-closed ingestion status', () => {
  const normalized = validateSourceRecord(base);
  assert.equal(normalized.handle_or_url, '@example');
  assert.equal(normalized.identity_key, 'x:example');
  assert.equal(normalized.ingestion_status, 'not_activated');
  assert.equal(sourceIdentityKey({ platform: 'web', handle_or_url: 'https://Example.com/news/#latest' }), 'url:https://example.com/news');
});

test('source records reject unsafe locators and invalid policy values', () => {
  assert.throws(() => validateSourceRecord({ ...base, handle_or_url: 'javascript:alert(1)' }), /http:\/\/ or https:\/\//);
  assert.throws(() => validateSourceRecord({ ...base, priority: 11 }), /priority/);
  assert.throws(() => validateSourceRecord({ ...base, reveal_identity_policy: 'sometimes' }), /identity policy/);
  assert.throws(() => validateSourceRecord({ ...base, review_status: 'review_needed', direct_publish_eligible: true }), /mark the source ready/);
});

test('source graph uses the deployed Web3 section IDs', () => {
  assert.deepEqual(PRIMARY_SECTION_IDS, ['digital-collectibles', 'defi', 'markets', 'chains', 'products', 'culture']);
  const record = validateSourceRecord({ ...base, primary_sections: PRIMARY_SECTION_IDS });
  assert.deepEqual(record.primary_sections, PRIMARY_SECTION_IDS);
});

test('duplicate detection catches normalized handles and URLs', () => {
  const duplicates = duplicateSourceKeys([
    base,
    { ...base, name: 'same handle', handle_or_url: '@example' },
    { ...base, name: 'same url', handle_or_url: 'https://example.com/feed', platform: 'rss' },
    { ...base, name: 'same url again', handle_or_url: 'https://EXAMPLE.com/feed/' }
  ]);
  assert.deepEqual(duplicates.map(item => item.key), ['x:example', 'url:https://example.com/feed']);
});

test('unresolved records still get a safe name-based duplicate key', () => {
  const unresolved = { ...base, name: 'Polymarket official account', handle_or_url: '', platform: 'x' };
  assert.equal(sourceIdentityKey(unresolved), 'pending:polymarket-official-account');
  assert.equal(validateSourceRecord(unresolved).identity_key, 'pending:polymarket-official-account');
  assert.equal(duplicateSourceKeys([unresolved, { ...unresolved, name: 'same unresolved source' }]).length, 0);
  assert.equal(duplicateSourceKeys([unresolved, { ...unresolved }]).length, 1);
});

test('JSON and CSV exports round-trip without carrying source IDs into imports', () => {
  const record = validateSourceRecord({ ...base, id: '11111111-1111-4111-8111-111111111111' });
  const json = parseSourceRegistryImport(JSON.stringify([record]));
  assert.equal(json.length, 1);
  assert.equal(json[0].id, undefined);
  assert.equal(json[0].handle_or_url, '@example');
  const csv = parseSourceRegistryImport(exportSourceRegistryCSV([record]));
  assert.equal(csv.length, 1);
  assert.deepEqual(csv[0].primary_sections, ['culture']);
  assert.equal(csv[0].review_status, 'review_needed');
});

test('source graph migration is additive and cannot activate ingestion', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260806140000_source_graph_foundation.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.source_registry/);
  assert.match(migration, /ingestion_status text not null default 'not_activated'/);
  assert.match(migration, /constraint source_registry_ingestion_status_check check \(ingestion_status = 'not_activated'\)/);
  assert.match(migration, /timeline_entertainment/);
  assert.match(migration, /prepare_source_registry_record/);
  assert.match(migration, /source_registry_review_publish_check/);
  for (const name of ['ZachXBT', 'Unusual Whales', 'WatcherGuru', 'Polymarket', 'Kalshi', 'Ethereum', 'Base', 'Solana', 'Hyperliquid', 'Bitcoin', 'Robinhood', 'Phantom', 'MetaMask', 'Solflare', 'OpenSea', 'Magic Eden', 'Courtyard', 'Pudgy Penguins', 'Azuki', 'Moonbirds', 'Claynosaurz', 'Vitalik Buterin', 'Luca Netz', 'Cobie', 'Ansem', 'ChooseRich', 'Clemente']) assert.match(migration, new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(migration, /when 'digital collectibles' then 'digital-collectibles'/);
  assert.doesNotMatch(migration, /insert into public\.pipeline_sources/is);
  assert.doesNotMatch(migration, /drop table|truncate/is);
});

test('settings exposes source monitoring controls without exposing a public route', () => {
  const app = fs.readFileSync(new URL('../src/app.mjs', import.meta.url), 'utf8');
  for (const label of ['Source Graph', 'Search', 'Platform', 'Class', 'Trust', 'Add source', 'Export JSON', 'Export CSV', 'Validate and import', 'Recurring character', 'timeline_entertainment', 'Test source', 'Activate ingestion', 'Pause ingestion', 'Recent ingestion runs', 'Source Events']) assert.match(app, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(app, /Bounded V1 ingestion/);
  assert.match(app, /source-ingestion/);
  assert.match(app, /source_registry/);
});
