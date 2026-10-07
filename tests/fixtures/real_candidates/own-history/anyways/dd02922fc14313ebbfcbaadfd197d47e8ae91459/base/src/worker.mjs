const APP_CACHE_REV = '84d4179';

async function freshHtml(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-cache, no-store, must-revalidate');
  const html = await response.text();
  const body = html.replaceAll('src="/app.js"', `src="/app.js?rev=${APP_CACHE_REV}"`);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return freshHtml(asset);
    return freshHtml(await env.ASSETS.fetch(new Request(new URL('/index.html', request.url))));
  }
};
