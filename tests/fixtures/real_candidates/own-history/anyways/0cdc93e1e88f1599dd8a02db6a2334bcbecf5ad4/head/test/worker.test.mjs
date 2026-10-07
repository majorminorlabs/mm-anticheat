import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { articleMetadata, articleShellResponse, handleAnalyticsApi, handleDiscoveryOperationsApi, handleEditorialAutomationApi, handleEditorialScoringApi, handleLunaEditorialApi, handleMediaPipelineApi, handlePipelineApi, handlePublicApi, publicPageResponse, publishDueStories } from '../src/worker.mjs';

const FILES = new Map([
  ['/index.html', { body: '<!doctype html><html><head><title>Anyways</title><meta name="robots" content="index,follow"></head><body></body></html>', type: 'text/html; charset=utf-8' }],
  ['/app.js', { body: 'console.log("Anyways")', type: 'application/javascript; charset=utf-8' }],
  ['/config.js', { body: 'window.ANYWAYS_CONFIG = {}', type: 'application/javascript; charset=utf-8' }],
  ['/photos/p01.jpg', { body: 'photo', type: 'image/jpeg' }]
]);

function fakeAssets() {
  const requests = [];
  return {
    requests,
    binding: {
      async fetch(request) {
        requests.push({ method: request.method, pathname: new URL(request.url).pathname });
        const file = FILES.get(new URL(request.url).pathname);
        if (!file) return new Response('asset 404', { status: 404 });
        return new Response(request.method === 'HEAD' ? null : file.body, {
          headers: {
            'Content-Type': file.type,
            ETag: '"asset-etag"'
          }
        });
      }
    }
  };
}

function request(pathname, init) {
  return new Request(`https://anyways.example${pathname}`, init);
}

test('known application routes receive the SPA shell', async () => {
  const knownRoutes = [
    '/',
    '/search?q=desk',
    '/topics',
    '/topics/subcultures',
    '/sections/taste',
    '/stories/an-example',
    '/newsroom',
    '/newsroom/pitches',
    '/newsroom/stories',
    '/newsroom/published',
    '/newsroom/homepage',
    '/newsroom/ideas',
    '/newsroom/editorial-candidates',
    '/newsroom/settings',
    '/newsroom/assignment',
    '/newsroom/analytics',
    '/newsroom/new',
    '/newsroom/pipeline',
    '/newsroom/pipeline/jobs/123e4567-e89b-12d3-a456-426614174000',
    '/newsroom/review',
    '/newsroom/on-deck',
    '/newsroom/review/6b181e22964c3ab1b944e0fb68e03593ca1cd7ae58fc5ce12c9e45a55561d315',
    '/newsroom/review/hermes%3Asource-proposal%3A6b181e22964c3ab1b944e0fb68e03593ca1cd7ae58fc5ce12c9e45a55561d315',
    '/newsroom/123e4567-e89b-12d3-a456-426614174000'
  ];

  for (const route of knownRoutes) {
    const assets = fakeAssets();
    const response = await worker.fetch(request(route), { ASSETS: assets.binding });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /text\/html/, route);
    assert.equal(response.headers.get('cache-control'), route.startsWith('/newsroom') ? 'no-store' : 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400', route);
    assert.equal(assets.requests.at(-1).pathname, '/index.html', route);
  }
});

