import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { handlePipelineApi } from '../src/worker.mjs';

const FILES = new Map([
  ['/index.html', { body: '<!doctype html><title>Anyways</title>', type: 'text/html; charset=utf-8' }],
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
    '/newsroom/new',
    '/newsroom/pipeline',
    '/newsroom/pipeline/jobs/123e4567-e89b-12d3-a456-426614174000',
    '/newsroom/review',
    '/newsroom/review/6b181e22964c3ab1b944e0fb68e03593ca1cd7ae58fc5ce12c9e45a55561d315',
    '/newsroom/123e4567-e89b-12d3-a456-426614174000'
  ];

  for (const route of knownRoutes) {
    const assets = fakeAssets();
    const response = await worker.fetch(request(route), { ASSETS: assets.binding });
    assert.equal(response.status, 200, route);
    assert.match(response.headers.get('content-type'), /text\/html/, route);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate', route);
    assert.equal(assets.requests.at(-1).pathname, '/index.html', route);
  }
});

function pipelineEnv() { return { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service' }; }
function editorFetch(calls, rpc = { job: { id: '123e4567-e89b-12d3-a456-426614174000' }, duplicate: false }) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).includes('/auth/v1/user')) return Response.json({ id: '123e4567-e89b-12d3-a456-426614174000' });
    if (String(url).includes('/rest/v1/profiles')) return Response.json([{ id: '123e4567-e89b-12d3-a456-426614174000', role: 'editor' }]);
    if (String(url).includes('/rpc/')) return Response.json(rpc);
    return new Response('unexpected', { status: 500 });
  };
}

test('pipeline submission requires an authenticated editor and uses server-side RPC', async () => {
  const unauthenticated = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', body: '{}' }), pipelineEnv(), async () => { throw new Error('must not fetch'); });
  assert.equal(unauthenticated.status, 401);

  const calls = [];
  const response = await handlePipelineApi(request('/api/newsroom/pipeline/jobs', { method: 'POST', headers: { authorization: 'Bearer session', 'content-type': 'application/json' }, body: JSON.stringify({ job_type: 'process_candidate', candidate_id: 'a'.repeat(64), priority: 75 }) }), pipelineEnv(), editorFetch(calls));
  assert.equal(response.status, 201);
  const rpc = calls.find(call => call.url.includes('/rpc/submit_newsroom_pipeline_job'));
  assert.ok(rpc);
  assert.match(rpc.init.headers.authorization, /^Bearer service$/);
  assert.deepEqual(JSON.parse(rpc.init.body), { p_job_type: 'process_candidate', p_parameters: { candidate_id: 'a'.repeat(64) }, p_priority: 75, p_requested_by: '123e4567-e89b-12d3-a456-426614174000' });
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
  for (const [from, to] of [['/sections/anyways', '/sections/internet'], ['/topics/internet-culture', '/topics/subcultures'], ['/topics/business', '/sections/systems']]) {
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

  const configAssets = fakeAssets();
  const config = await worker.fetch(request('/config.js'), { ASSETS: configAssets.binding });
  assert.equal(config.headers.get('cache-control'), 'no-cache, no-store, must-revalidate');

  const imageAssets = fakeAssets();
  const image = await worker.fetch(request('/photos/p01.jpg'), { ASSETS: imageAssets.binding });
  assert.equal(image.headers.get('cache-control'), 'public, max-age=604800, stale-while-revalidate=86400');
});

test('security headers cover assets, route shells, and errors', async () => {
  for (const path of ['/app.js', '/stories/an-example', '/missing.js']) {
    const assets = fakeAssets();
    const response = await worker.fetch(request(path), { ASSETS: assets.binding });
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'/, path);
    assert.match(csp, /https:\/\/fonts\.googleapis\.com/, path);
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
