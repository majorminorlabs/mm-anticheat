import { validateNewsroomJobRequest } from './newsroom-pipeline-controls.mjs';

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
  "img-src 'self' data: blob: https:",
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
const NEWSROOM_PIPELINE_REVIEW_ROUTE = /^\/newsroom\/review(?:\/[0-9a-f-]+)?\/?$/i;
const NEWSROOM_PIPELINE_ROUTE = /^\/newsroom\/pipeline(?:\/jobs\/[0-9a-f-]{36})?\/?$/i;
const NEWSROOM_ANALYTICS_ROUTE = /^\/newsroom\/analytics\/?$/i;
const NEWSROOM_COLLECTION_ROUTE = /^\/newsroom\/(?:pitches|stories|published|settings)\/?$/i;
const IMAGE_ASSET = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
const ANALYTICS_EVENT_TYPES = new Set(['page_view', 'engaged', 'scroll', 'outbound']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TAXONOMY_REDIRECTS = new Map([
  ['/sections/anyways', '/sections/internet'], ['/sections/worth-your-time', '/sections/taste'],
  ['/sections/we-read-it', '/sections/systems'], ['/sections/receipts', '/sections/media'],
  ['/sections/meanwhile', '/sections/internet'], ['/sections/research', '/sections/systems'],
  ['/topics/internet-culture', '/topics/subcultures'], ['/topics/technology', '/sections/systems'],
  ['/topics/business', '/sections/systems'], ['/topics/markets', '/sections/systems'],
  ['/topics/blockchain', '/sections/systems'], ['/topics/creators', '/sections/media'],
  ['/topics/politics', '/sections/media']
]);

function isSpaRoute(pathname) {
  return pathname === '/'
    || pathname === '/search'
    || pathname === '/topics'
    || pathname === '/newsroom'
    || pathname === '/newsroom/'
    || pathname === '/newsroom/new'
    || pathname === '/newsroom/assignment'
    || pathname === '/newsroom/on-deck'
    || NEWSROOM_COLLECTION_ROUTE.test(pathname)
    || NEWSROOM_ANALYTICS_ROUTE.test(pathname)
    || NEWSROOM_PIPELINE_ROUTE.test(pathname)
    || NEWSROOM_PIPELINE_REVIEW_ROUTE.test(pathname)
    || PUBLIC_SLUG_ROUTE.test(pathname)
    || NEWSROOM_STORY_ROUTE.test(pathname);
}

function cacheControlFor(url, response) {
  const contentType = response.headers.get('content-type') || '';
  if (response.status >= 400 || url.pathname.startsWith('/api/')) return 'no-store';
  if (contentType.includes('text/html') || url.pathname === '/config.js') {
    return 'no-cache, no-store, must-revalidate';
  }
  if (IMAGE_ASSET.test(url.pathname)) {
    return 'public, max-age=604800, stale-while-revalidate=86400';
  }
  return 'public, max-age=0, must-revalidate';
}

function jsonResponse(request, status, payload) {
  return withResponseHeaders(new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } }), request);
}

function apiError(request, status, message, code = 'REQUEST_FAILED') {
  return jsonResponse(request, status, { error: { code, message } });
}

function apiEnv(env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY || !env?.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: String(env.SUPABASE_URL).replace(/\/$/, ''), anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

async function supabaseJson(fetchImpl, url, init, label) {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.msg || `${label} failed`), { status: response.status, code: data?.code || 'SUPABASE_REQUEST_FAILED' });
  return data;
}