test('raw newsroom shell is noindex before JavaScript runs', async () => {
  const assets = fakeAssets();
  const response = await worker.fetch(request('/newsroom'), { ASSETS: assets.binding });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<meta name="robots" content="noindex,nofollow">/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('sitemap is a live XML endpoint even when the public story lookup is unavailable', async () => {
  const assets = fakeAssets();
  const response = await worker.fetch(request('/sitemap.xml'), { ASSETS: assets.binding });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/xml/);
  assert.match(await response.text(), /<loc>https:\/\/anyways\.example\/<\/loc>/);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400');
  assert.deepEqual(assets.requests, []);
});

test('canonical host policy redirects HTTP and www requests to the HTTPS apex', async () => {
  const assets = fakeAssets();
  const http = await worker.fetch(new Request('http://www.anyways.media/latest?q=desk'), { ASSETS: assets.binding, CANONICAL_ORIGIN: 'https://anyways.media' });
  assert.equal(http.status, 308);
  assert.equal(http.headers.get('location'), 'https://anyways.media/latest?q=desk');
  const www = await worker.fetch(new Request('https://www.anyways.media/latest'), { ASSETS: assets.binding, CANONICAL_ORIGIN: 'https://anyways.media' });
  assert.equal(www.status, 308);
  assert.equal(www.headers.get('location'), 'https://anyways.media/latest');
});

test('public API and HTML use the bounded published projection', async () => {
  const story = {
    id: '123e4567-e89b-42d3-a456-426614174000', title: 'A public story', slug: 'a-public-story', dek: 'A public dek', summary: 'A public summary', body: '# Body',
    section_id: 'culture', published_at: '2026-08-19T12:00:00Z', reading_time_minutes: 3, article_format: 'Analysis', presentation: {},
    sections: { name: 'Culture', slug: 'culture' }, story_sections: [], story_beats: [], story_tags: [], hero_media: null, editor_id: 'private', author_id: 'private'
  };
  const env = { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' };
  const calls = [];
  const fetchImpl = async url => {
    calls.push(String(url));
    if (String(url).includes('/published_stories?')) return Response.json([story]);
    if (String(url).includes('/published_story_sources?') || String(url).includes('/published_story_corrections?') || String(url).includes('/story_related?')) return Response.json([]);
    return Response.json([]);
  };
  const api = await handlePublicApi(request('/api/public/latest?limit=3'), env, fetchImpl);
  assert.equal(api.status, 200);
  const payload = await api.json();
  assert.equal(payload.stories[0].body, '');
  assert.equal(payload.stories[0].editor_id, undefined);
  assert.ok(calls.some(url => url.includes('select=id%2Ctitle%2Cslug')));

  const shell = '<!doctype html><html><head><title>Anyways</title><meta name="description" content="shell"></head><body><main id="app"><p>loading</p></main></body></html>';
  const htmlResponse = await publicPageResponse(request('/stories/a-public-story'), env, new URL('https://anyways.example/stories/a-public-story'), {
    fetchImpl,
    assetFetch: async () => new Response(shell, { headers: { 'content-type': 'text/html; charset=utf-8', etag: 'old' } })
  });
  assert.equal(htmlResponse.status, 200);
  const rendered = await htmlResponse.text();
  assert.match(rendered, /A public story/);
  assert.match(rendered, /data-server-rendered="true"/);
  assert.doesNotMatch(rendered, /private/);
});

test('published articles expose clean server-rendered social metadata', async () => {
  const calls = [];
  const metadata = await articleMetadata(new URL('https://anyways.example/stories/a-story?utm_source=x'), { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' }, async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json([{ id: 'story-1', slug: 'a-story', title: 'Article title', dek: 'Article dek', seo_title: 'SEO title', seo_description: 'SEO description', social_title: 'Social title', social_description: 'Social description', hero_media: { public_url: 'https://cdn.example/hero.jpg' } }]);
  });
  assert.deepEqual(metadata, { canonical: 'https://anyways.example/stories/a-story', title: 'Social title', description: 'Social description', image: 'https://cdn.example/hero.jpg' });
  assert.equal(calls.length, 1);
});

test('published articles use the editor-shipped presentation hero for social metadata', async () => {
  const calls = [];
  const metadata = await articleMetadata(new URL('https://anyways.example/stories/a-story'), { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' }, async (url) => {
    calls.push(String(url));
    return Response.json([{
      id: 'story-1', slug: 'a-story', title: 'Article title', dek: 'Article dek',
      presentation: { hero: { public_url: 'https://cdn.example/editor-selected-hero.jpg' } }
    }]);
  });
  assert.equal(metadata.image, 'https://cdn.example/editor-selected-hero.jpg');
  assert.equal(calls.length, 1);
});

test('published article social metadata resolves Supabase-relative hero URLs', async () => {
  const metadata = await articleMetadata(new URL('https://anyways.example/stories/a-story'), { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' }, async () => Response.json([{
    id: 'story-1', slug: 'a-story', title: 'Article title', dek: 'Article dek',
    presentation: { hero: { public_url: '/storage/v1/object/public/story-media/editor/hero.jpg' } }
  }]));
  assert.equal(metadata.image, 'https://project.supabase.co/storage/v1/object/public/story-media/editor/hero.jpg');
});

test('published article social metadata reads only the safe public projection', async () => {
  const calls = [];
  const metadata = await articleMetadata(new URL('https://anyways.example/stories/a-story'), { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' }, async url => {
    calls.push(String(url));
    return Response.json([{ id: 'story-1', slug: 'a-story', title: 'Article title', dek: 'Article dek', hero_media: { public_url: 'https://project.supabase.co/storage/v1/object/public/story-media/editor/legacy.jpg' } }]);
  });
  assert.equal(metadata.image, 'https://project.supabase.co/storage/v1/object/public/story-media/editor/legacy.jpg');
  assert.equal(calls.length, 1);
});

test('published article shells inject social metadata before the asset fallback', async () => {
  const assets = fakeAssets();
  const response = await articleShellResponse(request('/stories/a-story?utm_source=x'), { ASSETS: assets.binding, SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon' }, new URL('https://anyways.example/stories/a-story?utm_source=x'), {
    assetFetch: fetchAsset => assets.binding.fetch(fetchAsset),
    fetchImpl: async url => String(url).includes('/published_stories?')
      ? Response.json([{ id: 'story-1', slug: 'a-story', title: 'Article title', dek: 'Article dek' }])
      : Response.json([])
  });
  assert.match(await response.text(), /<link rel="canonical" href="https:\/\/anyways\.example\/stories\/a-story">/);
  assert.equal(assets.requests.at(-1).pathname, '/index.html');
});

test('public analytics events are bounded, anonymous, and written only through the service role', async () => {
  const calls = [];
  const event = { event_type: 'scroll', session_id: '123e4567-e89b-42d3-a456-426614174000', path: '/stories/an-example', referrer_host: 'www.google.com', event_value: 75 };
  const response = await handleAnalyticsApi(request('/api/analytics/events', { method: 'POST', headers: { origin: 'https://anyways.example', 'content-type': 'application/json' }, body: JSON.stringify(event) }), pipelineEnv(), async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response('', { status: 201 });
  });
  assert.equal(response.status, 202);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/analytics_events$/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer service');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    ...event,
    landing_page: '/stories/an-example',
    referrer_host: 'www.google.com',
    session_source: null, session_medium: null, session_campaign: null, session_content: null,
    first_source: null, first_medium: null, first_campaign: null, first_content: null,
    detail: null
  });

  const invalid = await handleAnalyticsApi(request('/api/analytics/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...event, path: '/newsroom' }) }), pipelineEnv(), async () => { throw new Error('must not persist'); });
  assert.equal(invalid.status, 403);
});

