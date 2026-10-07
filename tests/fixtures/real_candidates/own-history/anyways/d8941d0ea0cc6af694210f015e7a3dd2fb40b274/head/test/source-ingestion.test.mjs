import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  backoffSeconds,
  duplicateEvent,
  fetchSource,
  isSafeFetchUrl,
  parseFeed,
  parseOfficialPage,
  selectPollSources,
  sourceEligibility
} from '../src/source-ingestion.mjs';
import { handleSourceIngestionApi, handleXBrowserApi, publishDueStories, runSourceIngestionScheduler } from '../src/worker.mjs';

const source = {
  id: '123e4567-e89b-12d3-a456-426614174000',
  name: 'Example Feed',
  active: true,
  review_status: 'ready',
  source_type: 'rss',
  handle_or_url: 'https://example.com/feed.xml',
  priority: 8,
  poll_interval_seconds: 600,
  ingestion_status: 'ready',
  primary_sections: ['products'],
  topic_tags: ['example']
};

const rss = `<?xml version="1.0"?><rss><channel><item><title>Signal &amp; change</title><link>https://example.com/story/1?utm_source=x</link><guid>story-1</guid><description><![CDATA[<p>A useful summary.</p>]]></description><pubDate>Wed, 06 Aug 2026 12:00:00 GMT</pubDate><dc:creator>Reporter</dc:creator><enclosure url="https://example.com/image.jpg" type="image/jpeg" /></item></channel></rss>`;
const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom item</title><id>tag:example.com,2026:item-1</id><link rel="alternate" href="https://example.com/atom/1"/><summary>Atom summary</summary><updated>2026-08-06T12:00:00Z</updated></entry></feed>`;

test('RSS parsing retains identifiers, normalized dates, and media references', () => {
  const [item] = parseFeed(rss, { contentType: 'application/rss+xml' });
  assert.equal(item.external_id, 'story-1');
  assert.equal(item.canonical_url, 'https://example.com/story/1?utm_source=x');
  assert.equal(item.title, 'Signal & change');
  assert.equal(item.published_at, '2026-08-06T12:00:00.000Z');
  assert.equal(item.author_name, 'Reporter');
  assert.equal(item.media[0].url, 'https://example.com/image.jpg');
  assert.equal(item.raw_payload.item_xml.includes('<title>Signal &amp; change</title>'), true);
  assert.equal('raw_document' in item.raw_payload, false);
});

test('Atom parsing prefers alternate links and normalizes timestamps', () => {
  const [item] = parseFeed(atom, { contentType: 'application/atom+xml' });
  assert.equal(item.external_id, 'tag:example.com,2026:item-1');
  assert.equal(item.canonical_url, 'https://example.com/atom/1');
  assert.equal(item.published_at, '2026-08-06T12:00:00.000Z');
});

test('official page fallback extracts visible article metadata and Open Graph media', () => {
  const [item] = parseOfficialPage('<html><head><title>Fallback</title><meta property="og:description" content="A page summary"><meta property="og:image" content="https://example.com/hero.jpg"><link rel="canonical" href="https://example.com/news/fallback"></head><body><article><h1>Fallback headline</h1><p>Visible article copy.</p><script>ignore me</script></article></body></html>', { pageUrl: 'https://example.com/news/fallback' });
  assert.equal(item.title, 'Fallback');
  assert.equal(item.canonical_url, 'https://example.com/news/fallback');
  assert.equal(item.summary, 'A page summary');
  assert.equal(item.raw_text, 'Fallback headline Visible article copy.');
  assert.equal(item.media[0].url, 'https://example.com/hero.jpg');
});

test('duplicate detection is source-scoped and catches stable identifiers', () => {
  assert.equal(duplicateEvent([{ external_id: 'item-1', canonical_url: 'https://example.com/1', content_hash: 'hash-1' }], { external_id: 'item-1', canonical_url: 'https://other.example/2', content_hash: 'hash-2' }), true);
  assert.equal(duplicateEvent([{ external_id: 'item-1', canonical_url: 'https://example.com/1', content_hash: 'hash-1' }], { external_id: 'item-2', canonical_url: 'https://example.com/1', content_hash: 'hash-2' }), true);
  assert.equal(duplicateEvent([{ external_id: 'item-1', canonical_url: 'https://example.com/1', content_hash: 'hash-1' }], { external_id: 'item-2', canonical_url: 'https://example.com/2', content_hash: 'hash-1' }), true);
});

test('SSRF protections reject non-HTTPS, private, metadata, credentials, and unsafe ports', () => {
  for (const url of ['http://example.com/feed', 'https://127.0.0.1/feed', 'https://10.0.0.2/feed', 'https://localhost/feed', 'https://metadata.google.internal/', 'https://user:pass@example.com/feed', 'https://example.com:8443/feed']) assert.equal(isSafeFetchUrl(url).ok, false, url);
  assert.equal(isSafeFetchUrl('https://public.example/feed').ok, true);
});

test('source eligibility rejects unresolved and X sources without polling them', () => {
  assert.equal(sourceEligibility({ ...source, source_type: 'x_account', handle_or_url: '@account' }).status, 'unsupported');
  assert.equal(sourceEligibility({ ...source, review_status: 'review_needed' }).eligible, false);
  assert.equal(sourceEligibility({ ...source, handle_or_url: '' }).eligible, false);
  assert.equal(selectPollSources([{ ...source, ingestion_status: 'polling' }, source, { ...source, id: '123e4567-e89b-12d3-a456-426614174001', priority: 10 }, { ...source, id: '123e4567-e89b-12d3-a456-426614174002', ingestion_next_eligible_at: '2099-01-01T00:00:00Z' }], { limit: 1 }).length, 1);
});

test('backoff grows exponentially and is capped', () => {
  assert.equal(backoffSeconds({ pollIntervalSeconds: 600, failureCount: 0 }), 600);
  assert.equal(backoffSeconds({ pollIntervalSeconds: 600, failureCount: 2 }), 2400);
  assert.equal(backoffSeconds({ pollIntervalSeconds: 600, failureCount: 20 }), 86400);
});

test('conditional requests use ETag and return a not-modified result', async () => {
  const calls = [];
  const result = await fetchSource({ ...source, ingestion_etag: '"abc"' }, { fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 304, headers: { etag: '"abc"' } }); } });
  assert.equal(result.notModified, true);
  assert.equal(calls[0].init.headers['if-none-match'], '"abc"');
});

test('payload-size limits fail before parsing oversized responses', async () => {
  await assert.rejects(() => fetchSource(source, { maxBytes: 10, fetchImpl: async () => new Response(rss, { headers: { 'content-length': String(rss.length) } }) }), /payload limit/);
});

test('redirects to unsafe hosts are rejected before the second request', async () => {
  let calls = 0;
  await assert.rejects(() => fetchSource(source, { fetchImpl: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } }); } }), /blocked/);
  assert.equal(calls, 1);
});

test('scheduler claims a bounded batch, inserts normalized events, and finalizes the leased run', async () => {
  const calls = [];
  const claim = { source_id: source.id, run_id: '123e4567-e89b-12d3-a456-426614174001', lease_token: '123e4567-e89b-12d3-a456-426614174002', name: source.name, handle_or_url: source.handle_or_url, source_type: source.source_type, priority: source.priority, poll_interval_seconds: source.poll_interval_seconds, ingestion_failure_count: 0, ingestion_etag: null, ingestion_last_modified: null, primary_sections: source.primary_sections, topic_tags: source.topic_tags };
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/rpc/claim_source_ingestion_batch')) return Response.json([claim]);
    if (String(url).includes('/rpc/finish_source_ingestion_run')) return Response.json(true);
    if (String(url).includes('/source_events?')) return Response.json([]);
    if (String(url).endsWith('/source_events')) return Response.json(JSON.parse(init.body));
    if (String(url) === source.handle_or_url) return new Response(rss, { headers: { 'content-type': 'application/rss+xml', etag: '"feed-1"' } });
    throw new Error(`Unexpected request ${url}`);
  };
  const result = await runSourceIngestionScheduler({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }, { fetchImpl, now: new Date('2026-08-06T12:00:00Z'), limit: 20 });
  assert.equal(result.claimed, 1);
  assert.equal(result.results[0].inserted, 1);
  assert.ok(calls.some(call => call.url.endsWith('/source_events')));
  assert.ok(calls.some(call => call.url.includes('/rpc/finish_source_ingestion_run')));
});

test('scheduled publishing remains a separate protected RPC', async () => {
  const calls = [];
  const result = await publishDueStories({ SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }, async (url, init) => { calls.push({ url, init }); return Response.json([]); });
  assert.deepEqual(result, []);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /publish_due_stories$/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer service');
});

test('source monitoring actions require an editor and separate validation from activation and pause', async () => {
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
  let state = { ...source, ingestion_status: 'not_activated', ingestion_validated_at: null, ingestion_validation_url: null };
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-12d3-a456-426614174000' });
    if (href.includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-12d3-a456-426614174000', role: 'editor' }]);
    if (href.includes('/rest/v1/source_registry?') && init.method === 'PATCH') {
      state = { ...state, ...JSON.parse(init.body) };
      return Response.json([state]);
    }
    if (href.includes('/rest/v1/source_registry?')) return Response.json([state]);
    if (href === source.handle_or_url) return new Response(rss, { headers: { 'content-type': 'application/rss+xml' } });
    throw new Error(`Unexpected request ${href}`);
  };
  const headers = { authorization: 'Bearer session', 'content-type': 'application/json' };
  const testResponse = await handleSourceIngestionApi(new Request(`https://anyways.media/api/newsroom/source-ingestion/test/${source.id}`, { method: 'POST', headers, body: '{}' }), env, fetchImpl);
  assert.equal(testResponse.status, 200);
  assert.equal((await testResponse.json()).valid, true);
  assert.equal(state.ingestion_status, 'ready');
  const activateResponse = await handleSourceIngestionApi(new Request(`https://anyways.media/api/newsroom/source-ingestion/activate/${source.id}`, { method: 'POST', headers, body: '{}' }), env, fetchImpl);
  assert.equal(activateResponse.status, 200);
  assert.equal(state.active, true);
  const pauseResponse = await handleSourceIngestionApi(new Request(`https://anyways.media/api/newsroom/source-ingestion/pause/${source.id}`, { method: 'POST', headers, body: '{}' }), env, fetchImpl);
  assert.equal(pauseResponse.status, 200);
  assert.equal(state.active, false);
  assert.equal(state.ingestion_status, 'not_activated');
  assert.equal(state.ingestion_next_eligible_at, null);
  assert.equal(state.ingestion_lease_token, null);
  assert.equal(state.ingestion_lease_until, null);
});