async function newsroomActor(request, env, fetchImpl) {
  const config = apiEnv(env);
  if (!config) throw Object.assign(new Error('Pipeline controls are not configured on this deployment.'), { status: 503, code: 'PIPELINE_UNAVAILABLE' });
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer\s+[^\s]+$/i.test(authorization)) throw Object.assign(new Error('Sign in to the Newsroom before using pipeline controls.'), { status: 401, code: 'UNAUTHENTICATED' });
  const user = await supabaseJson(fetchImpl, `${config.url}/auth/v1/user`, { headers: { apikey: config.anonKey, authorization } }, 'Session validation');
  const profileRows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=id,role`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Profile lookup');
  const profile = Array.isArray(profileRows) ? profileRows[0] : null;
  if (!profile || !['admin', 'editor'].includes(profile.role)) throw Object.assign(new Error('An editor account is required for pipeline controls.'), { status: 403, code: 'EDITOR_REQUIRED' });
  return { config, profile };
}

async function pipelineRpc(fetchImpl, config, name, payload) {
  return supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  }, 'Pipeline request');
}

async function requestJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 16384) throw Object.assign(new Error('The pipeline request is too large.'), { status: 413, code: 'REQUEST_TOO_LARGE' });
  try { return await request.json(); } catch { throw Object.assign(new Error('Send a valid JSON request.'), { status: 400, code: 'INVALID_JSON' }); }
}

function validateSubmission(value) {
  const request = value?.parameters && typeof value.parameters === 'object' && !Array.isArray(value.parameters)
    ? { ...value.parameters, job_type: value.job_type, priority: value.priority }
    : value;
  try { return validateNewsroomJobRequest(request); }
  catch (error) { throw Object.assign(error, { status: 400, code: 'INVALID_PARAMETERS' }); }
}

function analyticsText(value, max = 180) {
  return String(value || '').trim().slice(0, max);
}

function validateAnalyticsEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Send a valid analytics event.'), { status: 400, code: 'INVALID_ANALYTICS_EVENT' });
  const eventType = analyticsText(value.event_type, 32);
  const sessionId = analyticsText(value.session_id, 36);
  const path = analyticsText(value.path, 180);
  const referrerHost = analyticsText(value.referrer_host, 180).toLowerCase();
  const detail = analyticsText(value.detail, 180);
  const eventValue = value.event_value === undefined || value.event_value === null ? null : Number(value.event_value);
  if (!ANALYTICS_EVENT_TYPES.has(eventType) || !UUID.test(sessionId) || !/^\/[^\s]*$/.test(path) || path.startsWith('/newsroom') || (referrerHost && /[\/:@?]/.test(referrerHost)) || (eventValue !== null && (!Number.isInteger(eventValue) || eventValue < 0 || eventValue > 86400))) {
    throw Object.assign(new Error('That analytics event is not valid.'), { status: 400, code: 'INVALID_ANALYTICS_EVENT' });
  }
  if (eventType === 'scroll' && (eventValue === null || eventValue > 100)) throw Object.assign(new Error('Scroll depth must be between 0 and 100.'), { status: 400, code: 'INVALID_ANALYTICS_EVENT' });
  return { event_type: eventType, session_id: sessionId, path, referrer_host: referrerHost || null, event_value: eventValue, detail: detail || null };
}

export async function handleAnalyticsApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/analytics/events') return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const config = apiEnv(env);
    if (!config) throw Object.assign(new Error('Analytics intake is not configured on this deployment.'), { status: 503, code: 'ANALYTICS_UNAVAILABLE' });
    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) throw Object.assign(new Error('Analytics events must come from this site.'), { status: 403, code: 'INVALID_ORIGIN' });
    const event = validateAnalyticsEvent(await requestJson(request));
    await supabaseJson(fetchImpl, `${config.url}/rest/v1/analytics_events`, {
      method: 'POST',
      headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify(event)
    }, 'Analytics event');
    return jsonResponse(request, 202, { accepted: true });
  } catch (error) {
    return apiError(request, Number(error?.status) || 400, error instanceof Error ? error.message : 'Analytics event rejected.', error?.code || 'ANALYTICS_REQUEST_FAILED');
  }
}

export async function handlePipelineApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const submit = url.pathname === '/api/newsroom/pipeline/jobs';
  const action = url.pathname.match(/^\/api\/newsroom\/pipeline\/jobs\/([0-9a-f-]{36})\/(cancel|retry|reorder)$/i);
  const solAction = url.pathname.match(/^\/api\/newsroom\/pipeline\/sol-polish\/([0-9a-f-]{36})\/(accept|reject|restore)$/i);
  if (!submit && !action && !solAction) return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    if (solAction) {
      const [, artifactId, operation] = solAction;
      const result = await pipelineRpc(fetchImpl, config, 'apply_pipeline_sol_polish_action', { p_artifact_id: artifactId, p_action: operation, p_actor: profile.id });
      return jsonResponse(request, 200, result);
    }
    if (submit) {
      const job = validateSubmission(await requestJson(request));
      if (job.job_type === 'run_editorial_batch') {
        const result = await pipelineRpc(fetchImpl, config, 'submit_editorial_batch', {
          p_requested_by: profile.id,
          p_requested_focus_id: job.parameters.focus_id,
          p_section_id: job.parameters.section_id,
          p_story_form: job.parameters.story_form,
          p_target_count: job.parameters.target_count
        });
        return jsonResponse(request, 201, { batch: result, duplicate: false });
      }
      if (job.job_type === 'enrich_discovery_candidate') {
        const result = await pipelineRpc(fetchImpl, config, 'submit_discovery_pitch_enrichment', {
          p_candidate_external_id: job.parameters.candidate_id,
          p_priority: job.priority,
          p_requested_by: profile.id
        });
        return jsonResponse(request, result?.duplicate ? 200 : 201, result);
      }
      if (job.job_type === 'process_candidate') {
        const authorization = job.parameters.authorization || null;
        const v1Requested = job.parameters.pipeline_version === 'v1';
        const assignmentRpc = v1Requested && job.parameters.writer;
        const rpc = authorization === 'research_again'
          ? 'research_again_pipeline_v1'
          : authorization === 'replay_from_stage' ? 'replay_pipeline_v1_stage'
          : assignmentRpc ? 'commission_editorial_pitch_v1_with_assignment' : v1Requested ? 'commission_editorial_pitch_v1_with_decision' : 'commission_editorial_pitch';
        const result = await pipelineRpc(fetchImpl, config, rpc, {
          p_candidate_external_id: job.parameters.candidate_id,
          p_priority: job.priority,
          p_requested_by: profile.id,
          ...(rpc === 'commission_editorial_pitch_v1_with_decision' || rpc === 'commission_editorial_pitch_v1_with_assignment' ? { p_research_requirement: job.parameters.research_requirement || null, p_research_requirement_reason: job.parameters.research_requirement_reason || null } : {}),
          ...(rpc === 'commission_editorial_pitch_v1_with_assignment' || rpc === 'research_again_pipeline_v1' || rpc === 'replay_pipeline_v1_stage' ? { p_writer: job.parameters.writer || null, p_length: job.parameters.length || null } : {}),
          ...(rpc === 'replay_pipeline_v1_stage' ? { p_stage: job.parameters.replay_from_stage, p_parent_run_id: job.parameters.parent_run_id, p_replay_attempt_id: job.parameters.replay_attempt_id || null } : {})
        });
        if (rpc === 'commission_editorial_pitch_v1_with_decision' || rpc === 'commission_editorial_pitch_v1_with_assignment' || rpc === 'replay_pipeline_v1_stage') return jsonResponse(request, 201, { job: { id: result }, duplicate: false });
        return jsonResponse(request, result?.duplicate ? 200 : 201, result);
      }
      if (job.job_type === 'polish_candidate') {
        if (job.parameters.pipeline_version !== 'v1' || !/^(1|true|yes)$/i.test(String(env.PIPELINE_V1_ENABLED || ''))) throw Object.assign(new Error('Pipeline V1 is disabled.'), { status: 409, code: 'PIPELINE_V1_DISABLED' });
        const result = await pipelineRpc(fetchImpl, config, 'authorize_pipeline_v1_sol_polish', { p_candidate_external_id: job.parameters.candidate_id, p_priority: job.priority, p_requested_by: profile.id, p_pipeline_v1_enabled: true });
        return jsonResponse(request, result?.duplicate ? 200 : 201, result);
      }
      if (job.job_type === 'create_editorial_pitch') {
        const result = await pipelineRpc(fetchImpl, config, 'submit_focused_editorial_pitch', { p_parameters: job.parameters, p_priority: job.priority, p_requested_by: profile.id });
        return jsonResponse(request, result?.duplicate ? 200 : 201, result);
      }
      const result = await pipelineRpc(fetchImpl, config, 'submit_newsroom_pipeline_job', { p_job_type: job.job_type, p_parameters: job.parameters, p_priority: job.priority, p_requested_by: profile.id });
      return jsonResponse(request, result?.duplicate ? 200 : 201, result);
    }
    const [, jobId, operation] = action;
    if (operation === 'reorder') {
      const body = await requestJson(request);
      if (!['next', 'up', 'down', 'bottom', 'priority'].includes(body?.action) || (body.action === 'priority' && !['urgent', 'high', 'normal', 'low'].includes(body.priority))) throw Object.assign(new Error('Choose a valid queue action.'), { status: 400, code: 'INVALID_QUEUE_ACTION' });
      const result = await pipelineRpc(fetchImpl, config, 'reorder_newsroom_pipeline_job', { p_job_id: jobId, p_action: body.action, p_priority: body.priority || null, p_requested_by: profile.id });
      return jsonResponse(request, 200, result);
    }
    const result = await pipelineRpc(fetchImpl, config, operation === 'cancel' ? 'cancel_newsroom_pipeline_job' : 'retry_newsroom_pipeline_job', operation === 'cancel'
      ? { p_job_id: jobId, p_requested_by: profile.id }
      : { p_job_id: jobId, p_priority: 50, p_requested_by: profile.id });
    return jsonResponse(request, 200, result);
  } catch (error) {
    const status = Number(error?.status) || (error?.code === 'UNAUTHENTICATED' ? 401 : error?.code === 'EDITOR_REQUIRED' ? 403 : 400);
    return apiError(request, status, error instanceof Error ? error.message : 'Pipeline request failed.', error?.code || 'PIPELINE_REQUEST_FAILED');
  }
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

const xml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));

async function sitemapResponse(request, env, fetchImpl = fetch) {
  const origin = new URL(request.url).origin;
  const urls = [{ loc: `${origin}/`, lastmod: null }];
  const config = apiEnv(env);
  if (config) {
    try {
      const query = new URLSearchParams({ select: 'slug,updated_at,published_at', status: 'eq.published', published_at: `lte.${new Date().toISOString()}` });
      const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/stories?${query}`, {
        headers: { apikey: config.anonKey, authorization: `Bearer ${config.anonKey}` }
      }, 'Sitemap stories');
      for (const story of Array.isArray(rows) ? rows : []) {
        if (story?.slug) urls.push({ loc: `${origin}/stories/${encodeURIComponent(story.slug)}`, lastmod: story.updated_at || story.published_at || null });
      }
    } catch (error) {
      console.error('Sitemap story lookup failed', error);
    }
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(entry => `<url><loc>${xml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${xml(new Date(entry.lastmod).toISOString())}</lastmod>` : ''}</url>`).join('')}</urlset>`;
  return withResponseHeaders(new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }), request);
}

async function fetchAsset(request, env) {
  if (!env?.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    throw new Error('ASSETS binding is unavailable');
  }
  return env.ASSETS.fetch(request);
}

export async function publishDueStories(env, fetchImpl = fetch) {
  const config = apiEnv(env);
  if (!config) throw new Error('Scheduled publishing is not configured on this deployment.');
  const result = await supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/publish_due_stories`, {
    method: 'POST',
    headers: {
      apikey: config.serviceKey,
      authorization: `Bearer ${config.serviceKey}`,
      'content-type': 'application/json'
    },
    body: '{}'
  }, 'Scheduled publishing');
  return Array.isArray(result) ? result : [];
}

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishDueStories(env));
  },
  async fetch(request, env) {
    const analytics = await handleAnalyticsApi(request, env);
    if (analytics) return analytics;
    const api = await handlePipelineApi(request, env);
    if (api) return api;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(request, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    const url = new URL(request.url);
    if (url.pathname === '/sitemap.xml') return sitemapResponse(request, env);
    const redirect = LEGACY_TAXONOMY_REDIRECTS.get(url.pathname.replace(/\/$/, ''));
    if (redirect) return withResponseHeaders(new Response(null, { status: 308, headers: { Location: redirect + url.search } }), request);
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