function pipelineEnv() { return { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', PIPELINE_V1_ENABLED: 'true' }; }
function editorFetch(calls, rpc = { job: { id: '123e4567-e89b-12d3-a456-426614174000' }, duplicate: false }) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-12d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-12d3-a456-426614174000', role: 'editor' }]);
    if (String(url).includes('/rpc/')) return Response.json(rpc);
    return new Response('unexpected', { status: 500 });
  };
}

test('canonical discovery operations expose status, manual run, pause, and Qwen retry controls', async () => {
  const calls = [];
  const auth = { authorization: 'Bearer session' };
  const status = await handleDiscoveryOperationsApi(request('/api/newsroom/discovery/status', { headers: auth }), pipelineEnv(), editorFetch(calls, { enabled: true, controller: { state: 'running' } }));
  assert.equal(status.status, 200);
  assert.ok(calls.some(call => call.url.endsWith('/rpc/get_source_graph_discovery_status')));

  let scheduledWork;
  const manual = await handleDiscoveryOperationsApi(request('/api/newsroom/discovery/run', { method: 'POST', headers: auth }), pipelineEnv(), editorFetch(calls, { started: false, skipped: true, reason: 'already_running' }), { waitUntil(promise) { scheduledWork = promise; } });
  assert.equal(manual.status, 202);
  await scheduledWork;
  const startRpc = calls.find(call => call.url.endsWith('/rpc/start_source_graph_discovery_run'));
  assert.deepEqual(JSON.parse(startRpc.init.body), { p_trigger: 'manual', p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });

  const backfill = await handleDiscoveryOperationsApi(request('/api/newsroom/discovery/run', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'backfill', from: '2026-08-01T00:00:00Z', to: '2026-08-02T00:00:00Z' }) }), pipelineEnv(), editorFetch(calls, { started: false, skipped: true, reason: 'already_running' }), { waitUntil(promise) { scheduledWork = promise; } });
  assert.equal(backfill.status, 202);
  await scheduledWork;
  const backfillStartRpc = calls.filter(call => call.url.endsWith('/rpc/start_source_graph_discovery_run')).at(-1);
  assert.deepEqual(JSON.parse(backfillStartRpc.init.body), { p_trigger: 'backfill', p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });

  const settings = await handleDiscoveryOperationsApi(request('/api/newsroom/discovery/settings', { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }), pipelineEnv(), editorFetch(calls, { enabled: false }));
  assert.equal(settings.status, 200);
  const settingsRpc = calls.find(call => call.url.endsWith('/rpc/save_source_graph_discovery_settings'));
  assert.deepEqual(JSON.parse(settingsRpc.init.body), { p_enabled: false, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });

  const proposalId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const retry = await handleDiscoveryOperationsApi(request(`/api/newsroom/discovery/proposals/${proposalId}/retry`, { method: 'POST', headers: auth }), pipelineEnv(), editorFetch(calls, { duplicate: false, proposal_id: proposalId, status: 'queued' }));
  assert.equal(retry.status, 201);
  const retryRpc = calls.find(call => call.url.endsWith('/rpc/retry_generate_pitch'));
  assert.deepEqual(JSON.parse(retryRpc.init.body), { p_proposal_id: proposalId, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
});

test('editorial scoring controls validate settings, use service-role RPCs, and keep backfill bounded', async () => {
  const calls = [];
  const settings = await handleEditorialScoringApi(request('/api/newsroom/editorial-scoring/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen3:8b', prompt_version: 'discipline_direct_v1', fallback_model: 'qwen3:30b', fallback_prompt_version: 'discipline_direct_v1', batch_size: 3, minimum_score: 4, enabled: false }) }), pipelineEnv(), editorFetch(calls, { model: 'qwen3:8b', prompt_version: 'discipline_direct_v1', fallback_model: 'qwen3:30b', fallback_prompt_version: 'discipline_direct_v1', batch_size: 3, minimum_score: 4, enabled: false }));
  assert.equal(settings.status, 200);
  assert.ok(calls.some(call => call.url.endsWith('/rpc/save_editorial_scoring_settings_v2')));
  const invalid = await handleEditorialScoringApi(request('/api/newsroom/editorial-scoring/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ model: '', batch_size: 99, minimum_score: 4, enabled: true }) }), pipelineEnv(), async () => { throw new Error('must not persist'); });
  assert.equal(invalid.status, 400);
  const backfill = await handleEditorialScoringApi(request('/api/newsroom/editorial-scoring/backfill', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ days: 7, limit: 25 }) }), pipelineEnv(), editorFetch(calls, 12));
  assert.equal(backfill.status, 200);
  const rpc = calls.find(call => call.url.endsWith('/rpc/enqueue_editorial_scoring_backfill'));
  assert.ok(rpc);
  assert.equal(JSON.parse(rpc.init.body).p_limit, 25);
});

test('editorial scoring run remains paused at the Worker boundary when the RPC rejects it', async () => {
  const response = await handleEditorialScoringApi(request('/api/newsroom/editorial-scoring/run', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: '{}' }), pipelineEnv(), async (url, init = {}) => {
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-12d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-12d3-a456-426614174000', role: 'editor' }]);
    return Response.json({ message: 'local editorial scoring is paused', code: '55000' }, { status: 409 });
  });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error.message, /paused/);
});