test('X browser source actions require a verified handle and queue only a targeted controller job', async () => {
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
  const xSource = { ...source, name: 'Verified X account', source_type: 'x_account', x_handle: '@example_account', active: true, review_status: 'ready', ingestion_status: 'ready' };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url); calls.push({ href, init });
    if (href.includes('/auth/v1/user')) return Response.json({ id: source.id });
    if (href.includes('/rest/v1/profiles')) return Response.json([{ id: source.id, role: 'editor' }]);
    if (href.includes('/rest/v1/source_registry?')) return Response.json([xSource]);
    if (href.includes('/rpc/submit_x_browser_ingestion_test')) return Response.json({ job: { id: '123e4567-e89b-12d3-a456-426614174001', job_type: 'x_browser_ingestion' }, duplicate: false });
    throw new Error(`Unexpected request ${href}`);
  };
  const response = await handleSourceIngestionApi(new Request(`https://anyways.media/api/newsroom/source-ingestion/test/${source.id}`, { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: '{}' }), env, fetchImpl);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).job.job_type, 'x_browser_ingestion');
  assert.equal(calls.some(call => call.href.includes('/rpc/submit_x_browser_ingestion_test')), true);
  assert.equal(calls.some(call => call.href.includes('/source_events')), false);
});

test('X browser settings API is authenticated and forwards conservative single-account pacing', async () => {
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url); calls.push({ href, init });
    if (href.includes('/auth/v1/user')) return Response.json({ id: source.id });
    if (href.includes('/rest/v1/profiles')) return Response.json([{ id: source.id, role: 'editor' }]);
    if (href.includes('/rpc/save_x_browser_ingestion_settings_v2')) return Response.json({ id: 'default', enabled: true, max_accounts_per_run: 1 });
    if (href.includes('/rest/v1/x_browser_ingestion_settings')) return Response.json([{ id: 'default', enabled: false, status: 'paused' }]);
    if (href.includes('/rest/v1/source_registry?')) return Response.json([]);
    throw new Error(`Unexpected request ${href}`);
  };
  const headers = { authorization: 'Bearer session', 'content-type': 'application/json' };
  const response = await handleXBrowserApi(new Request('https://anyways.media/api/newsroom/x-browser/settings', { method: 'POST', headers, body: JSON.stringify({ enabled: true, max_accounts_per_run: 1, max_posts_per_account: 20, page_concurrency: 1, reply_min_chars: 140 }) }), env, fetchImpl);
  assert.equal(response.status, 200);
  const rpc = calls.find(call => call.href.includes('/rpc/save_x_browser_ingestion_settings_v2'));
  assert.deepEqual(JSON.parse(rpc.init.body), { p_enabled: true, p_max_accounts_per_run: 1, p_max_posts_per_account: 20, p_page_concurrency: 1, p_reply_min_chars: 140, p_min_visit_gap_seconds: 90, p_max_visit_gap_seconds: 360, p_max_visits_per_hour: 8, p_long_break_every_visits: 4, p_long_break_min_seconds: 480, p_long_break_max_seconds: 1200, p_requested_by: source.id });
  const rejected = await handleXBrowserApi(new Request('https://anyways.media/api/newsroom/x-browser/settings', { method: 'POST', headers, body: JSON.stringify({ enabled: true, max_accounts_per_run: 99, max_posts_per_account: 20, page_concurrency: 1, reply_min_chars: 140 }) }), env, fetchImpl);
  assert.equal(rejected.status, 400);
});

