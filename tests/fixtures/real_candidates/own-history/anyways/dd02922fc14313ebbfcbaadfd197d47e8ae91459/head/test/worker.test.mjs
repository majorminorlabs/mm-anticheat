import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

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
    '/topics/internet-culture',
    '/sections/worth-your-time',
    '/stories/an-example',
    '/newsroom',
    '/newsroom/new',
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