test('editorial automation settings are authenticated and capped independently of publishing', async () => {
  const calls = [];
  const payload = { enabled: true, scoring_enabled: true, enrichment_enabled: true, luna_enabled: true, max_scoring_events_per_hour: 20, max_scoring_batch_size: 5, max_candidates_per_run: 2, max_luna_calls_per_hour: 2, max_enrichment_attempts: 1, max_enrichment_urls_per_attempt: 3, processing_lease_minutes: 45, retry_limit: 1 };
  const response = await handleEditorialAutomationApi(request('/api/newsroom/editorial-automation/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(payload) }), pipelineEnv(), editorFetch(calls, payload));
  assert.equal(response.status, 200);
  const rpc = calls.find(call => call.url.endsWith('/rpc/save_editorial_automation_settings'));
  assert.ok(rpc);
  assert.equal(JSON.parse(rpc.init.body).p_max_luna_calls_per_hour, 2);
  const invalid = await handleEditorialAutomationApi(request('/api/newsroom/editorial-automation/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, max_candidates_per_run: 9 }) }), pipelineEnv(), async () => { throw new Error('must not persist'); });
  assert.equal(invalid.status, 400);
});

test('manual editorial retry submits only the selected event to the targeted RPC', async () => {
  const calls = [];
  const eventId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const response = await handleEditorialScoringApi(request(`/api/newsroom/editorial-scoring/events/${eventId}/retry`, { method: 'POST', headers: { authorization: 'Bearer session' } }), pipelineEnv(), editorFetch(calls, { duplicate: false, target_event_id: eventId, job: { id: 'job' } }));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.endsWith('/rpc/submit_editorial_scoring_retry'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_event_id: eventId, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
});

test('Luna handoff is authenticated, targeted, configurable, and does not publish', async () => {
  const calls = [];
  const candidateId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const send = await handleLunaEditorialApi(request(`/api/newsroom/luna-editorial/candidates/${candidateId}/send`, { method: 'POST', headers: { authorization: 'Bearer session' } }), pipelineEnv(), editorFetch(calls, { duplicate: false, job: { id: 'job' } }));
  assert.equal(send.status, 201);
  const submit = calls.find(call => call.url.endsWith('/rpc/submit_luna_editorial_candidate'));
  assert.deepEqual(JSON.parse(submit.init.body), { p_candidate_id: candidateId, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
  const settings = await handleLunaEditorialApi(request('/api/newsroom/luna-editorial/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, enabled: false }) }), pipelineEnv(), editorFetch(calls, { model: 'gpt-5.6-luna', enabled: false }));
  assert.equal(settings.status, 200);
  assert.ok(calls.some(call => call.url.endsWith('/rpc/save_luna_editorial_settings')));
  const recurring = await handleLunaEditorialApi(request('/api/newsroom/luna-editorial/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, enabled: false, max_candidates_per_run: 2, max_calls_per_hour: 4, processing_lease_minutes: 30, retry_limit: 1, interval_minutes: 15 }) }), pipelineEnv(), editorFetch(calls, { model: 'gpt-5.6-luna', enabled: false }));
  assert.equal(recurring.status, 200);
  const recurringRpc = calls.find(call => call.url.endsWith('/rpc/save_luna_recurring_settings'));
  assert.deepEqual(JSON.parse(recurringRpc.init.body), { p_max_candidates_per_run: 2, p_max_calls_per_hour: 4, p_processing_lease_minutes: 30, p_retry_limit: 1, p_interval_minutes: 15, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
  const invalid = await handleLunaEditorialApi(request('/api/newsroom/luna-editorial/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ model: '', reasoning: 'high', minimum_score: 4, enabled: true }) }), pipelineEnv(), async () => { throw new Error('must not persist'); });
  assert.equal(invalid.status, 400);
});

test('Luna retry remains targeted to the selected candidate', async () => {
  const calls = [];
  const candidateId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const response = await handleLunaEditorialApi(request(`/api/newsroom/luna-editorial/candidates/${candidateId}/retry`, { method: 'POST', headers: { authorization: 'Bearer session' } }), pipelineEnv(), editorFetch(calls, { retry_of: 'failed-job', job: { id: 'retry-job' } }));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.endsWith('/rpc/retry_luna_editorial_candidate'));
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_id: candidateId, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
});

test('Luna evidence enrichment is targeted and its future automation remains independently disabled', async () => {
  const calls = [];
  const candidateId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const enrich = await handleLunaEditorialApi(request(`/api/newsroom/luna-editorial/candidates/${candidateId}/enrich`, { method: 'POST', headers: { authorization: 'Bearer session' } }), pipelineEnv(), editorFetch(calls, { duplicate: false, job: { id: 'enrichment-job' } }));
  assert.equal(enrich.status, 201);
  const enrichRpc = calls.find(call => call.url.endsWith('/rpc/submit_luna_evidence_enrichment'));
  assert.ok(enrichRpc);
  assert.deepEqual(JSON.parse(enrichRpc.init.body), { p_candidate_id: candidateId, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
  const settings = await handleLunaEditorialApi(request('/api/newsroom/luna-editorial/settings', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, enabled: false, enrichment_enabled: false, enrichment_max_attempts: 1, enrichment_max_urls_per_attempt: 3, enrichment_max_bytes_per_page: 524288, enrichment_timeout_ms: 8000, enrichment_cooldown_minutes: 60 }) }), pipelineEnv(), editorFetch(calls, { model: 'gpt-5.6-luna', enabled: false }));
  assert.equal(settings.status, 200);
  const enrichmentSettingsRpc = calls.find(call => call.url.endsWith('/rpc/save_luna_enrichment_settings'));
  assert.ok(enrichmentSettingsRpc);
  assert.deepEqual(JSON.parse(enrichmentSettingsRpc.init.body), { p_enabled: false, p_max_attempts: 1, p_max_urls_per_attempt: 3, p_max_bytes_per_page: 524288, p_timeout_ms: 8000, p_cooldown_minutes: 60, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
});

test('media backfill is authenticated, event-ID bounded, and does not accept arbitrary URLs', async () => {
  const eventId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-42d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-42d3-a456-426614174000', role: 'editor' }]);
    if (String(url).includes('/rest/v1/source_events?')) return Response.json([{ id: eventId, source_id: '123e4567-e89b-42d3-a456-426614174001', canonical_url: 'https://example.com/story', title: 'Example', media: [{ url: 'https://example.com/hero.jpg', width: 1200, height: 700, type: 'image/jpeg' }] }]);
    if (String(url).includes('/rest/v1/source_registry?')) return Response.json([{ id: '123e4567-e89b-42d3-a456-426614174001', name: 'Example', platform: 'official_site', source_type: 'official_announcements', primary_class: 'official', trust_level: 'official', handle_or_url: 'https://example.com' }]);
    if (String(url).includes('/rest/v1/media_assets') && !init.body) return Response.json([]);
    if (String(url).includes('/rest/v1/media_assets') && init.body) return Response.json([]);
    throw new Error(`Unexpected request ${url}`);
  };
  const response = await handleMediaPipelineApi(request('/api/newsroom/media-assets/backfill', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ source_event_ids: [eventId], cache: false, arbitrary_url: 'https://not-allowed.example/image.jpg' }) }), pipelineEnv(), fetchImpl);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { source_events: 1, assets: 1, cached: 0, cache_failed: 0, editor: '123e4567-e89b-42d3-a456-426614174000' });
  assert.equal(calls.some(call => String(call.url).includes('not-allowed.example')), false);
  const invalid = await handleMediaPipelineApi(request('/api/newsroom/media-assets/backfill', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ source_event_ids: [], cache: false }) }), pipelineEnv(), fetchImpl);
  assert.equal(invalid.status, 400);
});

test('media backfill serializes mixed cacheable and evidence-only assets with stable columns', async () => {
  const firstEventId = '73457200-fd06-483c-9ccc-ab71dc037601';
  const secondEventId = '83457200-fd06-483c-9ccc-ab71dc037601';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-42d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-42d3-a456-426614174000', role: 'editor' }]);
    if (String(url).includes('/rest/v1/source_events?')) return Response.json([
      { id: firstEventId, source_id: '123e4567-e89b-42d3-a456-426614174001', canonical_url: 'https://example.com/story', title: 'Official', media: [{ url: 'https://example.com/hero.jpg', width: 1200, height: 700, type: 'image/jpeg' }] },
      { id: secondEventId, source_id: '123e4567-e89b-42d3-a456-426614174002', canonical_url: 'https://x.com/example/status/1', title: 'Evidence', media: [{ url: 'https://pbs.twimg.com/media/evidence.jpg', width: 1200, height: 700, type: 'image/jpeg' }] }
    ]);
    if (String(url).includes('/rest/v1/source_registry?')) return Response.json([
      { id: '123e4567-e89b-42d3-a456-426614174001', name: 'Example', platform: 'official_site', source_type: 'official_announcements', primary_class: 'official', trust_level: 'official', handle_or_url: 'https://example.com' },
      { id: '123e4567-e89b-42d3-a456-426614174002', name: 'Example X', platform: 'x', source_type: 'x_account', primary_class: 'investigator', trust_level: 'useful_signal', handle_or_url: 'https://x.com/example' }
    ]);
    if (String(url).includes('/rest/v1/media_assets?') && !init.body) return Response.json([]);
    if (String(url).includes('/rest/v1/media_assets')) {
      const body = JSON.parse(init.body);
      assert.equal(body.length, 2);
      assert.deepEqual(Object.keys(body[0]).sort(), Object.keys(body[1]).sort());
      assert.equal(body[1].cached_url, null);
      return Response.json([]);
    }
    if (String(url).includes('/rest/v1/media_asset_derivatives')) return Response.json([]);
    if (String(url) === 'https://example.com/hero.jpg') return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '3' } });
    throw new Error(`Unexpected request ${url}`);
  };
  const response = await handleMediaPipelineApi(request('/api/newsroom/media-assets/backfill', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ source_event_ids: [firstEventId, secondEventId], cache: true }) }), pipelineEnv(), fetchImpl);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { source_events: 2, assets: 2, cached: 0, cache_failed: 1, editor: '123e4567-e89b-42d3-a456-426614174000' });
  assert.equal(calls.some(call => String(call.url).includes('pbs.twimg.com')), false);
});

