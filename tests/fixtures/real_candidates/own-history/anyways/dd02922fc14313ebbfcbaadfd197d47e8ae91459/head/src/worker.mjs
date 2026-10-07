const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-elem 'self' https://fonts.googleapis.com",
  "style-src-attr 'none'",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "media-src 'self' https:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
  "manifest-src 'self'",
  "worker-src 'none'"
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Origin-Agent-Cluster': '?1',
  'Permissions-Policy': 'accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'X-Frame-Options': 'DENY',
  'X-Permitted-Cross-Domain-Policies': 'none'
};

const PUBLIC_SLUG_ROUTE = /^\/(?:sections|stories|topics)\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/;
const NEWSROOM_STORY_ROUTE = /^\/newsroom\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
const IMAGE_ASSET = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;

function isSpaRoute(pathname) {
  return pathname === '/'
    || pathname === '/search'
    || pathname === '/topics'
    || pathname === '/newsroom'
    || pathname === '/newsroom/'
    || pathname === '/newsroom/new'
    || PUBLIC_SLUG_ROUTE.test(pathname)
    || NEWSROOM_STORY_ROUTE.test(pathname);
}

function cacheControlFor(url, response) {
  const contentType = response.headers.get('content-type') || '';
  if (response.status >= 400) return 'no-store';
  if (contentType.includes('text/html') || url.pathname === '/config.js') {
    return 'no-cache, no-store, must-revalidate';
  }
  if (IMAGE_ASSET.test(url.pathname)) {
    return 'public, max-age=604800, stale-while-revalidate=86400';
  }
  return 'public, max-age=0, must-revalidate';
}

function withResponseHeaders(response, request) {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  if (url.protocol === 'https:') {
    headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  } else {
    headers.delete('Strict-Transport-Security');
  }

  const cacheControl = cacheControlFor(url, response);
  headers.set('Cache-Control', cacheControl);
  if (cacheControl.includes('no-store')) {
    headers.set('Expires', '0');
    headers.set('Pragma', 'no-cache');
  } else {
    headers.delete('Expires');
    headers.delete('Pragma');
  }

  const isHead = request.method === 'HEAD';
  if (isHead) headers.delete('Content-Length');
  return new Response(isHead ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function textResponse(request, status, body, extraHeaders = {}) {
  const response = new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders
    }
  });
  return withResponseHeaders(response, request);
}

async function fetchAsset(request, env) {
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    throw new Error('ASSETS binding is unavailable');
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(request, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    const url = new URL(request.url);
    try {
      const asset = await fetchAsset(request, env);
      if (asset.status !== 404) return withResponseHeaders(asset, request);

      if (!isSpaRoute(url.pathname)) {
        return textResponse(request, 404, 'Not Found');
      }

      const shellUrl = new URL(request.url);
      shellUrl.pathname = '/index.html';
      shellUrl.search = '';
      const shellRequest = new Request(shellUrl, request);
      const shell = await fetchAsset(shellRequest, env);
      if (shell.status === 404) {
        return textResponse(request, 503, 'Service Unavailable');
      }
      return withResponseHeaders(shell, request);
    } catch (error) {
      console.error('Static asset request failed', error);
      return textResponse(request, 503, 'Service Unavailable');
    }
  }
};