test('migration is additive and records no X activation or publishing path', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260806150000_source_ingestion_v1.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.source_events/);
  assert.match(migration, /create table if not exists public\.source_ingestion_runs/);
  assert.match(migration, /claim_source_ingestion_batch/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /ingestion_lease_token/);
  assert.match(migration, /source_type = 'x_account'/);
  assert.doesNotMatch(migration, /publish_due_stories|pipeline_jobs|drop table|truncate/i);
});

test('X browser migration is additive, editor-readable, controller-only, and paused by default', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260808100000_x_browser_ingestion_v1.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.x_browser_ingestion_settings/);
  assert.match(migration, /enabled boolean not null default false/);
  assert.match(migration, /create unique index if not exists pipeline_jobs_one_active_x_browser_ingestion/);
  assert.match(migration, /claim_x_browser_ingestion_batch/);
  assert.match(migration, /for update skip locked/i);
  assert.match(migration, /submit_x_browser_ingestion_test/);
  assert.match(migration, /revoke all on table public\.x_browser_ingestion_settings from public, anon, authenticated/);
  assert.match(migration, /grant select on table public\.x_browser_ingestion_settings to authenticated/);
  assert.doesNotMatch(migration, /drop table|truncate|publish_due_stories|insert into public\.stories/i);
});