test('media backfill repeats are successful no-ops for existing event URLs', async () => {
  const eventId = '93457200-fd06-483c-9ccc-ab71dc037601';
  const sourceId = '123e4567-e89b-42d3-a456-426614174001';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-42d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-42d3-a456-426614174000', role: 'editor' }]);
    if (String(url).includes('/rest/v1/source_events?')) return Response.json([{ id: eventId, source_id: sourceId, canonical_url: 'https://example.com/story', title: 'Example', media: [{ url: 'https://example.com/hero.jpg', width: 1200, height: 700, type: 'image/jpeg' }] }]);
    if (String(url).includes('/rest/v1/source_registry?')) return Response.json([{ id: sourceId, name: 'Example', platform: 'official_site', source_type: 'official_announcements', primary_class: 'official', trust_level: 'official', handle_or_url: 'https://example.com' }]);
    if (String(url).includes('/rest/v1/media_assets?') && !init.body) return Response.json([{ source_event_id: eventId, original_url: 'https://example.com/hero.jpg', content_hash: null }]);
    if (String(url).includes('/rest/v1/media_assets')) throw new Error('repeat must not insert');
    throw new Error(`Unexpected request ${url}`);
  };
  const response = await handleMediaPipelineApi(request('/api/newsroom/media-assets/backfill', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ source_event_ids: [eventId], cache: true }) }), pipelineEnv(), fetchImpl);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { source_events: 1, assets: 0, cached: 0, cache_failed: 0, editor: '123e4567-e89b-42d3-a456-426614174000' });
  assert.equal(calls.some(call => String(call.url).includes('/rest/v1/media_assets?on_conflict')), false);
});

test('targeted media cache retry updates only the selected asset and creates derivatives after cache success', async () => {
  const assetId = 'a3457200-fd06-483c-9ccc-ab71dc037601';
  const sourceId = 'b3457200-fd06-483c-9ccc-ab71dc037601';
  const calls = [];
  const existing = { id: assetId, source_registry_id: sourceId, source_event_id: 'c3457200-fd06-483c-9ccc-ab71dc037601', original_url: 'https://example.com/hero.png', source_page_url: 'https://example.com/story', media_type: 'image', rights_basis: 'official_source_media', usage_scope: 'hero_candidate', status: 'cache_failed', cache_state: 'failed', cache_attempt_count: 1, width: null, height: null, metadata: {} };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x02, 0x80, 0, 0, 0x01, 0x68]);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-42d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-42d3-a456-426614174000', role: 'editor' }]);
    if (String(url).includes('/rest/v1/media_assets?id=eq.')) return init.method === 'PATCH' ? Response.json([{ ...existing, ...(JSON.parse(init.body || '{}')), status: JSON.parse(init.body || '{}').cache_state === 'cached' ? 'cached' : existing.status }]) : Response.json([existing]);
    if (String(url).includes('/rest/v1/source_registry?')) return Response.json([{ id: sourceId, name: 'Example', platform: 'official_site', source_type: 'official_announcements', primary_class: 'official', trust_level: 'official', handle_or_url: 'https://example.com', allowed_media_hosts: [] }]);
    if (String(url).includes('/rest/v1/media_asset_derivatives?')) return Response.json([]);
    if (String(url).includes('/rest/v1/media_asset_derivatives')) return Response.json([]);
    if (String(url) === 'https://example.com/hero.png') return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    if (String(url).includes('/storage/v1/object/')) return new Response('', { status: 200 });
    throw new Error(`Unexpected request ${url}`);
  };
  const response = await handleMediaPipelineApi(request(`/api/newsroom/media-assets/${assetId}/retry-cache`, { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: '{}' }), pipelineEnv(), fetchImpl);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.asset.cache_state, 'cached');
  assert.equal(body.asset.width, 640);
  assert.equal(body.asset.height, 360);
  assert.equal(body.derivatives.created, 4);
  assert.equal(calls.filter(call => call.url === 'https://example.com/hero.png').length, 1);
  assert.equal(calls.filter(call => call.url.includes('/rest/v1/media_assets?id=eq.') && call.init.method === 'PATCH').length >= 2, true);
});

test('story media attachment controls stay targeted and editor-only', async () => {
  const storyId = 'd3457200-fd06-483c-9ccc-ab71dc037601';
  const assetId = 'e3457200-fd06-483c-9ccc-ab71dc037601';
  const calls = [];
  const selected = await handleMediaPipelineApi(request(`/api/newsroom/media-assets/stories/${storyId}/hero`, { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'select', asset_id: assetId }) }), pipelineEnv(), editorFetch(calls, { story_id: storyId, selected_asset_id: assetId, manual_override: true }));
  assert.equal(selected.status, 200);
  const selectRpc = calls.find(call => call.url.endsWith('/rpc/set_story_media_hero'));
  assert.deepEqual(JSON.parse(selectRpc.init.body), { p_story_id: storyId, p_asset_id: assetId, p_action: 'select', p_alt_text: null, p_attribution_text: null, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
  const needed = await handleMediaPipelineApi(request(`/api/newsroom/media-assets/stories/${storyId}/hero`, { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'needed' }) }), pipelineEnv(), editorFetch(calls, { story_id: storyId, hero_needed: true, manual_override: true }));
  assert.equal(needed.status, 200);
  const neededRpc = calls.filter(call => call.url.endsWith('/rpc/set_story_media_hero')).at(-1);
  assert.equal(JSON.parse(neededRpc.init.body).p_action, 'needed');
  const block = await handleMediaPipelineApi(request(`/api/newsroom/media-assets/stories/${storyId}/assets/${assetId}`, { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'block' }) }), pipelineEnv(), editorFetch(calls, { story_id: storyId, asset_id: assetId, action: 'block' }));
  assert.equal(block.status, 200);
  assert.ok(calls.some(call => call.url.endsWith('/rpc/update_story_media_asset')));
});

test('pipeline submission requires an authenticated editor and uses the frozen v1 RPC', async () => {
  const unauthenticated = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', body: '{}' }), pipelineEnv(), async () => { throw new Error('must not fetch'); });
  assert.equal(unauthenticated.status, 401);

  const calls = [];
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', research_requirement: 'none', priority: 75 }) }), pipelineEnv(), editorFetch(calls, '123e4567-e89b-12d3-a456-426614174000'));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/commission_editorial_pitch_v1_with_decision'));
  assert.ok(rpc);
  assert.match(rpc.init.headers.authorization, /^Bearer service$/);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_external_id: 'a'.repeat(64), p_priority: 75, p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_research_requirement: 'none', p_research_requirement_reason: null });
  assert.deepEqual(await response.json(), { job: { id: '123e4567-e89b-12d3-a456-426614174000' }, duplicate: false });
});