test('X browser pacing migration enforces one-account visits, durable cooldowns, and manual review pauses', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260808193000_x_browser_pacing_v2.sql', import.meta.url), 'utf8');
  assert.match(migration, /create table if not exists public\.x_browser_source_pacing/);
  assert.match(migration, /p_max_accounts_per_run <> 1/);
  assert.match(migration, /p_page_concurrency <> 1/);
  assert.match(migration, /p_max_visits_per_hour not between 1 and 12/);
  assert.match(migration, /pacing\.last_visit_at/);
  assert.match(migration, /order by -ln\(greatest\(random\(\)/i);
  assert.match(migration, /X_AUTH_REQUIRED', 'X_BLOCKED/);
  assert.match(migration, /manual_review_required/);
  assert.match(migration, /next_eligible_visit_at/);
  assert.doesNotMatch(migration, /drop table|truncate|delete from public\.(stories|source_events)|publish_due_stories/i);
});

test('X pacing validation holds events outside scoring until explicit release', () => {
  const migration = fs.readFileSync(new URL('../supabase/migrations/20260808210000_x_pacing_validation_isolation.sql', import.meta.url), 'utf8');
  const finishFix = fs.readFileSync(new URL('../supabase/migrations/20260808195500_x_browser_pacing_v2_finish_signature_fix.sql', import.meta.url), 'utf8');
  assert.match(finishFix, /p_cursor_or_etag jsonb/);
  assert.match(migration, /validation_run_id uuid/);
  assert.match(migration, /source_event_is_x_validation_held/);
  assert.match(migration, /not public\.source_event_is_x_validation_held/);
  assert.match(migration, /release_x_browser_validation_events_v2/);
  assert.match(migration, /pipeline_jobs_x_browser_validation_tag/);
  assert.doesNotMatch(migration, /drop table|truncate|delete from public\.(stories|source_events)|publish_due_stories/i);
});