test('editorial commission carries the selected writer and length through the assignment RPC', async () => {
  const calls = [];
  const body = { job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'sol-low', length: 'brief', research_requirement: 'none' };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls, '123e4567-e89b-12d3-a456-426614174000'));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/commission_editorial_pitch_v1_with_assignment'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_external_id: 'a'.repeat(64), p_priority: 50, p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_research_requirement: 'none', p_research_requirement_reason: null, p_writer: 'sol-low', p_length: 'brief' });
});

test('normalized newsroom commission envelopes are accepted by the Worker boundary', async () => {
  const calls = [];
  const body = {
    job_type: 'process_candidate',
    parameters: { candidate_id: 'a'.repeat(64), pipeline_version: 'v1', writer: 'sol-low', length: 'standard', research_requirement: 'none' },
    priority: 50
  };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls, '123e4567-e89b-12d3-a456-426614174000'));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/commission_editorial_pitch_v1_with_assignment'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_external_id: 'a'.repeat(64), p_priority: 50, p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_research_requirement: 'none', p_research_requirement_reason: null, p_writer: 'sol-low', p_length: 'standard' });
});

test('every process authorization uses the frozen v1 RPC family', async () => {
  for (const authorization of [undefined, 'research_again']) {
    const calls = [];
    const body = { job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', ...(authorization ? { authorization } : {}) };
    const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls, authorization ? { job: { id: '123e4567-e89b-12d3-a456-426614174000' }, duplicate: false } : '123e4567-e89b-12d3-a456-426614174000'));
    assert.equal(response.status, 201);
    const rpc = calls.find(call => call.url.includes('/rpc/'));
    assert.match(rpc.url, authorization === 'research_again' ? /research_again_pipeline_v1/ : /commission_editorial_pitch_v1_with_decision/);
  }
});

test('research-again retries preserve the original writer and length assignment', async () => {
  const calls = [];
  const body = { job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'research_again', writer: 'sol-low', length: 'standard', research_requirement: 'required' };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/research_again_pipeline_v1'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_external_id: 'a'.repeat(64), p_priority: 50, p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_writer: 'sol-low', p_length: 'standard' });
});

test('stage replay uses the protected replay RPC and preserves its stage lineage', async () => {
  const calls = [];
  const body = { job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', authorization: 'replay_from_stage', replay_from_stage: 'writer', parent_run_id: '123e4567-e89b-12d3-a456-426614174000', replay_attempt_id: '123e4567-e89b-12d3-a456-426614174001', writer: 'sol-low', length: 'standard' };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/replay_pipeline_v1_stage'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_external_id: 'a'.repeat(64), p_priority: 50, p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_writer: 'sol-low', p_length: 'standard', p_stage: 'writer', p_parent_run_id: '123e4567-e89b-12d3-a456-426614174000', p_replay_attempt_id: '123e4567-e89b-12d3-a456-426614174001' });
});

test('scoped V1 commissioning uses the V1 RPC while the global flag remains false', async () => {
  const calls = [];
  const body = { job_type: 'process_candidate', candidate_id: 'a'.repeat(64), pipeline_version: 'v1', research_requirement: 'none' };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...pipelineEnv(), PIPELINE_V1_ENABLED: 'false' }, editorFetch(calls, '123e4567-e89b-12d3-a456-426614174000'));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/commission_editorial_pitch_v1_with_decision'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_candidate_external_id: 'a'.repeat(64), p_priority: 50, p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_research_requirement: 'none', p_research_requirement_reason: null });
});

test('direct article commissions are rejected before any queue RPC is called', async () => {
  const calls = [];
  const body = { job_type: 'commission_article', brief: 'Bypass discovery and write this article.' };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 400);
  assert.equal(calls.some(call => call.url.includes('/rpc/')), false);
});

test('focused editorial pitches use the protected assignment RPC', async () => {
  const calls = [];
  const body = { job_type: 'create_editorial_pitch', brief: 'Explain why wallets have become a new kind of public identity.', section_id: 'products', story_form: 'meanwhile', beats: ['wallets'], tags: ['wallet-identity'], source_urls: ['https://example.com/report'], notes: 'Follow the behavior, not the app.' };
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify(body) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/submit_focused_editorial_pitch'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_parameters: { brief: body.brief, section_id: body.section_id, story_form: body.story_form, beats: body.beats, tags: body.tags, source_urls: body.source_urls, notes: body.notes }, p_priority: 50, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
});

test('editorial batches carry the selected Coverage Focus to their protected submission RPC', async () => {
  const calls = [];
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ job_type: 'run_editorial_batch', focus_id: 'chains' }) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/submit_editorial_batch'));
  assert.ok(rpc);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_requested_by: '123e4567-e89b-12d3-a456-426614174000', p_requested_focus_id: 'chains', p_section_id: null, p_story_form: null, p_target_count: 10 });
});

test('pipeline submission rejects unsupported and invalid browser payloads', async () => {
  const calls = [];
  const unsupported = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ job_type: 'sync_candidate' }) }), pipelineEnv(), editorFetch(calls));
  assert.equal(unsupported.status, 400);
  assert.equal(calls.some(call => call.url.includes('/rpc/')), false);

  const nonEditorCalls = [];
  const nonEditor = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ job_type: 'discover' }) }), pipelineEnv(), async (url, init = {}) => {
    nonEditorCalls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-12d3-a456-426614174000' });
    return Response.json([{ id: '123e4567-e89b-12d3-a456-426614174000', role: 'contributor' }]);
  });
  assert.equal(nonEditor.status, 403);
  assert.equal(nonEditorCalls.some(call => call.url.includes('/rpc/')), false);
});

test('pipeline cancellation and retry use the approved server-side actions', async () => {
  for (const action of ['cancel', 'retry']) {
    const calls = [];
    const response = await handlePipelineApi(request(`/api/newsroom/pipeline/jobs/123e4567-e89b-12d3-a456-426614174000/${action}`, { method: 'POST', headers: { authorization: 'Bearer session' } }), pipelineEnv(), editorFetch(calls));
    assert.equal(response.status, 200);
    assert.ok(calls.some(call => call.url.includes(`/rpc/${action === 'cancel' ? 'cancel_newsroom_pipeline_job' : 'retry_newsroom_pipeline_job'}`)));
  }
});

test('queue reorder requires an editor and calls the protected server-side action', async () => {
  const calls = [];
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs/123e4567-e89b-12d3-a456-426614174000/reorder', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ action: 'next' }) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 200);
  const rpc = calls.find(call => call.url.includes('/rpc/reorder_newsroom_pipeline_job'));
  assert.ok(rpc); assert.deepEqual(JSON.parse(rpc.init.body), { p_job_id: '123e4567-e89b-12d3-a456-426614174000', p_action: 'next', p_priority: null, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
});

test('scheduled publishing uses the protected due-story RPC', async () => {
  const calls = [];
  const result = await publishDueStories(pipelineEnv(), async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json([{ story_id: '123e4567-e89b-12d3-a456-426614174000' }]);
  });
  assert.equal(result.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/publish_due_stories$/);
  assert.equal(calls[0].init.headers.authorization, 'Bearer service');
  assert.equal(calls[0].init.method, 'POST');
});

test('missing assets and unknown routes remain real 404 responses', async () => {
  const unknownRoutes = [
    '/missing.js',
    '/stories/not-a-route.js',
    '/stories/too/many',
    '/newsroom/not-a-uuid',
    '/newsroom/new/',
    '/search/',
    '/signin',
    '/topics/',
    '/unknown'
  ];

  for (const route of unknownRoutes) {
    const assets = fakeAssets();
    const response = await worker.fetch(request(route), { ASSETS: assets.binding });
    assert.equal(response.status, 404, route);
    assert.equal(await response.text(), 'Not Found', route);
    assert.deepEqual(assets.requests.map(item => item.pathname), [route], route);
    assert.equal(response.headers.get('cache-control'), 'no-store', route);
  }
});

test('legacy taxonomy routes redirect to their new editorial lens or beat', async () => {
  for (const [from, to] of [['/sections/digital-collectibles', '/sections/nfts'], ['/sections/anyways', '/sections/culture'], ['/topics/internet-culture', '/topics/communities'], ['/topics/business', '/sections/products']]) {
    const assets = fakeAssets();
    const response = await worker.fetch(request(from), { ASSETS: assets.binding });
    assert.equal(response.status, 308, from);
    assert.equal(response.headers.get('location'), to, from);
    assert.deepEqual(assets.requests, [], from);
  }
});

test('static assets keep validators and receive deliberate cache policies', async () => {
  const currentBundleAssets = fakeAssets();
  const currentBundle = await worker.fetch(request('/app.js'), { ASSETS: currentBundleAssets.binding });
  assert.equal(currentBundle.status, 200);
  assert.equal(currentBundle.headers.get('etag'), '"asset-etag"');
  assert.equal(currentBundle.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const versionedBundleAssets = fakeAssets();
  const versionedBundle = await worker.fetch(request('/app.js?v=newsroom-v5'), { ASSETS: versionedBundleAssets.binding });
  assert.equal(versionedBundle.headers.get('cache-control'), 'public, max-age=0, must-revalidate');

  const configAssets = fakeAssets();
  const config = await worker.fetch(request('/config.js'), { ASSETS: configAssets.binding });
  assert.equal(config.headers.get('cache-control'), 'no-store');

  const imageAssets = fakeAssets();
  const image = await worker.fetch(request('/photos/p01.jpg'), { ASSETS: imageAssets.binding });
  assert.equal(image.headers.get('cache-control'), 'public, max-age=604800, stale-while-revalidate=86400');
});

test('security headers cover assets, route shells, and errors', async () => {
  for (const path of ['/app.js', '/stories/an-example', '/missing.js']) {
    const assets = fakeAssets();
    const response = await worker.fetch(request(path), { ASSETS: assets.binding });
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: blob: https:/);
    assert.match(csp, /script-src 'self'/, path);
    assert.match(csp, /frame-src 'self' https:\/\/www\.youtube\.com https:\/\/www\.youtube-nocookie\.com https:\/\/platform\.twitter\.com/, path);
    assert.doesNotMatch(csp, /fonts\.googleapis\.com|fonts\.gstatic\.com/, path);
    assert.match(csp, /https:\/\/\*\.supabase\.co/, path);
    assert.match(csp, /wss:\/\/\*\.supabase\.co/, path);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains; preload', path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin', path);
  }
});

test('HEAD is bodyless and unsupported methods are rejected before asset lookup', async () => {
  const headAssets = fakeAssets();
  const head = await worker.fetch(request('/stories/an-example', { method: 'HEAD' }), { ASSETS: headAssets.binding });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(headAssets.requests.at(-1).method, 'HEAD');

  const postAssets = fakeAssets();
  const post = await worker.fetch(request('/app.js', { method: 'POST' }), { ASSETS: postAssets.binding });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.deepEqual(postAssets.requests, []);
});
