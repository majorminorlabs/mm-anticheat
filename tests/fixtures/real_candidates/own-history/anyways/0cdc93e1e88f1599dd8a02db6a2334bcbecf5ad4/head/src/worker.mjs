import { validateNewsroomJobRequest } from './newsroom-pipeline-controls.mjs';
import { canonicalizeUrl, duplicateEvent, fetchSource, freshnessPolicyFromSettings, isSafeFetchUrl, normalizeEvent, sourceEventFreshness } from './source-ingestion.mjs';
import { cacheMediaAsset, derivativePlans, heroEligibility, normalizeSourceEventMedia } from './media-pipeline.mjs';
import { X_SCOUT_INTERVAL_MINUTES, X_SCOUT_MODEL, X_SCOUT_WINDOW_HOURS, searchXBlindSpots, xScoutEventTitle } from './x-blind-spot-scout.mjs';
import { PUBLIC_HOME_LIMIT, PUBLIC_PAGE_LIMIT, PUBLIC_SEARCH_LIMIT, PUBLIC_STORY_LIST_SELECT, PUBLIC_STORY_SELECT, cleanPublicQuery, clampPublicLimit, decodePublicCursor, encodePublicCursor, normalizePublicStories, normalizePublicStory, publicSectionPath, publicStoryPath, publicTopicPath } from './public-contract.mjs';
import { renderTrustPage, trustPage, trustPageSlugs } from './trust-pages.mjs';
import { renderArticle } from './article-renderer.mjs';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "frame-src 'self' https://www.youtube.com https://www.youtube-nocookie.com https://platform.twitter.com",
  "form-action 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self'",
  "style-src-elem 'self'",
  /* JS-driven motion (reading progress, parallax drift) writes style props
     from rAF handlers; attributes in markup itself stay authored in CSS. */
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
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

const DEFAULT_CANONICAL_ORIGIN = 'https://anyways.media';
const PUBLIC_ROUTE_PATHS = new Set(['/about', '/standards', '/corrections', '/ai-policy', '/privacy', '/terms', '/accessibility', '/contact', '/ownership']);
const FINGERPRINTED_ASSET = /\/assets\/(?:[a-z0-9-]+\.)[a-f0-9]{8,}\.[a-z0-9]+$/i;
const PUBLIC_API_PATH = /^\/api\/public(?:\/|$)/;
const PUBLIC_PAGE_PATH = /^\/(?:latest|search|topics(?:\/[^/]+)?|sections\/[^/]+|stories\/[^/]+)?\/?$/;
const ANALYTICS_MAX_BODY_BYTES = 16 * 1024;
const ANALYTICS_RATE_WINDOW_MS = 60 * 1000;
const analyticsRateBuckets = new Map();

const PUBLIC_SLUG_ROUTE = /^\/(?:sections|stories|topics)\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/;
const NEWSROOM_STORY_ROUTE = /^\/newsroom\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i;
const NEWSROOM_PIPELINE_REVIEW_ROUTE = /^\/newsroom\/review(?:\/[^/]+)?\/?$/i;
const NEWSROOM_PIPELINE_ROUTE = /^\/newsroom\/pipeline(?:\/jobs\/[0-9a-f-]{36})?\/?$/i;
const NEWSROOM_ANALYTICS_ROUTE = /^\/newsroom\/analytics\/?$/i;
const NEWSROOM_COLLECTION_ROUTE = /^\/newsroom\/(?:pitches|stories|published|homepage|ideas|settings|editorial-candidates)\/?$/i;
const IMAGE_ASSET = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
const ANALYTICS_EVENT_TYPES = new Set(['page_view', 'engaged', 'scroll', 'outbound', 'share', 'performance']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TAXONOMY_REDIRECTS = new Map([
  ['/sections/digital-collectibles', '/sections/nfts'],
  ['/sections/anyways', '/sections/culture'], ['/sections/worth-your-time', '/sections/culture'],
  ['/sections/we-read-it', '/sections/products'], ['/sections/receipts', '/sections/culture'],
  ['/sections/meanwhile', '/sections/culture'], ['/sections/research', '/sections/products'],
  ['/topics/internet-culture', '/topics/communities'], ['/topics/technology', '/sections/products'],
  ['/topics/business', '/sections/products'], ['/topics/markets', '/sections/markets'], ['/topics/blockchain', '/sections/chains'],
  ['/topics/creators', '/sections/culture'], ['/topics/politics', '/sections/culture']
]);

function isSpaRoute(pathname) {
  return pathname === '/'
    || pathname === '/latest'
    || pathname === '/search'
    || pathname === '/topics'
    || pathname === '/newsroom'
    || pathname === '/newsroom/'
    || pathname === '/newsroom/new'
    || pathname === '/newsroom/assignment'
    || pathname === '/newsroom/on-deck'
    || pathname === '/newsroom/ideas'
    || NEWSROOM_COLLECTION_ROUTE.test(pathname)
    || NEWSROOM_ANALYTICS_ROUTE.test(pathname)
    || NEWSROOM_PIPELINE_ROUTE.test(pathname)
    || NEWSROOM_PIPELINE_REVIEW_ROUTE.test(pathname)
    || PUBLIC_SLUG_ROUTE.test(pathname)
    || NEWSROOM_STORY_ROUTE.test(pathname)
    || PUBLIC_ROUTE_PATHS.has(pathname);
}

function cacheControlFor(url, response) {
  const contentType = response.headers.get('content-type') || '';
  if (response.status >= 400) return 'no-store';
  if (PUBLIC_API_PATH.test(url.pathname)) {
    return 'public, max-age=30, s-maxage=300, stale-while-revalidate=86400';
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/newsroom')) return 'no-store';
  if (contentType.includes('text/html')) {
    return 'public, max-age=60, s-maxage=300, stale-while-revalidate=86400';
  }
  if (url.pathname === '/sitemap.xml' || url.pathname === '/feed.xml' || url.pathname === '/feed.json') {
    return 'public, max-age=300, s-maxage=900, stale-while-revalidate=86400';
  }
  if (url.pathname === '/robots.txt') return 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';
  if (url.pathname === '/config.js') return 'no-store';
  if (FINGERPRINTED_ASSET.test(url.pathname)) return 'public, max-age=31536000, immutable';
  if (IMAGE_ASSET.test(url.pathname)) {
    return 'public, max-age=604800, stale-while-revalidate=86400';
  }
  return 'public, max-age=0, must-revalidate';
}

function jsonResponse(request, status, payload, extraHeaders = {}) {
  return withResponseHeaders(new Response(request.method === 'HEAD' ? null : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders } }), request);
}

function apiError(request, status, message, code = 'REQUEST_FAILED') {
  return jsonResponse(request, status, { error: { code, message } });
}

function apiEnv(env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY || !env?.SUPABASE_SERVICE_ROLE_KEY) return null;
  return { url: String(env.SUPABASE_URL).replace(/\/$/, ''), anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY };
}

function publicApiEnv(env) {
  if (!env?.SUPABASE_URL || !env?.SUPABASE_ANON_KEY) return null;
  return { url: String(env.SUPABASE_URL).replace(/\/$/, ''), anonKey: String(env.SUPABASE_ANON_KEY) };
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

async function boundedBodyText(request, message = 'The request is too large.') {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > ANALYTICS_MAX_BODY_BYTES) throw Object.assign(new Error(message), { status: 413, code: 'REQUEST_TOO_LARGE' });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > ANALYTICS_MAX_BODY_BYTES) throw Object.assign(new Error(message), { status: 413, code: 'REQUEST_TOO_LARGE' });
  return new TextDecoder().decode(bytes);
}

async function requestJson(request) {
  try { return JSON.parse(await boundedBodyText(request, 'The pipeline request is too large.')); }
  catch (error) {
    if (error?.code === 'REQUEST_TOO_LARGE') throw error;
    throw Object.assign(new Error('Send a valid JSON request.'), { status: 400, code: 'INVALID_JSON' });
  }
}

async function optionalRequestJson(request) {
  const text = await boundedBodyText(request, 'The pipeline request is too large.');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error('Send a valid JSON request.'), { status: 400, code: 'INVALID_JSON' }); }
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
  const attribution = name => analyticsText(value[name], 80).toLowerCase();
  const landingPage = analyticsText(value.landing_page || path, 180);
  const fields = ['session_source', 'session_medium', 'session_campaign', 'session_content', 'first_source', 'first_medium', 'first_campaign', 'first_content'];
  const attributionValues = Object.fromEntries(fields.map(name => [name, attribution(name) || null]));
  const eventValue = value.event_value === undefined || value.event_value === null ? null : Number(value.event_value);
  if (!ANALYTICS_EVENT_TYPES.has(eventType) || !UUID.test(sessionId) || !/^\/[^\s]*$/.test(path) || !/^\/[^\s]*$/.test(landingPage) || path.startsWith('/newsroom') || landingPage.startsWith('/newsroom') || (referrerHost && /[\/:@?]/.test(referrerHost)) || Object.values(attributionValues).some(item => item && !/^[a-z0-9._-]+$/.test(item)) || (eventValue !== null && (!Number.isInteger(eventValue) || eventValue < 0 || eventValue > 86400))) {
    throw Object.assign(new Error('That analytics event is not valid.'), { status: 400, code: 'INVALID_ANALYTICS_EVENT' });
  }
  if (eventType === 'scroll' && (eventValue === null || eventValue > 100)) throw Object.assign(new Error('Scroll depth must be between 0 and 100.'), { status: 400, code: 'INVALID_ANALYTICS_EVENT' });
  return { event_type: eventType, session_id: sessionId, path, landing_page: landingPage, referrer_host: referrerHost || null, ...attributionValues, event_value: eventValue, detail: detail || null };
}

function analyticsRateKey(request, event) {
  const origin = request.headers.get('origin') || 'missing-origin';
  return `${origin}:${event.session_id}`;
}

function takeAnalyticsToken(key, now = Date.now(), limit = 30) {
  for (const [bucketKey, bucket] of analyticsRateBuckets) {
    if (now - bucket.startedAt > ANALYTICS_RATE_WINDOW_MS) analyticsRateBuckets.delete(bucketKey);
  }
  const bucket = analyticsRateBuckets.get(key);
  if (!bucket || now - bucket.startedAt > ANALYTICS_RATE_WINDOW_MS) {
    analyticsRateBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

export async function handleAnalyticsApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/analytics/events') return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const config = apiEnv(env);
    if (!config) throw Object.assign(new Error('Analytics intake is not configured on this deployment.'), { status: 503, code: 'ANALYTICS_UNAVAILABLE' });
    const origin = request.headers.get('origin');
    if (origin !== url.origin) throw Object.assign(new Error('Analytics events must come from this site.'), { status: 403, code: 'INVALID_ORIGIN' });
    const event = validateAnalyticsEvent(await requestJson(request));
    if (!takeAnalyticsToken(analyticsRateKey(request, event))) throw Object.assign(new Error('Analytics event budget exceeded for this session.'), { status: 429, code: 'RATE_LIMITED' });
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
  const ideaCommission = url.pathname.match(/^\/api\/newsroom\/ideas\/([0-9a-f-]{36})\/commission$/i);
  if (!submit && !action && !solAction && !ideaCommission) return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    if (solAction) {
      const [, artifactId, operation] = solAction;
      const result = await pipelineRpc(fetchImpl, config, 'apply_pipeline_sol_polish_action', { p_artifact_id: artifactId, p_action: operation, p_actor: profile.id });
      return jsonResponse(request, 200, result);
    }
    if (ideaCommission) {
      const [, ideaId] = ideaCommission;
      const body = await requestJson(request);
      const pitchId = String(body?.pitch_id || '').trim();
      const length = body?.length === undefined || body.length === null || body.length === '' ? null : String(body.length);
      const sourceUrl = String(body?.source_url || '').trim();
      if (!UUID.test(pitchId)) throw Object.assign(new Error('Select a valid idea pitch.'), { status: 400, code: 'INVALID_PARAMETERS' });
      if (length !== null && !['brief', 'standard', 'feature'].includes(length)) throw Object.assign(new Error('Choose a valid internal story length.'), { status: 400, code: 'INVALID_PARAMETERS' });
      let parsedUrl;
      try { parsedUrl = new URL(sourceUrl); } catch { parsedUrl = null; }
      if (!parsedUrl || !['http:', 'https:'].includes(parsedUrl.protocol)) throw Object.assign(new Error('Add a verified http or https primary source before commissioning.'), { status: 400, code: 'INVALID_PARAMETERS' });
      const pitchRows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/editorial_idea_pitches?id=eq.${encodeURIComponent(pitchId)}&idea_id=eq.${encodeURIComponent(ideaId)}&select=id`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Idea pitch lookup');
      if (!Array.isArray(pitchRows) || !pitchRows.length) throw Object.assign(new Error('Idea pitch was not found.'), { status: 404, code: 'NOT_FOUND' });
      await supabaseJson(fetchImpl, `${config.url}/rest/v1/editorial_idea_pitches?id=eq.${encodeURIComponent(pitchId)}&idea_id=eq.${encodeURIComponent(ideaId)}`, {
        method: 'PATCH',
        headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ source_urls: [sourceUrl], primary_source: sourceUrl, status: 'selected', updated_at: new Date().toISOString() })
      }, 'Idea pitch source update');
      const result = await pipelineRpc(fetchImpl, config, 'commission_editorial_idea_pitch', { p_pitch_id: pitchId, p_length: length, p_requested_by: profile.id });
      return jsonResponse(request, 201, result);
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
      if (job.job_type === 'generate_idea_pitches') {
        const result = await pipelineRpc(fetchImpl, config, 'submit_editorial_idea', { p_prompt: job.parameters.prompt, p_priority: job.priority, p_requested_by: profile.id });
        return jsonResponse(request, 201, result);
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

export async function handleEditorialScoringApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const settings = url.pathname === '/api/newsroom/editorial-scoring/settings';
  const backfill = url.pathname === '/api/newsroom/editorial-scoring/backfill';
  const run = url.pathname === '/api/newsroom/editorial-scoring/run';
  const retry = url.pathname.match(/^\/api\/newsroom\/editorial-scoring\/events\/([0-9a-f-]{36})\/retry$/i);
  if (!settings && !backfill && !run && !retry) return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    if (settings) {
      const body = await requestJson(request);
      const model = String(body?.model || '').trim();
      const promptVersion = String(body?.prompt_version || 'discipline_direct_v1').trim();
      const fallbackModel = String(body?.fallback_model || 'qwen3:30b').trim();
      const fallbackPromptVersion = String(body?.fallback_prompt_version || 'discipline_direct_v1').trim();
      const batchSize = Number(body?.batch_size);
      const minimumScore = Number(body?.minimum_score);
      const validPromptVersion = value => ['local-editorial-v4', 'discipline_direct_v1'].includes(value);
      if (!model || model.length > 160 || !validPromptVersion(promptVersion) || !fallbackModel || fallbackModel.length > 160 || !validPromptVersion(fallbackPromptVersion) || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5 || !Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 10 || typeof body?.enabled !== 'boolean') {
        throw Object.assign(new Error('Choose valid local and fallback models, supported prompt versions, a batch size from 1 to 5, a minimum score from 0 to 10, and an enabled state.'), { status: 400, code: 'INVALID_SCORING_SETTINGS' });
      }
      const result = await pipelineRpc(fetchImpl, config, 'save_editorial_scoring_settings_v2', { p_model: model, p_prompt_version: promptVersion, p_fallback_model: fallbackModel, p_fallback_prompt_version: fallbackPromptVersion, p_batch_size: batchSize, p_minimum_score: minimumScore, p_enabled: body.enabled, p_requested_by: profile.id });
      return jsonResponse(request, 200, result);
    }
    if (backfill) {
      const body = await requestJson(request);
      const days = Number(body?.days || 7);
      const limit = Number(body?.limit || 25);
      if (!Number.isInteger(days) || days < 1 || days > 90 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('Backfill days must be 1 to 90 and the limit must be 1 to 100.'), { status: 400, code: 'INVALID_BACKFILL_LIMIT' });
      const result = await pipelineRpc(fetchImpl, config, 'enqueue_editorial_scoring_backfill', { p_after: new Date(Date.now() - days * 86400000).toISOString(), p_limit: limit, p_requested_by: profile.id });
      return jsonResponse(request, 200, { queued: result });
    }
    if (run) {
      const result = await pipelineRpc(fetchImpl, config, 'submit_editorial_scoring_job', { p_requested_by: profile.id });
      return jsonResponse(request, result?.duplicate ? 200 : 201, result);
    }
    if (!UUID.test(retry?.[1] || '')) throw Object.assign(new Error('Event ID is invalid.'), { status: 400, code: 'INVALID_EVENT' });
    const result = await pipelineRpc(fetchImpl, config, 'submit_editorial_scoring_retry', { p_event_id: retry[1], p_requested_by: profile.id });
    return jsonResponse(request, result?.duplicate ? 200 : 201, { retried: result });
  } catch (error) {
    return apiError(request, Number(error?.status) || (error?.code === 'UNAUTHENTICATED' ? 401 : error?.code === 'EDITOR_REQUIRED' ? 403 : 400), error instanceof Error ? error.message : 'Editorial scoring request failed.', error?.code || 'EDITORIAL_SCORING_REQUEST_FAILED');
  }
}

export async function handleLunaEditorialApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const candidateAction = url.pathname.match(/^\/api\/newsroom\/luna-editorial\/candidates\/([0-9a-f-]{36})\/(send|retry|enrich)$/i);
  const settings = url.pathname === '/api/newsroom/luna-editorial/settings';
  if (!candidateAction && !settings) return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    if (settings) {
      const body = await requestJson(request);
      const model = String(body?.model || '').trim();
      const reasoning = String(body?.reasoning || '').trim();
      const minimumScore = Number(body?.minimum_score);
      const recurring = {
        max_candidates_per_run: Number(body?.max_candidates_per_run ?? 3),
        max_calls_per_hour: Number(body?.max_calls_per_hour ?? 6),
        processing_lease_minutes: Number(body?.processing_lease_minutes ?? 45),
        retry_limit: Number(body?.retry_limit ?? 1),
        interval_minutes: Number(body?.interval_minutes ?? 15)
      };
      const enrichment = {
        enabled: body?.enrichment_enabled === true,
        max_attempts: Number(body?.enrichment_max_attempts ?? 1),
        max_urls_per_attempt: Number(body?.enrichment_max_urls_per_attempt ?? 3),
        max_bytes_per_page: Number(body?.enrichment_max_bytes_per_page ?? 524288),
        timeout_ms: Number(body?.enrichment_timeout_ms ?? 8000),
        cooldown_minutes: Number(body?.enrichment_cooldown_minutes ?? 60)
      };
      if (!model || model.length > 160 || !['low', 'medium', 'high'].includes(reasoning) || !Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 10 || typeof body?.enabled !== 'boolean'
        || !Number.isInteger(recurring.max_candidates_per_run) || recurring.max_candidates_per_run < 1 || recurring.max_candidates_per_run > 25
        || !Number.isInteger(recurring.max_calls_per_hour) || recurring.max_calls_per_hour < 1 || recurring.max_calls_per_hour > 60
        || !Number.isInteger(recurring.processing_lease_minutes) || recurring.processing_lease_minutes < 5 || recurring.processing_lease_minutes > 180
        || !Number.isInteger(recurring.retry_limit) || recurring.retry_limit < 0 || recurring.retry_limit > 3
        || !Number.isInteger(recurring.interval_minutes) || recurring.interval_minutes < 5 || recurring.interval_minutes > 60
        || !Number.isInteger(enrichment.max_attempts) || enrichment.max_attempts < 1 || enrichment.max_attempts > 3
        || !Number.isInteger(enrichment.max_urls_per_attempt) || enrichment.max_urls_per_attempt < 1 || enrichment.max_urls_per_attempt > 5
        || !Number.isInteger(enrichment.max_bytes_per_page) || enrichment.max_bytes_per_page < 65536 || enrichment.max_bytes_per_page > 524288
        || !Number.isInteger(enrichment.timeout_ms) || enrichment.timeout_ms < 1000 || enrichment.timeout_ms > 30000
        || !Number.isInteger(enrichment.cooldown_minutes) || enrichment.cooldown_minutes < 5 || enrichment.cooldown_minutes > 1440) {
        throw Object.assign(new Error('Choose a model, reasoning level, minimum score, and enabled state.'), { status: 400, code: 'INVALID_LUNA_SETTINGS' });
      }
      const result = await pipelineRpc(fetchImpl, config, 'save_luna_editorial_settings', { p_model: model, p_reasoning: reasoning, p_minimum_score: minimumScore, p_enabled: body.enabled, p_requested_by: profile.id });
      if (body?.max_candidates_per_run !== undefined || body?.max_calls_per_hour !== undefined || body?.processing_lease_minutes !== undefined || body?.retry_limit !== undefined || body?.interval_minutes !== undefined) {
        await pipelineRpc(fetchImpl, config, 'save_luna_recurring_settings', { p_max_candidates_per_run: recurring.max_candidates_per_run, p_max_calls_per_hour: recurring.max_calls_per_hour, p_processing_lease_minutes: recurring.processing_lease_minutes, p_retry_limit: recurring.retry_limit, p_interval_minutes: recurring.interval_minutes, p_requested_by: profile.id });
      }
      if (body?.enrichment_enabled !== undefined || body?.enrichment_max_attempts !== undefined || body?.enrichment_max_urls_per_attempt !== undefined || body?.enrichment_max_bytes_per_page !== undefined || body?.enrichment_timeout_ms !== undefined || body?.enrichment_cooldown_minutes !== undefined) {
        await pipelineRpc(fetchImpl, config, 'save_luna_enrichment_settings', { p_enabled: enrichment.enabled, p_max_attempts: enrichment.max_attempts, p_max_urls_per_attempt: enrichment.max_urls_per_attempt, p_max_bytes_per_page: enrichment.max_bytes_per_page, p_timeout_ms: enrichment.timeout_ms, p_cooldown_minutes: enrichment.cooldown_minutes, p_requested_by: profile.id });
      }
      return jsonResponse(request, 200, result);
    }
    const [, candidateId, operation] = candidateAction;
    if (!UUID.test(candidateId)) throw Object.assign(new Error('Candidate ID is invalid.'), { status: 400, code: 'INVALID_CANDIDATE' });
    const rpc = operation === 'retry' ? 'retry_luna_editorial_candidate' : operation === 'enrich' ? 'submit_luna_evidence_enrichment' : 'submit_luna_editorial_candidate';
    const result = await pipelineRpc(fetchImpl, config, rpc, { p_candidate_id: candidateId, p_requested_by: profile.id });
    return jsonResponse(request, result?.duplicate ? 200 : 201, result);
  } catch (error) {
    return apiError(request, Number(error?.status) || (error?.code === 'UNAUTHENTICATED' ? 401 : error?.code === 'EDITOR_REQUIRED' ? 403 : 400), error instanceof Error ? error.message : 'Luna editorial request failed.', error?.code || 'LUNA_EDITORIAL_REQUEST_FAILED');
  }
}

export async function handleEditorialAutomationApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (url.pathname !== '/api/newsroom/editorial-automation/settings') return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    const body = await requestJson(request);
    const values = {
      enabled: body?.enabled === true,
      scoring_enabled: body?.scoring_enabled === true,
      enrichment_enabled: body?.enrichment_enabled === true,
      luna_enabled: body?.luna_enabled === true,
      max_scoring_events_per_hour: Number(body?.max_scoring_events_per_hour ?? 20),
      max_scoring_batch_size: Number(body?.max_scoring_batch_size ?? 5),
      max_candidates_per_run: Number(body?.max_candidates_per_run ?? 2),
      max_luna_calls_per_hour: Number(body?.max_luna_calls_per_hour ?? 2),
      max_enrichment_attempts: Number(body?.max_enrichment_attempts ?? 1),
      max_enrichment_urls_per_attempt: Number(body?.max_enrichment_urls_per_attempt ?? 3),
      processing_lease_minutes: Number(body?.processing_lease_minutes ?? 45),
      retry_limit: Number(body?.retry_limit ?? 1)
    };
    if (!Number.isInteger(values.max_scoring_events_per_hour) || values.max_scoring_events_per_hour < 1 || values.max_scoring_events_per_hour > 20
      || !Number.isInteger(values.max_scoring_batch_size) || values.max_scoring_batch_size < 1 || values.max_scoring_batch_size > 5
      || !Number.isInteger(values.max_candidates_per_run) || values.max_candidates_per_run < 1 || values.max_candidates_per_run > 2
      || !Number.isInteger(values.max_luna_calls_per_hour) || values.max_luna_calls_per_hour < 1 || values.max_luna_calls_per_hour > 2
      || values.max_enrichment_attempts !== 1 || !Number.isInteger(values.max_enrichment_urls_per_attempt) || values.max_enrichment_urls_per_attempt < 1 || values.max_enrichment_urls_per_attempt > 3
      || !Number.isInteger(values.processing_lease_minutes) || values.processing_lease_minutes < 5 || values.processing_lease_minutes > 180
      || !Number.isInteger(values.retry_limit) || values.retry_limit < 0 || values.retry_limit > 1) {
      throw Object.assign(new Error('Automation caps are bounded to the low-volume editorial defaults.'), { status: 400, code: 'INVALID_AUTOMATION_SETTINGS' });
    }
    const result = await pipelineRpc(fetchImpl, config, 'save_editorial_automation_settings', {
      p_enabled: values.enabled,
      p_scoring_enabled: values.scoring_enabled,
      p_enrichment_enabled: values.enrichment_enabled,
      p_luna_enabled: values.luna_enabled,
      p_max_scoring_events_per_hour: values.max_scoring_events_per_hour,
      p_max_scoring_batch_size: values.max_scoring_batch_size,
      p_max_candidates_per_run: values.max_candidates_per_run,
      p_max_luna_calls_per_hour: values.max_luna_calls_per_hour,
      p_max_enrichment_attempts: values.max_enrichment_attempts,
      p_max_enrichment_urls_per_attempt: values.max_enrichment_urls_per_attempt,
      p_processing_lease_minutes: values.processing_lease_minutes,
      p_retry_limit: values.retry_limit,
      p_requested_by: profile.id
    });
    return jsonResponse(request, 200, result);
  } catch (error) {
    return apiError(request, Number(error?.status) || (error?.code === 'UNAUTHENTICATED' ? 401 : error?.code === 'EDITOR_REQUIRED' ? 403 : 400), error instanceof Error ? error.message : 'Editorial automation settings could not be saved.', error?.code || 'EDITORIAL_AUTOMATION_SETTINGS_FAILED');
  }
}

function canonicalOrigin(env, url = new URL('https://anyways.media/')) {
  const configured = String(env?.CANONICAL_ORIGIN || '').trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.origin;
    } catch {}
  }
  /* Test and preview hosts stay local unless the deployment explicitly opts
     into the production origin. The two public production hostnames always
     collapse to the apex. */
  if (['anyways.media', 'www.anyways.media'].includes(url.hostname.toLowerCase())) return DEFAULT_CANONICAL_ORIGIN;
  return url.origin;
}

function canonicalRedirect(request, env) {
  const url = new URL(request.url);
  const origin = canonicalOrigin(env, url);
  const target = new URL(url.href);
  target.protocol = 'https:';
  target.host = new URL(origin).host;
  if (url.protocol === 'https:' && url.host === target.host) return null;
  return withResponseHeaders(new Response(null, {
    status: 308,
    headers: { Location: `${target.origin}${target.pathname}${target.search}${target.hash}`, 'Cache-Control': 'public, max-age=86400' }
  }), request);
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

  if (url.pathname.startsWith('/newsroom') || url.pathname.startsWith('/api/')) {
    headers.set('X-Robots-Tag', 'noindex, nofollow');
  } else if (response.status >= 400 || url.pathname === '/search' || url.searchParams.has('q') || url.searchParams.has('section') || url.searchParams.has('topic')) {
    headers.set('X-Robots-Tag', 'noindex, follow');
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
  const response = new Response(request.method === 'HEAD' ? null : body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      ...extraHeaders
    }
  });
  return withResponseHeaders(response, request);
}

const xml = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const html = value => String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));

function metaText(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function publicMediaUrl(value, baseUrl) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const resolved = new URL(raw, `${String(baseUrl || '').replace(/\/$/, '')}/`);
    if (resolved.protocol !== 'https:' || resolved.username || resolved.password || resolved.href.length > 2048) return '';
    return resolved.href;
  } catch {
    return '';
  }
}

async function fetchWithDeadline(fetchImpl, url, init = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('deadline exceeded'), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: init.signal || controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function publicSupabaseJson(fetchImpl, config, path, init = {}, label = 'Public data') {
  const response = await fetchWithDeadline(fetchImpl, `${config.url}${path}`, {
    ...init,
    headers: { apikey: config.anonKey, authorization: `Bearer ${config.anonKey}`, ...(init.headers || {}) }
  }, 8000);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw Object.assign(new Error(data?.message || data?.msg || `${label} failed`), { status: response.status, code: data?.code || 'PUBLIC_DATA_FAILED' });
  return data;
}

function publicQuery(params) {
  return new URLSearchParams(params).toString();
}

function publicStoryRows(data) {
  return normalizePublicStories(Array.isArray(data) ? data : []);
}

function publicListStory(story) {
  if (!story) return story;
  const presentation = story.presentation && typeof story.presentation === 'object' ? story.presentation : {};
  return {
    ...story,
    body: '',
    presentation: {
      composition: presentation.composition || 'split',
      accent: presentation.accent || 'auto',
      hero: presentation.hero || null
    }
  };
}

function publicListStories(stories) {
  return (Array.isArray(stories) ? stories : []).map(publicListStory);
}

function publicStoryQuery(extra = {}) {
  return publicQuery({ select: PUBLIC_STORY_SELECT, order: 'published_at.desc,id.asc', ...extra });
}

function publicStoryListQuery(extra = {}) {
  return publicQuery({ select: PUBLIC_STORY_LIST_SELECT, order: 'published_at.desc,id.asc', ...extra });
}

async function publicListRowsByIds(fetchImpl, config, ids) {
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).filter(value => UUID.test(String(value))))];
  if (!cleanIds.length) return [];
  const query = publicStoryListQuery({ id: `in.(${cleanIds.join(',')})` });
  return publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${query}`, {}, 'Published story list projection'));
}

async function publicSections(fetchImpl, config) {
  const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/sections?${publicQuery({ select: 'id,name,slug,template', order: 'name.asc' })}`, {}, 'Public sections');
  return Array.isArray(rows) ? rows : [];
}

async function publicTopics(fetchImpl, config) {
  const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/beats?${publicQuery({ select: 'id,name,slug', order: 'name.asc' })}`, {}, 'Public topics');
  return Array.isArray(rows) ? rows : [];
}

async function publicSources(fetchImpl, config, storyId) {
  if (!UUID.test(String(storyId))) return [];
  const query = publicQuery({ story_id: `eq.${storyId}`, select: 'id,story_id,title,publisher,url,canonical_url,source_type,author,published_at,accessed_at,archive_url,sort_order', order: 'sort_order.asc' });
  const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_story_sources?${query}`, {}, 'Public story sources');
  return (Array.isArray(rows) ? rows : []).map(source => ({ ...source, safe_url: publicMediaUrl(source.canonical_url || source.url, config.url) || publicMediaUrl(source.url, config.url) || publicMediaUrl(source.archive_url, config.url) }));
}

async function publicCorrections(fetchImpl, config, storyId) {
  if (!UUID.test(String(storyId))) return [];
  const query = publicQuery({ story_id: `eq.${storyId}`, select: 'id,story_id,corrected_at,note', order: 'corrected_at.desc' });
  const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_story_corrections?${query}`, {}, 'Public corrections');
  return Array.isArray(rows) ? rows : [];
}

function publicStoryTerms(story) {
  return new Set([
    ...(story?.story_beats || []).flatMap(item => [item?.beats?.slug, item?.beats?.name]),
    ...(story?.story_tags || []).flatMap(item => [item?.tags?.slug, item?.tags?.name])
  ].map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
}

function publicRelatedScore(story, candidate) {
  const sourceTerms = publicStoryTerms(story);
  const candidateTerms = publicStoryTerms(candidate);
  let score = story?.section_id && candidate?.section_id === story.section_id ? 8 : 0;
  for (const term of candidateTerms) if (sourceTerms.has(term)) score += 2;
  const publishedAt = new Date(candidate?.published_at || 0).getTime();
  const age = Number.isFinite(publishedAt) ? Math.max(0, (Date.now() - publishedAt) / 86400000) : 365;
  return score + Math.max(0, 1 - Math.min(age, 365) / 365);
}

async function publicRelated(fetchImpl, config, story) {
  const storyId = story?.id;
  if (!UUID.test(String(storyId))) return [];
  let curated = [];
  try {
    const links = await publicSupabaseJson(fetchImpl, config, `/rest/v1/story_related?${publicQuery({ story_id: `eq.${storyId}`, select: 'related_story_id', limit: '6' })}`, {}, 'Related story links');
    curated = await publicListRowsByIds(fetchImpl, config, (Array.isArray(links) ? links : []).map(link => link.related_story_id));
  } catch (error) {
    console.warn('Curated related stories unavailable', error);
  }
  if (curated.length >= 6) return curated.slice(0, 6);
  const selected = new Map(curated.map(item => [item.id, item]));
  const query = publicStoryListQuery({
    ...(story.section_id ? { section_id: `eq.${story.section_id}` } : {}),
    id: `not.eq.${storyId}`,
    limit: '40'
  });
  try {
    const candidates = publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${query}`, {}, 'Related story fallback'))
      .filter(candidate => candidate.id !== storyId && !selected.has(candidate.id))
      .sort((left, right) => publicRelatedScore(story, right) - publicRelatedScore(story, left));
    for (const candidate of candidates) {
      selected.set(candidate.id, candidate);
      if (selected.size >= 6) break;
    }
  } catch (error) {
    console.warn('Related story fallback unavailable', error);
  }
  return [...selected.values()].slice(0, 6);
}

function parseCursor(value) {
  const raw = decodePublicCursor(value);
  if (!raw) return null;
  const [publishedAt, id] = raw.split('|');
  if (!publishedAt || !UUID.test(String(id)) || !Number.isFinite(new Date(publishedAt).getTime())) return null;
  return { publishedAt, id };
}

function nextPublicCursor(stories, limit) {
  if (!stories.length || stories.length < limit) return null;
  const last = stories.at(-1);
  return encodePublicCursor(`${new Date(last.published_at).toISOString()}|${last.id}`);
}

async function publicSearch(fetchImpl, config, queryValue, sectionId, limit, offset = 0) {
  const query = cleanPublicQuery(queryValue);
  if (!query) return { results: [], next_cursor: null };
  const boundedOffset = Number.isInteger(Number(offset)) ? Math.min(1000, Math.max(0, Number(offset))) : 0;
  try {
    const rows = await publicSupabaseJson(fetchImpl, config, '/rest/v1/rpc/search_published_stories', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_query: query, p_section_id: sectionId || null, p_limit: limit, p_offset: boundedOffset })
    }, 'Public search');
    const results = Array.isArray(rows) ? rows.map(row => normalizePublicStory({ ...row, summary: row.summary || row.snippet, body: '' })) : [];
    return { results: publicListStories(results), next_cursor: results.length >= limit ? encodePublicCursor(String(boundedOffset + results.length)) : null };
  } catch (error) {
    /* The migration supplies ranked search. A narrow title/dek fallback keeps
       the public route useful during a rolling schema deployment without
       downloading bodies or the complete archive. */
    const pattern = `*${query.replace(/[*(),]/g, ' ').trim()}*`;
    const filters = [`title.ilike.${pattern}`, `dek.ilike.${pattern}`, `summary.ilike.${pattern}`].join(',');
    const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${publicStoryListQuery({ or: `(${filters})`, ...(sectionId ? { section_id: `eq.${sectionId}` } : {}), limit: String(limit), offset: String(boundedOffset) })}`, {}, 'Public search fallback');
    const results = publicListStories(publicStoryRows(rows));
    return { results, next_cursor: results.length >= limit ? encodePublicCursor(String(boundedOffset + results.length)) : null };
  }
}

async function publicPageData(url, env, fetchImpl = fetch) {
  const config = publicApiEnv(env);
  if (!config) return null;
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  if (pathname === '/api/public') return { status: 404, error: 'Not found' };

  if (pathname === '/') {
    let placements = [];
    try {
      placements = await publicSupabaseJson(fetchImpl, config, '/rest/v1/rpc/get_homepage_story_ids', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_now: new Date().toISOString() }) }, 'Homepage arrangement');
    } catch (error) { console.warn('Homepage arrangement unavailable; using latest fallback', error); }
    const placementRows = Array.isArray(placements) ? placements : [];
    const placed = await publicListRowsByIds(fetchImpl, config, placementRows.map(row => row.story_id));
    const placedById = new Map(placed.map(story => [story.id, story]));
    const lead = placementRows.find(row => row.placement === 'lead')?.story_id ? placedById.get(placementRows.find(row => row.placement === 'lead').story_id) : placed[0];
    const featured = placementRows.filter(row => row.placement === 'homepage').sort((a, b) => a.position - b.position).map(row => placedById.get(row.story_id)).filter(Boolean);
    const latest = publicListStories(publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${publicStoryListQuery({ limit: String(PUBLIC_HOME_LIMIT) })}`, {}, 'Homepage stories')));
    const all = [...new Map([...(lead ? [[lead.id, lead]] : []), ...featured.map(story => [story.id, story]), ...latest.map(story => [story.id, story])]).values()];
    return { status: 200, type: 'home', lead: publicListStory(lead || latest[0] || null), featured: publicListStories(featured), latest: publicListStories(all.slice(0, PUBLIC_HOME_LIMIT)) };
  }

  const storyMatch = pathname.match(/^\/stories\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (storyMatch) {
    const slug = storyMatch[1];
    const query = publicStoryQuery({ slug: `eq.${slug}`, limit: '1' });
    const rows = publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${query}`, {}, 'Published story'));
    if (!rows.length) {
      const redirects = await publicSupabaseJson(fetchImpl, config, `/rest/v1/story_slug_redirects?${publicQuery({ from_slug: `eq.${slug}`, select: 'story_id', limit: '1' })}`, {}, 'Story slug redirect').catch(() => []);
      const target = await publicListRowsByIds(fetchImpl, config, (Array.isArray(redirects) ? redirects : []).map(row => row.story_id));
      if (target[0]?.slug) return { status: 308, redirect: publicStoryPath(target[0].slug) };
      return { status: 404, type: 'not-found', title: 'Story not found' };
    }
    const story = rows[0];
    const [sources, corrections, related] = await Promise.all([
      publicSources(fetchImpl, config, story.id).catch(error => { console.warn('Public sources unavailable', error); return []; }),
      publicCorrections(fetchImpl, config, story.id).catch(error => { console.warn('Public corrections unavailable', error); return []; }),
      publicRelated(fetchImpl, config, story).catch(error => { console.warn('Public related stories unavailable', error); return []; })
    ]);
    return { status: 200, type: 'story', story, sources, corrections, related: publicListStories(related) };
  }

  const sectionMatch = pathname.match(/^\/sections\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (sectionMatch) {
    const sections = await publicSections(fetchImpl, config);
    const section = sections.find(item => item.slug === sectionMatch[1]);
    if (!section) return { status: 404, type: 'not-found', title: 'Section not found' };
    const limit = clampPublicLimit(url.searchParams.get('limit'), PUBLIC_PAGE_LIMIT);
    const cursor = parseCursor(url.searchParams.get('cursor'));
    const extra = { section_id: `eq.${section.id}`, limit: String(limit) };
    if (cursor) extra.or = `(published_at.lt.${cursor.publishedAt},and(published_at.eq.${cursor.publishedAt},id.lt.${cursor.id}))`;
    const stories = publicListStories(publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${publicStoryListQuery(extra)}`, {}, 'Section stories')));
    return { status: 200, type: 'section', section, stories, next_cursor: nextPublicCursor(stories, limit) };
  }

  const topicMatch = pathname.match(/^\/topics\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
  if (topicMatch) {
    const topics = await publicTopics(fetchImpl, config);
    const topic = topics.find(item => item.slug === topicMatch[1]);
    if (!topic) return { status: 404, type: 'not-found', title: 'Topic not found' };
    const links = await publicSupabaseJson(fetchImpl, config, `/rest/v1/story_beats?${publicQuery({ beat_id: `eq.${topic.id}`, select: 'story_id', limit: '100' })}`, {}, 'Topic story links');
    const stories = publicListStories((await publicListRowsByIds(fetchImpl, config, (Array.isArray(links) ? links : []).map(item => item.story_id))).slice(0, PUBLIC_PAGE_LIMIT));
    return { status: 200, type: 'topic', topic, stories, next_cursor: null };
  }

  if (pathname === '/latest') {
    const limit = clampPublicLimit(url.searchParams.get('limit'), PUBLIC_PAGE_LIMIT);
    const cursor = parseCursor(url.searchParams.get('cursor'));
    const extra = { limit: String(limit) };
    if (cursor) extra.or = `(published_at.lt.${cursor.publishedAt},and(published_at.eq.${cursor.publishedAt},id.lt.${cursor.id}))`;
    const stories = publicListStories(publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${publicStoryListQuery(extra)}`, {}, 'Latest stories')));
    return { status: 200, type: 'latest', stories, next_cursor: nextPublicCursor(stories, limit) };
  }

  if (pathname === '/topics') {
    const [topics, stories] = await Promise.all([publicTopics(fetchImpl, config), publicListStories(publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${publicStoryListQuery({ limit: '100' })}`, {}, 'Topic counts')))]);
    const rows = topics.map(topic => ({ topic, count: stories.filter(story => story.story_beats.some(item => item.beats?.slug === topic.slug)).length })).filter(row => row.count);
    return { status: 200, type: 'topics', rows };
  }

  if (pathname === '/search') {
    const query = cleanPublicQuery(url.searchParams.get('q'));
    const section = cleanPublicQuery(url.searchParams.get('section'), 80) || null;
    const rawCursor = decodePublicCursor(url.searchParams.get('cursor'));
    const offset = /^\d+$/.test(rawCursor) ? Number(rawCursor) : 0;
    const [sections, search] = await Promise.all([publicSections(fetchImpl, config), publicSearch(fetchImpl, config, query, section, PUBLIC_SEARCH_LIMIT, offset)]);
    return { status: 200, type: 'search', query, section, sections, results: search.results, next_cursor: search.next_cursor };
  }

  return null;
}

function publicNumberMap(stories) {
  const map = new Map();
  stories.slice().sort((a, b) => new Date(a.published_at) - new Date(b.published_at)).forEach((story, index) => map.set(story.id, index + 1));
  return map;
}

function publicServerImage(story, eager = false) {
  const candidate = story?.presentation?.hero || story?.hero_media;
  const url = publicMediaUrl(candidate?.public_url || candidate?.url || candidate?.original_url, 'https://anyways.media');
  if (!url) return '';
  const width = Number.isInteger(Number(candidate?.width)) && Number(candidate.width) > 0 ? ` width="${Number(candidate.width)}"` : '';
  const height = Number.isInteger(Number(candidate?.height)) && Number(candidate.height) > 0 ? ` height="${Number(candidate.height)}"` : '';
  return `<img src="${html(url)}"${width}${height} alt="${html(candidate?.alt_text || '')}" loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>`;
}

function publicServerCard(story, { eager = false, heading = 'h2' } = {}) {
  if (!story) return '';
  const section = story.sections?.slug ? `<a class="chip" href="${publicSectionPath(story.sections.slug)}">${html(story.sections.name || '')}</a>` : '';
  const image = publicServerImage(story, eager);
  return `<article class="card${image ? ' card--media' : ''}" data-reveal>${image ? `<a class="card-media" href="${publicStoryPath(story.slug)}" tabindex="-1" aria-hidden="true">${image}</a>` : ''}<div class="card-body"><div class="chiprow">${section}<span class="chip chip--quiet">${html(story.article_format || 'News')}</span></div><${heading} class="card-title"><a href="${publicStoryPath(story.slug)}">${html(story.title)}</a></${heading}><p class="card-dek">${html(story.dek)}</p><div class="card-meta mono"><time datetime="${html(story.published_at || '')}">${html(new Date(story.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))}</time><span>${Number(story.reading_time_minutes) || 1} min</span></div></div></article>`;
}

function publicServerIndex(story) {
  return `<li class="indexrow" data-reveal><a class="indexrow-hit" href="${publicStoryPath(story.slug)}"><span class="indexrow-title">${html(story.title)}</span><span class="indexrow-dots" aria-hidden="true"></span><span class="indexrow-meta mono"><time datetime="${html(story.published_at || '')}">${html(new Date(story.published_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</time> · ${Number(story.reading_time_minutes) || 1} min</span></a></li>`;
}

function publicServerPage(data, url) {
  if (!data) return '';
  if (data.type === 'story') {
    const catalog = [data.story, ...(data.related || [])].filter(Boolean);
    return renderArticle({ story: data.story, sources: data.sources, corrections: data.corrections, related: data.related, catalog, numbers: publicNumberMap(catalog), shareHref: `${canonicalOrigin(null, url)}${publicStoryPath(data.story.slug)}`, relatedHtml: data.related?.length ? `<div class="upnext-grid">${data.related.map((story, index) => publicServerCard(story, { eager: index === 0 })).join('')}</div>` : '' });
  }
  if (data.type === 'not-found') return `<div class="lost"><p class="mono">[ 404 · wiped out ]</p><h1>${html(data.title || 'This page does not exist.')}</h1><p class="lede">Try the latest edition or return home.</p><p><a class="more-link mono" href="/latest">read the latest →</a></p></div>`;
  if (data.type === 'home') {
    const lead = data.lead;
    const support = (data.featured || []).filter(story => story.id !== lead?.id).slice(0, 4);
    return `<div class="server-home"><header class="hero"><p class="hero-eyebrow mono">[ fresh off the desk ]</p><h1 class="hero-word">ANYWAYS</h1><p class="hero-promise">We cover the stories the timeline will talk about tomorrow.</p></header>${lead ? `<section class="billboard a-brick" aria-label="Top story"><a class="billboard-media" href="${publicStoryPath(lead.slug)}" tabindex="-1" aria-hidden="true">${publicServerImage(lead, true)}</a><div class="billboard-copy"><div class="chiprow"><span class="chip chip--hot">Lead story</span><span class="chip">${html(lead.article_format || 'News')}</span></div><h2 class="billboard-title"><a href="${publicStoryPath(lead.slug)}">${html(lead.title)}</a></h2><p class="lede">${html(lead.dek)}</p></div></section>` : '<p class="empty-note">The desk is setting its first edition.</p>'}${support.length ? `<section class="wire" aria-label="Featured stories"><header class="sec-head"><h2>Featured stories</h2></header><div class="wire-row">${support.map((story, index) => publicServerCard(story, { eager: index === 0 })).join('')}</div></section>` : ''}<section class="allindex"><header class="sec-head"><h2>Latest</h2><p class="sec-sub mono">the newest work on file</p></header><ul class="indexlist indexlist--full">${(data.latest || []).filter(story => story.id !== lead?.id && !support.some(item => item.id === story.id)).map(publicServerIndex).join('')}</ul><p class="zonetail mono"><a href="/latest">see every recent story →</a></p></section></div>`;
  }
  if (data.type === 'latest' || data.type === 'section' || data.type === 'topic') {
    const label = data.type === 'section' ? data.section.name : data.type === 'topic' ? data.topic.name : 'Latest';
    const description = data.type === 'section' ? (data.section.template || `Stories filed under ${label}.`) : data.type === 'topic' ? `Stories connected to ${label}.` : 'Follow the signal. Ignore the noise.';
    const stories = data.stories || [];
    return `<div class="zonepage"><header class="zone-head"><p class="zone-kicker mono">[ ${html(data.type)} · ${stories.length} stories ]</p><h1 class="zone-name">${html(label)}</h1><p class="zone-promise">${html(description)}</p></header>${stories.length ? `<div class="zone-lead">${publicServerCard(stories[0], { eager: true, heading: 'h2' })}<ul class="indexlist indexlist--zone">${stories.slice(1).map(publicServerIndex).join('')}</ul></div>` : '<p class="empty-note">No published stories match this desk yet.</p>'}</div>`;
  }
  if (data.type === 'topics') return `<div class="zonepage"><header class="zone-head"><p class="zone-kicker mono">[ the archive, by recurring subject ]</p><h1 class="zone-name">Topics</h1><p class="zone-promise">Subjects that keep coming back.</p></header><ul class="beatmenu">${data.rows.map((row, index) => `<li class="beatmenu-row" data-reveal><a class="beatmenu-hit" href="${publicTopicPath(row.topic.slug)}"><span class="beatmenu-num mono">${String(index + 1).padStart(2, '0')}</span><span class="beatmenu-name">${html(row.topic.name)}</span><span class="beatmenu-count mono">${row.count} ${row.count === 1 ? 'story' : 'stories'}</span></a></li>`).join('')}</ul></div>`;
  if (data.type === 'search') {
    const next = data.next_cursor ? `<p class="zonetail mono"><a href="/search?q=${encodeURIComponent(data.query)}${data.section ? `&section=${encodeURIComponent(data.section)}` : ''}&cursor=${encodeURIComponent(data.next_cursor)}">next results →</a></p>` : '';
    return `<div class="askpage"><header class="zone-head"><p class="zone-kicker mono">[ the archive ]</p><h1 class="zone-name">Search</h1><p class="zone-promise">Search the published file by story, subject, or source language.</p></header><form id="search" method="get" class="askbox"><div class="ask-line"><label class="sr-only" for="archive-query">Search the archive</label><input id="archive-query" name="q" type="search" maxlength="120" value="${html(data.query)}" placeholder="people, protocols, drama…"><button type="submit">search →</button></div><div class="ask-filter"><label class="mono" for="archive-section">in</label><select id="archive-section" name="section"><option value="">All sections</option>${data.sections.map(section => `<option value="${html(section.id)}" ${data.section === section.id ? 'selected' : ''}>${html(section.name)}</option>`).join('')}</select></div></form>${data.query ? (data.results.length ? `<p class="ask-results mono">[ ${data.results.length} result${data.results.length === 1 ? '' : 's'} · “${html(data.query)}” ]</p><div class="zone-lead">${data.results.map(story => publicServerCard(story, { eager: false })).join('')}</div>${next}` : `<p class="empty-note">Nothing filed under “${html(data.query)}” yet. Try a shorter phrase or browse <a href="/latest">Latest</a>.</p>`) : '<p class="empty-note">Try a person, a protocol, a company, or the thing everyone keeps talking around.</p>'}</div>`;
  }
  return '';
}

function pageMetadata(data, url) {
  const origin = canonicalOrigin(null, url);
  const fallback = { title: 'Anyways', description: 'Anyways covers the stories the timeline will talk about tomorrow. Follow the signal. Ignore the noise.' };
  if (data?.type === 'story') {
    const image = data.story.presentation?.hero || data.story.hero_media;
    const imageWidth = Number.isInteger(Number(image?.width)) && Number(image.width) > 0 ? Number(image.width) : null;
    const imageHeight = Number.isInteger(Number(image?.height)) && Number(image.height) > 0 ? Number(image.height) : null;
    return {
      title: data.story.seo_title || data.story.title,
      description: data.story.seo_description || data.story.dek,
      canonical: `${origin}${publicStoryPath(data.story.slug)}`,
      image: publicMediaUrl(image?.public_url || image?.url || image?.original_url, origin),
      imageAlt: image?.alt_text || image?.alt || '',
      imageWidth,
      imageHeight,
      publishedAt: data.story.published_at || '',
      modifiedAt: data.story.materially_updated_at || data.story.published_at || '',
      section: data.story.sections?.name || ''
    };
  }
  if (data?.type === 'section') return { title: data.section.name, description: `Stories filed under ${data.section.name}.`, canonical: `${origin}${publicSectionPath(data.section.slug)}` };
  if (data?.type === 'topic') return { title: data.topic.name, description: `Stories connected to ${data.topic.name}.`, canonical: `${origin}${publicTopicPath(data.topic.slug)}` };
  if (data?.type === 'latest') return { title: 'Latest', description: 'The latest stories from Anyways.', canonical: `${origin}/latest` };
  if (data?.type === 'topics') return { title: 'Topics', description: 'Recurring subjects in the Anyways archive.', canonical: `${origin}/topics` };
  if (data?.type === 'search') return { title: 'Search', description: 'Search the Anyways archive.', canonical: `${origin}/search` };
  return { ...fallback, canonical: `${origin}/` };
}

function jsonLdForPage(data, metadata, url) {
  const origin = canonicalOrigin(null, url);
  if (data?.type === 'story') {
    const story = data.story;
    return { '@context': 'https://schema.org', '@type': 'NewsArticle', headline: story.title, description: story.dek, url: metadata.canonical, datePublished: story.published_at, dateModified: story.materially_updated_at || story.published_at, articleSection: story.sections?.name || undefined, image: metadata.image ? [metadata.image] : undefined, publisher: { '@type': 'Organization', name: 'Anyways', url: origin } };
  }
  return { '@context': 'https://schema.org', '@type': 'Organization', name: 'Anyways', url: origin, sameAs: ['https://x.com/AnywaysMedia'] };
}

function injectPublicPage(shell, page, url) {
  const metadata = pageMetadata(page, url);
  const title = `${metadata.title} | Anyways`;
  const imageTags = metadata.image ? `<meta property="og:image" content="${html(metadata.image)}"><meta property="og:image:alt" content="${html(metadata.imageAlt || metadata.title)}">${metadata.imageWidth ? `<meta property="og:image:width" content="${metadata.imageWidth}">` : ''}${metadata.imageHeight ? `<meta property="og:image:height" content="${metadata.imageHeight}">` : ''}<meta name="twitter:image" content="${html(metadata.image)}"><meta name="twitter:image:alt" content="${html(metadata.imageAlt || metadata.title)}">` : '';
  const articleTags = page?.type === 'story' ? `<meta property="article:published_time" content="${html(metadata.publishedAt)}"><meta property="article:modified_time" content="${html(metadata.modifiedAt)}">${metadata.section ? `<meta property="article:section" content="${html(metadata.section)}">` : ''}` : '';
  const tags = `<link rel="canonical" href="${html(metadata.canonical)}"><meta property="og:title" content="${html(metadata.title)}"><meta property="og:description" content="${html(metadata.description)}"><meta property="og:url" content="${html(metadata.canonical)}"><meta property="og:site_name" content="Anyways"><meta property="og:type" content="${page?.type === 'story' ? 'article' : 'website'}">${imageTags}${articleTags}<meta name="twitter:card" content="${metadata.image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${html(metadata.title)}"><meta name="twitter:description" content="${html(metadata.description)}"><meta name="twitter:site" content="@AnywaysMedia"><script type="application/ld+json">${JSON.stringify(jsonLdForPage(page, metadata, url)).replace(/</g, '\\u003c')}</script>`;
  return shell
    .replace(/<title>[^<]*<\/title>/i, `<title>${html(title)}</title>`)
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>(?:\s*)/i, `<meta name="description" content="${html(metadata.description)}">`)
    .replace(/<meta\s+name="robots"\s+content="[^"]*"\s*\/?>(?:\s*)/i, `<meta name="robots" content="${page?.type === 'search' || Number(page?.status) >= 400 ? 'noindex,follow' : 'index,follow'}">`)
    .replace(/<\/head>/i, `${tags}</head>`)
    .replace(/<main id="app"[^>]*>[\s\S]*?<\/main>/i, `<main id="app" tabindex="-1" data-server-rendered="true">${publicServerPage(page, url)}</main>`);
}

export async function handlePublicApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!PUBLIC_API_PATH.test(url.pathname)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const config = publicApiEnv(env);
    if (!config) return apiError(request, 503, 'Public data is temporarily unavailable.', 'PUBLIC_DATA_UNAVAILABLE');
    const requestedPath = url.pathname.replace(/^\/api\/public/, '') || '/';
    const pagePath = requestedPath === '/home' ? '/'
      : requestedPath.replace(/^\/story\//, '/stories/').replace(/^\/section\//, '/sections/').replace(/^\/topic\//, '/topics/')
      || '/';
    const pageUrl = new URL(url.href);
    pageUrl.pathname = pagePath;
    const data = await publicPageData(pageUrl, env, fetchImpl);
    if (!data) return apiError(request, 404, 'Not found.', 'NOT_FOUND');
    if (data.redirect) return jsonResponse(request, 308, { redirect: data.redirect });
    return jsonResponse(request, data.status || 200, data);
  } catch (error) {
    console.error('Public API request failed', error);
    return apiError(request, Number(error?.status) || 503, Number(error?.status) === 404 ? 'Not found.' : 'Public data is temporarily unavailable.', error?.code || 'PUBLIC_DATA_UNAVAILABLE');
  }
}

export async function publicPageResponse(request, env, url, { fetchImpl = fetch, assetFetch = fetchAsset } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  if (!PUBLIC_PAGE_PATH.test(pathname) && !PUBLIC_ROUTE_PATHS.has(pathname)) return null;
  const trustSlug = pathname.slice(1);
  if (PUBLIC_ROUTE_PATHS.has(pathname)) {
    const page = trustPage(trustSlug);
    if (!page) return null;
    const shellUrl = new URL(request.url);
    shellUrl.pathname = '/index.html';
    shellUrl.search = '';
    const shell = await assetFetch(new Request(shellUrl, request), env);
    if (shell.status === 404) return textResponse(request, 503, 'Service Unavailable');
    const pageData = { type: 'trust', ...page };
    const shellText = await shell.text();
    const metadata = { title: page.title, description: page.description, canonical: `${canonicalOrigin(env, url)}${pathname}` };
    const trustShell = shellText
      .replace(/<title>[^<]*<\/title>/i, `<title>${html(page.title)} | Anyways</title>`)
      .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/?>(?:\s*)/i, `<meta name="description" content="${html(page.description)}">`)
      .replace(/<\/head>/i, `<link rel="canonical" href="${html(metadata.canonical)}"></head>`)
      .replace(/<main id="app"[^>]*>[\s\S]*?<\/main>/i, `<main id="app" tabindex="-1" data-server-rendered="true">${renderTrustPage(trustSlug)}</main>`);
    return new Response(request.method === 'HEAD' ? null : trustShell, { status: 200, headers: new Headers(shell.headers) });
  }
  const page = await publicPageData(url, env, fetchImpl);
  if (!page) return null;
  if (page.redirect) return withResponseHeaders(new Response(null, { status: 308, headers: { Location: `${page.redirect}${url.search}` } }), request);
  const shellUrl = new URL(request.url);
  shellUrl.pathname = '/index.html';
  shellUrl.search = '';
  const shell = await assetFetch(new Request(shellUrl, request), env);
  if (shell.status === 404) return textResponse(request, 503, 'Service Unavailable');
  const body = await shell.text();
  const rendered = injectPublicPage(body, page, url);
  const headers = new Headers(shell.headers);
  headers.delete('ETag');
  return new Response(request.method === 'HEAD' ? null : rendered, { status: page.status || 200, headers });
}

export async function articleMetadata(url, env, fetchImpl = fetch) {
  const match = url.pathname.match(/^\/stories\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/i);
  const config = publicApiEnv(env);
  if (!match || !config) return null;
  try {
    const storyQuery = new URLSearchParams({
      slug: `eq.${match[1]}`,
      select: 'id,title,slug,dek,seo_title,seo_description,social_title,social_description,presentation,hero_media',
      limit: '1'
    });
    const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${storyQuery}`, {
      headers: { apikey: config.anonKey, authorization: `Bearer ${config.anonKey}` }
    }, 'Article metadata');
    const story = Array.isArray(rows) ? rows[0] : null;
    if (!story?.slug) return null;
    const hero = story.presentation?.hero || story.hero_media;
    const image = publicMediaUrl(hero?.public_url || hero?.url || hero?.original_url, config.url);
    const canonical = `${canonicalOrigin(env, url)}${publicStoryPath(story.slug)}`;
    return {
      canonical,
      title: metaText(story.social_title || story.seo_title || story.title, 180),
      description: metaText(story.social_description || story.seo_description || story.dek, 320),
      image
    };
  } catch (error) {
    console.error('Article metadata lookup failed', error);
    return null;
  }
}

function articleMetaTags(metadata) {
  if (!metadata?.title || !metadata?.description) return '';
  const image = metadata.image ? `<meta property="og:image" content="${html(metadata.image)}"><meta name="twitter:image" content="${html(metadata.image)}">` : '';
  return `<link rel="canonical" href="${html(metadata.canonical)}"><meta property="og:type" content="article"><meta property="og:site_name" content="Anyways"><meta property="og:title" content="${html(metadata.title)}"><meta property="og:description" content="${html(metadata.description)}"><meta property="og:url" content="${html(metadata.canonical)}"><meta name="twitter:card" content="${metadata.image ? 'summary_large_image' : 'summary'}"><meta name="twitter:title" content="${html(metadata.title)}"><meta name="twitter:description" content="${html(metadata.description)}">${image}`;
}

function injectArticleMetadata(shell, metadata) {
  const tags = articleMetaTags(metadata);
  return tags && /<\/head>/i.test(shell) ? shell.replace(/<\/head>/i, `${tags}</head>`) : shell;
}

export async function articleShellResponse(request, env, url, { fetchImpl = fetch, assetFetch = fetchAsset } = {}) {
  if (request.method !== 'GET') return null;
  const metadata = await articleMetadata(url, env, fetchImpl);
  if (!metadata) return null;
  const shellUrl = new URL(request.url);
  shellUrl.pathname = '/index.html';
  shellUrl.search = '';
  const shell = await assetFetch(new Request(shellUrl, request), env);
  if (shell.status === 404) return textResponse(request, 503, 'Service Unavailable');
  const headers = new Headers(shell.headers);
  headers.delete('ETag');
  return new Response(injectArticleMetadata(await shell.text(), metadata), { status: shell.status, statusText: shell.statusText, headers });
}

async function sitemapResponse(request, env, fetchImpl = fetch) {
  const requestUrl = new URL(request.url);
  const origin = canonicalOrigin(env, requestUrl);
  const urls = [
    { loc: `${origin}/`, lastmod: null },
    { loc: `${origin}/latest`, lastmod: null },
    { loc: `${origin}/topics`, lastmod: null },
    { loc: `${origin}/feed.xml`, lastmod: null },
    ...trustPageSlugs().map(slug => ({ loc: `${origin}/${slug}`, lastmod: null }))
  ];
  const config = apiEnv(env);
  if (config) {
    try {
      const sections = await publicSupabaseJson(fetchImpl, config, `/rest/v1/sections?${publicQuery({ select: 'slug', order: 'name.asc' })}`, {}, 'Sitemap sections');
      for (const section of Array.isArray(sections) ? sections : []) if (section?.slug) urls.push({ loc: `${origin}${publicSectionPath(section.slug)}`, lastmod: null });
    } catch (error) {
      console.error('Sitemap section lookup failed', error);
    }
    try {
      const topics = await publicSupabaseJson(fetchImpl, config, `/rest/v1/beats?${publicQuery({ select: 'slug', order: 'name.asc' })}`, {}, 'Sitemap topics');
      for (const topic of Array.isArray(topics) ? topics : []) if (topic?.slug) urls.push({ loc: `${origin}${publicTopicPath(topic.slug)}`, lastmod: null });
    } catch (error) {
      console.error('Sitemap topic lookup failed', error);
    }
    try {
      const query = new URLSearchParams({ select: 'slug,updated_at,materially_updated_at,published_at', order: 'published_at.desc', limit: '5000' });
      const rows = await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${query}`, {}, 'Sitemap stories');
      for (const story of Array.isArray(rows) ? rows : []) {
        if (story?.slug) urls.push({ loc: `${origin}${publicStoryPath(story.slug)}`, lastmod: story.materially_updated_at || story.updated_at || story.published_at || null });
      }
    } catch (error) {
      console.error('Sitemap story lookup failed', error);
    }
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(entry => `<url><loc>${xml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${xml(new Date(entry.lastmod).toISOString())}</lastmod>` : ''}</url>`).join('')}</urlset>`;
  return withResponseHeaders(new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } }), request);
}

async function feedRows(env, fetchImpl = fetch) {
  const config = publicApiEnv(env);
  if (!config) return [];
  const query = publicStoryQuery({ limit: '50' });
  return publicStoryRows(await publicSupabaseJson(fetchImpl, config, `/rest/v1/published_stories?${query}`, {}, 'Feed stories'));
}

async function feedResponse(request, env, format, fetchImpl = fetch) {
  const url = new URL(request.url);
  const origin = canonicalOrigin(env, url);
  let stories = [];
  try { stories = await feedRows(env, fetchImpl); } catch (error) { console.error('Feed lookup failed', error); }
  if (format === 'json') {
    const body = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Anyways', home_page_url: `${origin}/`, feed_url: `${origin}/feed.json`, items: stories.map(story => ({ id: story.id, url: `${origin}${publicStoryPath(story.slug)}`, title: story.title, content_text: story.body, summary: story.dek, date_published: story.published_at, date_modified: story.materially_updated_at || story.published_at, tags: [story.sections?.name, ...story.story_beats.map(item => item.beats?.name)].filter(Boolean) })) });
    return withResponseHeaders(new Response(body, { headers: { 'Content-Type': 'application/feed+json; charset=utf-8' } }), request);
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Anyways</title><link>${xml(origin)}/</link><description>${xml('Stories the timeline will talk about tomorrow.')}</description><atom:link href="${xml(origin)}/feed.xml" rel="self" type="application/rss+xml" xmlns:atom="http://www.w3.org/2005/Atom"/>${stories.map(story => `<item><guid isPermaLink="true">${xml(origin)}${xml(publicStoryPath(story.slug))}</guid><link>${xml(origin)}${xml(publicStoryPath(story.slug))}</link><title>${xml(story.title)}</title><description>${xml(story.dek)}</description><pubDate>${xml(new Date(story.published_at).toUTCString())}</pubDate></item>`).join('')}</channel></rss>`;
  return withResponseHeaders(new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } }), request);
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

const SOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function sourceRegistryRow(fetchImpl, config, sourceId) {
  const query = new URLSearchParams({ id: `eq.${sourceId}`, select: '*' });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/source_registry?${query}`, {
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` }
  }, 'Source registry lookup');
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function patchSourceRegistry(fetchImpl, config, sourceId, patch) {
  const query = new URLSearchParams({ id: `eq.${sourceId}` });
  return supabaseJson(fetchImpl, `${config.url}/rest/v1/source_registry?${query}`, {
    method: 'PATCH',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  }, 'Source registry update');
}

export async function handleSourceIngestionApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/newsroom\/source-ingestion\/(test|activate|pause)\/([0-9a-f-]{36})$/i);
  if (!match) return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    const [, action, sourceId] = match;
    if (!SOURCE_ID.test(sourceId)) throw Object.assign(new Error('Source ID is invalid.'), { status: 400, code: 'INVALID_SOURCE' });
    const source = await sourceRegistryRow(fetchImpl, config, sourceId);
    if (!source) throw Object.assign(new Error('Source was not found.'), { status: 404, code: 'NOT_FOUND' });
    if (action === 'pause') {
      const rows = await patchSourceRegistry(fetchImpl, config, sourceId, {
        active: false,
        ingestion_status: 'not_activated',
        ingestion_blocker: 'Paused by newsroom.',
        ingestion_next_eligible_at: null,
        ingestion_lease_token: null,
        ingestion_lease_until: null
      });
      return jsonResponse(request, 200, { source: rows?.[0] || null, status: 'not_activated' });
    }
    if (source.source_type === 'x_account') {
      if (!/^@[A-Za-z0-9_]{1,15}$/.test(String(source.x_handle || '').trim())) {
        throw Object.assign(new Error('Activate X ingestion only after a verified X handle is present.'), { status: 409, code: 'X_HANDLE_REQUIRED' });
      }
      if (action === 'test') {
        if (!source.active || source.review_status !== 'ready') throw Object.assign(new Error('Activate this reviewed X source before starting a browser test.'), { status: 409, code: 'X_SOURCE_NOT_ACTIVE' });
        const result = await pipelineRpc(fetchImpl, config, 'submit_x_browser_ingestion_test', { p_source_id: sourceId, p_requested_by: profile.id });
        return jsonResponse(request, 201, result);
      }
      const rows = await patchSourceRegistry(fetchImpl, config, sourceId, {
        active: true, ingestion_status: 'ready', ingestion_next_eligible_at: null, ingestion_blocker: null
      });
      return jsonResponse(request, 200, { source: rows?.[0] || null, status: 'ready' });
    }
    if (action === 'test') {
      const result = await fetchSource(source, { fetchImpl });
      const validatedAt = new Date().toISOString();
      const rows = await patchSourceRegistry(fetchImpl, config, sourceId, {
        ingestion_status: 'ready', ingestion_validated_at: validatedAt,
        ingestion_validation_url: canonicalizeUrl(source.handle_or_url), ingestion_blocker: null,
        ingestion_last_fetcher: result.fetcher
      });
      return jsonResponse(request, 200, { source: rows?.[0] || null, valid: true, fetcher: result.fetcher, item_count: result.items.length, response_metadata: result.responseMetadata });
    }
    const configuredUrl = canonicalizeUrl(source.handle_or_url);
    const safe = isSafeFetchUrl(source.handle_or_url);
    if (!safe.ok || !configuredUrl || source.review_status !== 'ready' || !source.ingestion_validated_at || source.ingestion_validation_url !== configuredUrl) {
      throw Object.assign(new Error('Test this supported, reviewed source successfully before activating ingestion.'), { status: 409, code: 'SOURCE_NOT_VALIDATED' });
    }
    const rows = await patchSourceRegistry(fetchImpl, config, sourceId, { active: true, ingestion_status: 'ready', ingestion_next_eligible_at: null, ingestion_blocker: null });
    return jsonResponse(request, 200, { source: rows?.[0] || null, status: 'ready' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Source ingestion request failed.';
    if (match?.[1] === 'test' && match?.[2] && error?.code !== 'UNSUPPORTED_SOURCE') {
      try {
        const config = apiEnv(env);
        if (config) await patchSourceRegistry(fetchImpl, config, match[2], { ingestion_status: 'not_activated', ingestion_blocker: message });
      } catch {}
    }
    return apiError(request, Number(error?.status) || 400, message, error?.code || 'SOURCE_INGESTION_REQUEST_FAILED');
  }
}

export async function handleXBrowserApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!['/api/newsroom/x-browser/status', '/api/newsroom/x-browser/settings'].includes(url.pathname)) return null;
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    if (url.pathname.endsWith('/status')) {
      if (request.method !== 'GET') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      const [settings, sources] = await Promise.all([
        supabaseJson(fetchImpl, `${config.url}/rest/v1/x_browser_ingestion_settings?id=eq.default&select=*`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'X browser settings lookup'),
        supabaseJson(fetchImpl, `${config.url}/rest/v1/source_registry?source_type=eq.x_account&select=id,name,x_handle,active,review_status,ingestion_status,ingestion_blocker,last_checked_at,last_success_at,ingestion_last_inserted_count,ingestion_last_duplicate_count&order=priority.desc,name.asc`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'X source lookup')
      ]);
      return jsonResponse(request, 200, { settings: Array.isArray(settings) ? settings[0] || null : settings, sources: Array.isArray(sources) ? sources : [], role: profile.role });
    }
    if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
    const body = await requestJson(request);
    const enabled = body?.enabled === true;
    const maxAccounts = Number(body?.max_accounts_per_run);
    const maxPosts = Number(body?.max_posts_per_account);
    const pageConcurrency = Number(body?.page_concurrency);
    const replyMinChars = Number(body?.reply_min_chars);
    const minVisitGap = Number(body?.min_visit_gap_seconds ?? 90);
    const maxVisitGap = Number(body?.max_visit_gap_seconds ?? 360);
    const maxVisitsPerHour = Number(body?.max_visits_per_hour ?? 8);
    const longBreakEvery = Number(body?.long_break_every_visits ?? 4);
    const longBreakMin = Number(body?.long_break_min_seconds ?? 480);
    const longBreakMax = Number(body?.long_break_max_seconds ?? 1200);
    if (maxAccounts !== 1 || !Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 50 || pageConcurrency !== 1 || !Number.isInteger(replyMinChars) || replyMinChars < 60 || replyMinChars > 1000 || !Number.isInteger(minVisitGap) || minVisitGap < 90 || minVisitGap > 1800 || !Number.isInteger(maxVisitGap) || maxVisitGap < minVisitGap || maxVisitGap > 3600 || !Number.isInteger(maxVisitsPerHour) || maxVisitsPerHour < 1 || maxVisitsPerHour > 12 || !Number.isInteger(longBreakEvery) || longBreakEvery < 3 || longBreakEvery > 5 || !Number.isInteger(longBreakMin) || longBreakMin < 480 || longBreakMin > 3600 || !Number.isInteger(longBreakMax) || longBreakMax < longBreakMin || longBreakMax > 7200) {
      throw Object.assign(new Error('X browser settings are outside the bounded conservative pacing limits.'), { status: 400, code: 'INVALID_PARAMETERS' });
    }
    const saved = await pipelineRpc(fetchImpl, config, 'save_x_browser_ingestion_settings_v2', {
      p_enabled: enabled, p_max_accounts_per_run: 1, p_max_posts_per_account: maxPosts,
      p_page_concurrency: 1, p_reply_min_chars: replyMinChars, p_min_visit_gap_seconds: minVisitGap,
      p_max_visit_gap_seconds: maxVisitGap, p_max_visits_per_hour: maxVisitsPerHour,
      p_long_break_every_visits: longBreakEvery, p_long_break_min_seconds: longBreakMin,
      p_long_break_max_seconds: longBreakMax, p_requested_by: profile.id
    });
    return jsonResponse(request, 200, { settings: saved });
  } catch (error) {
    return apiError(request, Number(error?.status) || 400, error instanceof Error ? error.message : 'X browser request failed.', error?.code || 'X_BROWSER_REQUEST_FAILED');
  }
}

async function mediaSourceRows(fetchImpl, config, ids) {
  const query = new URLSearchParams({ id: `in.(${ids.join(',')})`, select: 'id,name,platform,source_type,primary_class,trust_level,public_display_name,x_handle,handle_or_url,allowed_media_hosts,internal_queue' });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/source_registry?${query}`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Media source lookup');
  return Array.isArray(rows) ? rows.slice(0, 20) : [];
}

async function mediaEventRows(fetchImpl, config, eventIds, limit) {
  const query = new URLSearchParams({ select: 'id,source_id,canonical_url,title,published_at,discovered_at,media', order: 'published_at.desc.nullslast', limit: String(limit) });
  if (eventIds.length) query.set('id', `in.(${eventIds.join(',')})`);
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/source_events?${query}`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Media event lookup');
  return Array.isArray(rows) ? rows : [];
}

async function existingMediaAssetRows(fetchImpl, config, eventIds) {
  if (!eventIds.length) return [];
  const query = new URLSearchParams({ source_event_id: `in.(${eventIds.join(',')})`, select: 'source_event_id,original_url,content_hash' });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_assets?${query}`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Existing media lookup');
  return Array.isArray(rows) ? rows : [];
}

function dedupeMediaAssets(assets, existing = []) {
  const seenUrls = new Set(existing.map(asset => `${asset.source_event_id || ''}:${asset.original_url || ''}`));
  const seenHashes = new Set(existing.map(asset => asset.content_hash).filter(Boolean).map(hash => String(hash).toLowerCase()));
  return assets.filter(asset => {
    const urlKey = `${asset.source_event_id || ''}:${asset.original_url || ''}`;
    const hash = asset.content_hash ? String(asset.content_hash).toLowerCase() : '';
    if (seenUrls.has(urlKey) || (hash && seenHashes.has(hash))) return false;
    seenUrls.add(urlKey);
    if (hash) seenHashes.add(hash);
    return true;
  });
}

function persistedMediaAsset(asset) {
  return {
    source_event_id: asset.source_event_id ?? null,
    source_registry_id: asset.source_registry_id ?? null,
    original_url: asset.original_url,
    cached_url: asset.cached_url ?? null,
    storage_path: asset.storage_path ?? null,
    source_page_url: asset.source_page_url ?? null,
    media_type: asset.media_type,
    width: asset.width ?? null,
    height: asset.height ?? null,
    file_size: asset.file_size ?? null,
    mime_type: asset.mime_type ?? null,
    content_hash: asset.content_hash ?? null,
    creator_or_account: asset.creator_or_account ?? null,
    attribution_text: asset.attribution_text ?? null,
    rights_basis: asset.rights_basis,
    usage_scope: asset.usage_scope,
    alt_text: asset.alt_text ?? '',
    captured_at: asset.captured_at,
    cached_at: asset.cached_at ?? null,
    cache_state: asset.cache_state ?? (asset.status === 'cached' ? 'cached' : asset.status === 'cache_failed' ? 'failed' : asset.status === 'blocked' ? 'unsupported' : asset.status === 'needs_review' ? 'remote_only' : 'pending'),
    cache_attempt_count: Number.isInteger(Number(asset.cache_attempt_count)) ? Number(asset.cache_attempt_count) : 0,
    cache_last_attempt_at: asset.cache_last_attempt_at ?? null,
    status: asset.status,
    error: asset.error ?? null,
    metadata: asset.metadata || {},
    hero_score: asset.hero_score ?? null,
    hero_score_breakdown: asset.hero_score_breakdown || {}
  };
}

function withHeroDecision(asset, source) {
  const decision = heroEligibility(asset, source);
  return { ...asset, hero_score: decision.eligible ? decision.score : null, hero_score_breakdown: decision.breakdown, metadata: { ...(asset.metadata || {}), hero_eligibility: decision } };
}

async function putCachedMedia(fetchImpl, config, { bucket, path, bytes, mimeType }) {
  const response = await fetchImpl(`${config.url}/storage/v1/object/${bucket}/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': mimeType, 'cache-control': 'public,max-age=31536000,immutable', 'x-upsert': 'true' },
    body: bytes
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 240); } catch {}
    throw Object.assign(new Error(`Media cache upload failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}.`), { code: 'MEDIA_CACHE_UPLOAD_FAILED', status: response.status });
  }
}

async function mediaAssetRow(fetchImpl, config, assetId) {
  const query = new URLSearchParams({ id: `eq.${assetId}`, select: '*' });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_assets?${query}`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Media asset lookup');
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function updateMediaAsset(fetchImpl, config, assetId, payload) {
  const query = new URLSearchParams({ id: `eq.${assetId}` });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_assets?${query}`, { method: 'PATCH', headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(payload) }, 'Media asset update');
  return Array.isArray(rows) ? rows[0] || null : null;
}

async function reconcileMediaDerivatives(fetchImpl, config, asset) {
  const existing = await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_asset_derivatives?asset_id=eq.${asset.id}&select=id,derivative_kind,status`, { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } }, 'Media derivative lookup');
  const plans = derivativePlans(asset);
  if (!plans.length) return { created: 0, reconciled: 0 };
  const existingByKind = new Map((Array.isArray(existing) ? existing : []).map(row => [row.derivative_kind, row]));
  let reconciled = 0;
  for (const plan of plans) {
    const row = existingByKind.get(plan.kind);
    if (!row) continue;
    if (row.status !== 'cached') {
      await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_asset_derivatives?id=eq.${row.id}`, { method: 'PATCH', headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ width: plan.width, height: plan.height, crop: plan.crop || {}, status: plan.status, error: null }) }, 'Media derivative reconciliation');
      reconciled += 1;
    }
  }
  const missing = plans.filter(plan => !existingByKind.has(plan.kind)).map(plan => ({ asset_id: asset.id, derivative_kind: plan.kind, width: plan.width, height: plan.height, crop: plan.crop || {}, status: plan.status }));
  if (missing.length) await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_asset_derivatives`, { method: 'POST', headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(missing) }, 'Media derivative plan');
  return { created: missing.length, reconciled };
}

export async function handleMediaPipelineApi(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const backfill = url.pathname === '/api/newsroom/media-assets/backfill';
  const retryCache = url.pathname.match(/^\/api\/newsroom\/media-assets\/([0-9a-f-]{36})\/retry-cache$/i);
  const override = url.pathname.match(/^\/api\/newsroom\/media-assets\/([0-9a-f-]{36})\/override$/i);
  const link = url.pathname.match(/^\/api\/newsroom\/media-assets\/stories\/([0-9a-f-]{36})\/link$/i);
  const storyHero = url.pathname.match(/^\/api\/newsroom\/media-assets\/stories\/([0-9a-f-]{36})\/hero$/i);
  const storyAsset = url.pathname.match(/^\/api\/newsroom\/media-assets\/stories\/([0-9a-f-]{36})\/assets\/([0-9a-f-]{36})$/i);
  if (!backfill && !retryCache && !override && !link && !storyHero && !storyAsset) return null;
  if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    const body = await requestJson(request);
    if (storyHero) {
      const storyId = storyHero[1];
      const action = String(body?.action || '');
      const assetId = body?.asset_id === null || body?.asset_id === undefined || body?.asset_id === '' ? null : String(body.asset_id);
      if (!['select', 'remove', 'needed'].includes(action) || (assetId !== null && !UUID.test(assetId))) throw Object.assign(new Error('Choose a valid story hero action.'), { status: 400, code: 'INVALID_STORY_HERO_ACTION' });
      const result = await pipelineRpc(fetchImpl, config, 'set_story_media_hero', { p_story_id: storyId, p_asset_id: assetId, p_action: action, p_alt_text: body?.alt_text === undefined ? null : String(body.alt_text), p_attribution_text: body?.attribution_text === undefined ? null : String(body.attribution_text), p_requested_by: profile.id });
      return jsonResponse(request, 200, result);
    }
    if (storyAsset) {
      const [, storyId, assetId] = storyAsset;
      const action = String(body?.action || '');
      if (!['edit', 'block'].includes(action)) throw Object.assign(new Error('Choose a valid story media action.'), { status: 400, code: 'INVALID_STORY_MEDIA_ACTION' });
      const result = await pipelineRpc(fetchImpl, config, 'update_story_media_asset', { p_story_id: storyId, p_asset_id: assetId, p_action: action, p_alt_text: body?.alt_text === undefined ? null : String(body.alt_text), p_attribution_text: body?.attribution_text === undefined ? null : String(body.attribution_text), p_requested_by: profile.id });
      return jsonResponse(request, 200, result);
    }
    if (retryCache) {
      const assetId = retryCache[1];
      const asset = await mediaAssetRow(fetchImpl, config, assetId);
      if (!asset) throw Object.assign(new Error('Media asset was not found.'), { status: 404, code: 'MEDIA_ASSET_NOT_FOUND' });
      if (!['failed', 'cache_failed'].includes(asset.cache_state || asset.status)) throw Object.assign(new Error('Only failed media assets can be retried.'), { status: 409, code: 'MEDIA_RETRY_NOT_ELIGIBLE' });
      const sources = await mediaSourceRows(fetchImpl, config, [asset.source_registry_id].filter(Boolean));
      const source = sources[0] || {};
      const attemptCount = Number(asset.cache_attempt_count || 0) + 1;
      if (attemptCount > 10) throw Object.assign(new Error('Media cache retry limit reached.'), { status: 409, code: 'MEDIA_RETRY_LIMIT' });
      const attemptedAt = new Date().toISOString();
      await updateMediaAsset(fetchImpl, config, asset.id, { cache_state: 'pending', cache_attempt_count: attemptCount, cache_last_attempt_at: attemptedAt, error: null });
      try {
        let cached = await cacheMediaAsset({ ...asset, cache_state: 'pending', cache_attempt_count: attemptCount, cache_last_attempt_at: attemptedAt }, {
          source,
          put: value => putCachedMedia(fetchImpl, config, value),
          fetchImpl
        });
        cached = withHeroDecision(cached, source);
        const saved = await updateMediaAsset(fetchImpl, config, asset.id, persistedMediaAsset(cached));
        const derivatives = await reconcileMediaDerivatives(fetchImpl, config, { ...cached, id: asset.id });
        return jsonResponse(request, 200, { asset: saved || persistedMediaAsset(cached), derivatives, editor: profile.id });
      } catch (error) {
        const failed = await updateMediaAsset(fetchImpl, config, asset.id, { cache_state: 'failed', status: 'cache_failed', cache_attempt_count: attemptCount, cache_last_attempt_at: attemptedAt, error: String(error?.message || 'Media cache failed').slice(0, 1000), hero_score: null, hero_score_breakdown: {}, metadata: { ...(asset.metadata || {}), hero_eligibility: heroEligibility({ ...asset, cache_state: 'failed', status: 'cache_failed' }, source) } });
        return jsonResponse(request, 422, { asset: failed, editor: profile.id, error: { code: error?.code || 'MEDIA_CACHE_FAILED', message: String(error?.message || 'Media cache failed') } });
      }
    }
    if (backfill) {
      const eventIds = Array.isArray(body?.source_event_ids) ? [...new Set(body.source_event_ids.filter(id => UUID.test(String(id))))] : [];
      const limit = Number(body?.limit ?? (eventIds.length || 20));
      if (!eventIds.length || !Number.isInteger(limit) || limit < 1 || limit > 20 || eventIds.length > 20) throw Object.assign(new Error('Media backfill requires 1 to 20 existing source event IDs.'), { status: 400, code: 'INVALID_MEDIA_BACKFILL' });
      const events = await mediaEventRows(fetchImpl, config, eventIds, limit);
      const sourceIds = [...new Set(events.map(event => event.source_id).filter(id => UUID.test(String(id))))];
      const sources = await mediaSourceRows(fetchImpl, config, sourceIds);
      const sourcesById = new Map(sources.map(source => [source.id, source]));
      const existing = await existingMediaAssetRows(fetchImpl, config, events.map(event => event.id));
      let assets = events.flatMap(event => normalizeSourceEventMedia(event, sourcesById.get(event.source_id) || {})).map(asset => {
        const source = sourcesById.get(asset.source_registry_id) || {};
        return withHeroDecision(asset, source);
      });
      assets = dedupeMediaAssets(assets, existing);
      const cacheRequested = body?.cache !== false;
      if (cacheRequested) {
        assets = await Promise.all(assets.map(async asset => {
          const source = sourcesById.get(asset.source_registry_id) || {};
          if (!['owned', 'official_press_asset', 'official_source_media'].includes(asset.rights_basis)) return asset;
          const attempted = { ...asset, cache_attempt_count: 1, cache_last_attempt_at: new Date().toISOString(), cache_state: 'pending' };
          try {
            return withHeroDecision(await cacheMediaAsset(attempted, {
              source,
              put: value => putCachedMedia(fetchImpl, config, value), fetchImpl
            }), source);
          } catch (error) {
            return withHeroDecision({ ...attempted, status: 'cache_failed', cache_state: 'failed', error: String(error?.message || 'Media cache failed').slice(0, 1000) }, source);
          }
        }));
      }
      assets = dedupeMediaAssets(assets.map(persistedMediaAsset), existing);
      if (assets.length) {
        const insertQuery = new URLSearchParams({ on_conflict: 'source_event_id,original_url' });
        const insertedAssets = await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_assets?${insertQuery}`, { method: 'POST', headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=representation,resolution=ignore-duplicates' }, body: JSON.stringify(assets) }, 'Media asset backfill');
        const persistedAssets = Array.isArray(insertedAssets) ? insertedAssets : [];
        const derivativeRows = persistedAssets.filter(asset => asset.cache_state === 'cached' && asset.status === 'cached').flatMap(asset => derivativePlans(asset).map(plan => ({ asset_id: asset.id, derivative_kind: plan.kind, width: plan.width, height: plan.height, crop: plan.crop || {}, status: plan.status })));
        if (derivativeRows.length) await supabaseJson(fetchImpl, `${config.url}/rest/v1/media_asset_derivatives`, { method: 'POST', headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=minimal,resolution=ignore-duplicates' }, body: JSON.stringify(derivativeRows) }, 'Media derivative plan');
      }
      return jsonResponse(request, 201, { source_events: events.length, assets: assets.length, cached: assets.filter(asset => asset.status === 'cached').length, cache_failed: assets.filter(asset => asset.status === 'cache_failed').length, editor: profile.id });
    }
    if (override) {
      const assetId = override[1];
      if (!UUID.test(assetId)) throw Object.assign(new Error('Media asset ID is invalid.'), { status: 400, code: 'INVALID_MEDIA_ASSET' });
      const result = await pipelineRpc(fetchImpl, config, 'override_media_asset', { p_asset_id: assetId, p_rights_basis: String(body?.rights_basis || ''), p_usage_scope: String(body?.usage_scope || ''), p_attribution_text: String(body?.attribution_text || ''), p_alt_text: String(body?.alt_text || ''), p_note: String(body?.note || ''), p_requested_by: profile.id });
      return jsonResponse(request, 200, result);
    }
    const storyId = link[1];
    if (!UUID.test(storyId)) throw Object.assign(new Error('Story ID is invalid.'), { status: 400, code: 'INVALID_STORY' });
    const sourceEventIds = Array.isArray(body?.source_event_ids) ? [...new Set(body.source_event_ids.filter(id => UUID.test(String(id))))] : [];
    const origin = body?.origin === 'manual' ? 'manual' : 'automated';
    if ((origin === 'manual' && !sourceEventIds.length) || sourceEventIds.length > 20) throw Object.assign(new Error(origin === 'manual' ? 'Manual links require 1 to 20 existing source events.' : 'Link no more than 20 existing source events.'), { status: 400, code: 'INVALID_MEDIA_LINK' });
    const result = await pipelineRpc(fetchImpl, config, 'attach_media_assets_to_story', { p_story_id: storyId, p_source_event_ids: sourceEventIds, p_requested_by: profile.id, p_origin: origin });
    return jsonResponse(request, 200, result);
  } catch (error) {
    return apiError(request, Number(error?.status) || (error?.code === 'UNAUTHENTICATED' ? 401 : error?.code === 'EDITOR_REQUIRED' ? 403 : 400), error instanceof Error ? error.message : 'Media pipeline request failed.', error?.code || 'MEDIA_PIPELINE_REQUEST_FAILED');
  }
}

async function sourceEventsFor(fetchImpl, config, sourceId) {
  const query = new URLSearchParams({ source_id: `eq.${sourceId}`, select: 'external_id,canonical_url,content_hash,published_at,discovered_at', limit: '10000' });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/source_events?${query}`, {
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` }
  }, 'Source event lookup');
  return Array.isArray(rows) ? rows : [];
}

async function insertSourceEvents(fetchImpl, config, events) {
  if (!events.length) return [];
  return supabaseJson(fetchImpl, `${config.url}/rest/v1/source_events`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json', prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify(events)
  }, 'Source event insert');
}

async function finishSourceIngestion(fetchImpl, config, claim, result) {
  return supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/finish_source_ingestion_run`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      p_run_id: claim.run_id,
      p_source_id: claim.source_id,
      p_lease_token: claim.lease_token,
      p_status: result.status,
      p_fetched_count: result.fetchedCount || 0,
      p_inserted_count: result.insertedCount || 0,
      p_duplicate_count: result.duplicateCount || 0,
      p_error_count: result.errorCount || 0,
      p_error_summary: result.errorSummary || null,
      p_cursor_or_etag: { etag: result.responseMetadata?.etag || null, last_modified: result.responseMetadata?.last_modified || null },
      p_response_metadata: { ...(result.responseMetadata || {}), fetcher: result.fetcher || null }
    })
  }, 'Source ingestion run completion');
}

function backfillFreshness(event, { from, to } = {}) {
  const timestampText = String(event?.published_at || '').trim();
  const timestamp = timestampText ? new Date(timestampText).getTime() : Number.NaN;
  const fromMs = new Date(from || '').getTime();
  const toMs = new Date(to || '').getTime();
  if (!timestampText) return { eligible: false, reason: 'missing_timestamp' };
  if (!Number.isFinite(timestamp)) return { eligible: false, reason: 'invalid_timestamp' };
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return { eligible: false, reason: 'invalid_backfill_range' };
  if (timestamp < fromMs || timestamp >= toMs) return { eligible: false, reason: 'outside_backfill_range', from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  return { eligible: true, reason: 'backfill_range', from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

async function processSourceClaim(fetchImpl, config, claim, now, {
  mode = 'scheduled',
  backfillFrom = null,
  backfillTo = null,
  freshnessPolicy = undefined
} = {}) {
  const source = { ...claim, id: claim.source_id, active: true, review_status: 'ready', ingestion_status: 'ready', handle_or_url: claim.handle_or_url, source_type: claim.source_type };
  try {
    const result = await fetchSource(source, { fetchImpl, now });
    if (result.notModified) {
      await finishSourceIngestion(fetchImpl, config, claim, { status: 'not_modified', responseMetadata: result.responseMetadata, fetcher: result.fetcher });
      return { source_id: claim.source_id, status: 'not_modified', inserted: 0, duplicates: 0, stale: 0, fetched: 0, errors: 0 };
    }
    const existing = await sourceEventsFor(fetchImpl, config, claim.source_id);
    const normalized = [];
    let duplicateCount = 0;
    let staleCount = 0;
    let backfillRangeSkipped = 0;
    let errorCount = 0;
    for (const item of result.items) {
      try {
        const event = await normalizeEvent(item, source, { now, fetcher: result.fetcher, responseMetadata: result.responseMetadata });
        if (duplicateEvent(existing, event) || duplicateEvent(normalized, event)) {
          duplicateCount += 1;
          continue;
        }
        const freshness = mode === 'backfill'
          ? backfillFreshness(event, { from: backfillFrom, to: backfillTo })
          : sourceEventFreshness(event, source, { now, ...(freshnessPolicy || {}) });
        if (!freshness.eligible) {
          if (mode === 'backfill') backfillRangeSkipped += 1;
          else staleCount += 1;
        }
        normalized.push({
          ...event,
          ingestion_run_id: claim.run_id,
          source_metadata: { ...(event.source_metadata || {}), discovery_freshness: { mode, ...freshness } }
        });
      } catch {
        errorCount += 1;
      }
    }
    const inserted = await insertSourceEvents(fetchImpl, config, normalized);
    const insertedCount = Array.isArray(inserted) ? inserted.length : normalized.length;
    const insertDuplicateCount = Math.max(0, normalized.length - insertedCount);
    duplicateCount += insertDuplicateCount;
    const responseMetadata = { ...(result.responseMetadata || {}) };
    responseMetadata.discovery_freshness = { mode, stale_items_skipped: staleCount, backfill_range_skipped: backfillRangeSkipped, duplicate_items_skipped: duplicateCount, normalization_errors: errorCount };
    const status = errorCount || insertDuplicateCount ? 'degraded' : 'healthy';
    await finishSourceIngestion(fetchImpl, config, claim, { status, fetchedCount: result.items.length, insertedCount, duplicateCount, errorCount, responseMetadata, fetcher: result.fetcher });
    return { source_id: claim.source_id, status, inserted: insertedCount, duplicates: duplicateCount, stale: staleCount, backfill_range_skipped: backfillRangeSkipped, fetched: result.items.length, errors: errorCount };
  } catch (error) {
    const status = 'failed';
    await finishSourceIngestion(fetchImpl, config, claim, { status, fetchedCount: 0, errorCount: 1, errorSummary: error instanceof Error ? error.message : 'Source fetch failed.', responseMetadata: {}, fetcher: 'error' });
    return { source_id: claim.source_id, status, inserted: 0, duplicates: 0, stale: 0, fetched: 0, errors: 1, error: error instanceof Error ? error.message : 'Source fetch failed.' };
  }
}

export async function runSourceIngestionScheduler(env, {
  fetchImpl = fetch,
  now = new Date(),
  limit = 3,
  mode = 'scheduled',
  force = false,
  backfillFrom = null,
  backfillTo = null,
  freshnessPolicy = undefined
} = {}) {
  const config = apiEnv(env);
  if (!config) return { skipped: true, reason: 'Source ingestion is not configured.' };
  const claims = await supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/claim_source_ingestion_batch`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_now: new Date(now).toISOString(), p_limit: Math.min(3, Math.max(0, Number(limit) || 0)), p_lease_seconds: 90, p_force: mode === 'backfill' || force === true })
  }, 'Source ingestion claim');
  const results = [];
  for (const claim of Array.isArray(claims) ? claims.slice(0, 3) : []) results.push(await processSourceClaim(fetchImpl, config, claim, new Date(now), { mode, backfillFrom, backfillTo, freshnessPolicy }));
  return {
    skipped: false,
    claimed: results.length,
    results,
    items_fetched: results.reduce((total, result) => total + Number(result.fetched || 0), 0),
    stale_items_skipped: results.reduce((total, result) => total + Number(result.stale || 0), 0),
    duplicate_items_skipped: results.reduce((total, result) => total + Number(result.duplicates || 0), 0),
    backfill_range_skipped: results.reduce((total, result) => total + Number(result.backfill_range_skipped || 0), 0)
  };
}

export async function queueHermesStoryProposals(env, {
  fetchImpl = fetch,
  now = new Date(),
  limit = 25,
  mode = 'scheduled',
  backfillFrom = null,
  backfillTo = null
} = {}) {
  const config = apiEnv(env);
  if (!config) return { skipped: true, reason: 'Hermes source proposals are not configured.' };
  const backfill = mode === 'backfill';
  const result = await supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/${backfill ? 'queue_hermes_story_proposals_backfill' : 'queue_hermes_story_proposals'}`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      p_now: new Date(now).toISOString(),
      p_limit: Math.min(100, Math.max(0, Number(limit) || 0)),
      ...(backfill ? { p_from: new Date(backfillFrom).toISOString(), p_to: new Date(backfillTo).toISOString() } : {})
    })
  }, 'Hermes source proposal queue');
  return result && typeof result === 'object' ? result : { queued: 0 };
}

async function xScoutWatchlistRows(fetchImpl, config) {
  const query = new URLSearchParams({
    active: 'eq.true',
    select: 'handle,source_registry_id,display_name,lead_types,prompt_hint,primary_sections,topic_tags,priority,editorial_fit',
    order: 'priority.desc,handle.asc'
  });
  const rows = await supabaseJson(fetchImpl, `${config.url}/rest/v1/x_scout_watchlist?${query}`, {
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` }
  }, 'X blind-spot watchlist lookup');
  return Array.isArray(rows) ? rows : [];
}

export async function queueXScoutStoryProposals(env, {
  fetchImpl = fetch,
  now = new Date(),
  limit = 10
} = {}) {
  const config = apiEnv(env);
  if (!config) return { skipped: true, reason: 'X blind-spot proposals are not configured.' };
  const result = await supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/queue_x_scout_story_proposals`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_now: new Date(now).toISOString(), p_limit: Math.min(25, Math.max(0, Number(limit) || 0)) })
  }, 'X blind-spot proposal queue');
  return result && typeof result === 'object' ? result : { queued: 0 };
}

export async function runXBlindSpotScout(env, {
  fetchImpl = fetch,
  now = new Date(),
  limit = 10,
  force = false,
  intervalMinutes = Number(env?.XAI_X_SCOUT_INTERVAL_MINUTES || X_SCOUT_INTERVAL_MINUTES),
  windowHours = X_SCOUT_WINDOW_HOURS,
  model = String(env?.XAI_X_SCOUT_MODEL || X_SCOUT_MODEL)
} = {}) {
  const config = apiEnv(env);
  if (!config) return { skipped: true, reason: 'X blind-spot scout is not configured.' };
  if (!String(env?.XAI_API_KEY || '').trim()) return { skipped: true, reason: 'XAI_API_KEY is not configured.' };
  const current = new Date(now);
  if (!force && intervalMinutes > 1 && current.getUTCMinutes() % intervalMinutes !== 0) {
    return { skipped: true, reason: 'X blind-spot scout is between scheduled intervals.', interval_minutes: intervalMinutes };
  }
  const watchlist = await xScoutWatchlistRows(fetchImpl, config);
  if (!watchlist.length) return { skipped: true, reason: 'X blind-spot watchlist is empty.' };
  const result = await searchXBlindSpots(env.XAI_API_KEY, { fetchImpl, now: current, watchlist, windowHours, model });
  const sourceByHandle = new Map(watchlist.map(row => [String(row.handle || '').toLowerCase(), row]));
  const sourceIds = [...new Set(watchlist.map(row => row.source_registry_id).filter(id => SOURCE_ID.test(String(id))))];
  const existingBySource = new Map(await Promise.all(sourceIds.map(async sourceId => [sourceId, await sourceEventsFor(fetchImpl, config, sourceId)])));
  const normalized = [];
  let duplicateCount = 0;
  let unmappedCount = 0;
  for (const lead of result.leads || []) {
    const watch = sourceByHandle.get(String(lead.handle || '').toLowerCase());
    if (!watch?.source_registry_id || !SOURCE_ID.test(String(watch.source_registry_id))) {
      unmappedCount += 1;
      continue;
    }
    const source = {
      id: watch.source_registry_id,
      name: watch.display_name || lead.display_name || lead.handle,
      source_type: 'x_account',
      handle_or_url: `https://x.com/${String(lead.handle || '').replace(/^@/, '')}`,
      primary_sections: Array.isArray(watch.primary_sections) ? watch.primary_sections : [],
      topic_tags: Array.isArray(watch.topic_tags) ? watch.topic_tags : []
    };
    const event = await normalizeEvent({
      external_id: lead.post_url,
      canonical_url: lead.post_url,
      title: xScoutEventTitle(lead),
      raw_text: lead.post_text,
      summary: lead.why_it_matters || lead.pipeline_miss_reason || lead.post_text,
      author_name: lead.handle,
      published_at: lead.posted_at,
      media: [],
      raw_payload: {
        x_scout: {
          lane: 'blind_spot',
          lead_type: lead.lead_type,
          why_it_matters: lead.why_it_matters,
          pipeline_miss_reason: lead.pipeline_miss_reason,
          confidence: lead.confidence,
          citations: lead.citations || []
        }
      }
    }, source, { now: current, fetcher: 'xai-x-search', responseMetadata: { model, window_hours: windowHours } });
    event.source_metadata = {
      ...(event.source_metadata || {}),
      scout_lane: 'blind_spot',
      watch_handle: lead.handle,
      lead_type: lead.lead_type,
      scout_confidence: lead.confidence,
      why_it_matters: lead.why_it_matters,
      pipeline_miss_reason: lead.pipeline_miss_reason,
      citations: lead.citations || []
    };
    const existing = existingBySource.get(String(watch.source_registry_id)) || [];
    if (duplicateEvent(existing, event)) {
      duplicateCount += 1;
      continue;
    }
    existing.push(event);
    normalized.push(event);
  }
  const inserted = await insertSourceEvents(fetchImpl, config, normalized);
  const proposals = await queueXScoutStoryProposals(env, { fetchImpl, now: current, limit });
  return {
    skipped: false,
    model,
    window_hours: windowHours,
    leads_found: (result.leads || []).length,
    events_considered: normalized.length + duplicateCount,
    events_inserted: Array.isArray(inserted) ? inserted.length : normalized.length,
    duplicates: duplicateCount,
    unmapped_handles: unmappedCount,
    proposals
  };
}

export async function queueGeneratePitchJobs(env, { fetchImpl = fetch, now = new Date(), limit = 2 } = {}) {
  const config = apiEnv(env);
  if (!config) return { skipped: true, reason: 'Qwen pitch jobs are not configured.' };
  const result = await supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/queue_generate_pitch_jobs`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_now: new Date(now).toISOString(), p_limit: Math.min(10, Math.max(0, Number(limit) || 0)) })
  }, 'Qwen pitch job queue');
  return result && typeof result === 'object' ? result : { jobs_created: 0 };
}

function normalizeBackfillRange(from, to, now = new Date()) {
  const fromDate = new Date(from || '');
  const toDate = new Date(to || '');
  const nowDate = new Date(now);
  if (!Number.isFinite(fromDate.getTime()) || !Number.isFinite(toDate.getTime()) || fromDate >= toDate) {
    throw Object.assign(new Error('Backfill requires a valid start before its end.'), { status: 400, code: 'INVALID_DISCOVERY_BACKFILL_RANGE' });
  }
  if (toDate > nowDate) throw Object.assign(new Error('Backfill cannot include future source items.'), { status: 400, code: 'INVALID_DISCOVERY_BACKFILL_RANGE' });
  if (toDate.getTime() - fromDate.getTime() > 90 * 24 * 60 * 60 * 1000) {
    throw Object.assign(new Error('Backfill is limited to a 90-day range per run.'), { status: 400, code: 'INVALID_DISCOVERY_BACKFILL_RANGE' });
  }
  return { from: fromDate.toISOString(), to: toDate.toISOString() };
}

function discoveryRunOptions(body, now = new Date()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Discovery run options must be an object.'), { status: 400, code: 'INVALID_DISCOVERY_OPTIONS' });
  const mode = body.mode || 'scheduled';
  if (mode === 'scheduled') return { mode, trigger: 'manual' };
  if (mode !== 'backfill') throw Object.assign(new Error('Discovery mode must be scheduled or backfill.'), { status: 400, code: 'INVALID_DISCOVERY_MODE' });
  const range = normalizeBackfillRange(body.from || body.backfill_from, body.to || body.backfill_to, now);
  return { mode, trigger: 'backfill', backfillFrom: range.from, backfillTo: range.to };
}

export async function runDiscoveryWorkflow(env, {
  fetchImpl = fetch,
  now = new Date(),
  trigger = 'scheduled',
  requestedBy = null,
  sourceLimit = 3,
  proposalLimit = 25,
  pitchLimit = 2,
  mode = 'scheduled',
  backfillFrom = null,
  backfillTo = null
} = {}) {
  const config = apiEnv(env);
  if (!config) throw new Error('Source Graph discovery is not configured on this deployment.');
  const normalizedRange = mode === 'backfill' ? normalizeBackfillRange(backfillFrom, backfillTo, now) : null;
  if (!['scheduled', 'backfill'].includes(mode)) throw Object.assign(new Error('Discovery mode must be scheduled or backfill.'), { status: 400, code: 'INVALID_DISCOVERY_MODE' });
  const discoveryTrigger = mode === 'backfill' ? 'backfill' : trigger;
  const started = await pipelineRpc(fetchImpl, config, 'start_source_graph_discovery_run', {
    p_trigger: discoveryTrigger,
    p_requested_by: requestedBy
  });
  if (!started?.started) return started || { started: false, skipped: true, reason: 'not_started' };
  const runId = started.run_id;
  const counts = {
    sources_scanned: 0,
    items_fetched: 0,
    new_source_events: 0,
    stale_items_skipped: 0,
    duplicate_items_skipped: 0,
    items_entering_scoring: 0,
    candidates_scored: 0,
    passed_threshold: 0,
    generate_pitch_jobs_created: 0,
    pitches_generated: 0,
    x_scout_leads_found: 0,
    x_scout_events_inserted: 0,
    x_scout_duplicates: 0,
    x_scout_proposals_queued: 0,
    failures: 0
  };
  try {
    const settings = started.settings || {};
    const freshnessPolicy = freshnessPolicyFromSettings(settings);
    const ingestion = await runSourceIngestionScheduler(env, {
      fetchImpl,
      now,
      limit: Number(settings.source_batch_size) || sourceLimit,
      mode,
      force: trigger === 'manual',
      backfillFrom: normalizedRange?.from || null,
      backfillTo: normalizedRange?.to || null,
      freshnessPolicy
    });
    counts.sources_scanned = Number(ingestion.claimed || 0);
    counts.items_fetched = Number(ingestion.items_fetched || 0);
    counts.new_source_events = (ingestion.results || []).reduce((total, result) => total + Number(result.inserted || 0), 0);
    counts.stale_items_skipped = Number(ingestion.stale_items_skipped || 0);
    counts.duplicate_items_skipped = Number(ingestion.duplicate_items_skipped || 0);
    counts.failures += (ingestion.results || []).filter(result => result.status === 'failed' || result.error).length;
    const xScout = mode === 'scheduled'
      ? await runXBlindSpotScout(env, { fetchImpl, now, limit: Number(settings.proposal_batch_size) || 10, force: trigger === 'manual' })
      : { skipped: true, reason: 'X blind-spot scout does not run during backfill.' };
    counts.x_scout_leads_found = Number(xScout.leads_found || 0);
    counts.x_scout_events_inserted = Number(xScout.events_inserted || 0);
    counts.x_scout_duplicates = Number(xScout.duplicates || 0);
    counts.x_scout_proposals_queued = Number(xScout.proposals?.queued || 0);
    const proposals = await queueHermesStoryProposals(env, {
      fetchImpl,
      now,
      limit: Number(settings.proposal_batch_size) || proposalLimit,
      mode,
      backfillFrom: normalizedRange?.from || null,
      backfillTo: normalizedRange?.to || null
    });
    counts.items_entering_scoring = Number(proposals.items_entering_scoring ?? proposals.candidates_scored ?? proposals.queued ?? 0);
    counts.candidates_scored = counts.items_entering_scoring;
    counts.passed_threshold = Number(proposals.passed_threshold ?? proposals.queued ?? 0);
    const jobs = await queueGeneratePitchJobs(env, { fetchImpl, now, limit: Number(settings.pitch_batch_size) || pitchLimit });
    counts.generate_pitch_jobs_created = Number(jobs.jobs_created || 0);
    await pipelineRpc(fetchImpl, config, 'finish_source_graph_discovery_run', {
      p_run_id: runId,
      p_status: 'succeeded',
      p_counts: counts,
      p_error: null
    });
    return { ...started, status: 'succeeded', counts, ingestion, proposals, jobs };
  } catch (error) {
    counts.failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    try {
      await pipelineRpc(fetchImpl, config, 'finish_source_graph_discovery_run', {
        p_run_id: runId,
        p_status: 'failed',
        p_counts: counts,
        p_error: message
      });
    } catch (finishError) {
      console.error('Source Graph discovery run could not be finalized', finishError);
    }
    throw error;
  }
}

export async function handleDiscoveryOperationsApi(request, env, fetchImpl = fetch, executionContext = null) {
  const url = new URL(request.url);
  const retry = url.pathname.match(/^\/api\/newsroom\/discovery\/proposals\/([0-9a-f-]{36})\/retry$/i);
  const status = url.pathname === '/api/newsroom/discovery/status';
  const run = url.pathname === '/api/newsroom/discovery/run';
  const settings = url.pathname === '/api/newsroom/discovery/settings';
  if (!status && !run && !settings && !retry) return null;
  try {
    const { config, profile } = await newsroomActor(request, env, fetchImpl);
    if (status) {
      if (request.method !== 'GET') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      return jsonResponse(request, 200, await pipelineRpc(fetchImpl, config, 'get_source_graph_discovery_status', {}));
    }
    if (run) {
      if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      const options = discoveryRunOptions(await optionalRequestJson(request));
      const work = runDiscoveryWorkflow(env, { fetchImpl, trigger: options.trigger, requestedBy: profile.id, mode: options.mode, backfillFrom: options.backfillFrom, backfillTo: options.backfillTo });
      if (executionContext?.waitUntil) {
        executionContext.waitUntil(work.catch(error => console.error('Manual Source Graph discovery failed', error)));
        return jsonResponse(request, 202, { accepted: true, mode: options.mode, message: options.mode === 'backfill' ? 'Discovery backfill started. Refresh this surface for the result.' : 'Discovery run started. Refresh this surface for the result.' });
      }
      return jsonResponse(request, 200, await work);
    }
    if (settings) {
      if (request.method !== 'POST') return apiError(request, 405, 'Method not allowed.', 'METHOD_NOT_ALLOWED');
      const body = await requestJson(request);
      if (typeof body?.enabled !== 'boolean') throw Object.assign(new Error('Discovery enabled must be true or false.'), { status: 400, code: 'INVALID_DISCOVERY_SETTINGS' });
      const saved = await pipelineRpc(fetchImpl, config, 'save_source_graph_discovery_settings', { p_enabled: body.enabled, p_requested_by: profile.id });
      return jsonResponse(request, 200, { settings: saved });
    }
    if (request.method !== 'POST' || !UUID.test(retry?.[1] || '')) return apiError(request, 400, 'Proposal ID is invalid.', 'INVALID_PROPOSAL');
    const result = await pipelineRpc(fetchImpl, config, 'retry_generate_pitch', { p_proposal_id: retry[1], p_requested_by: profile.id });
    return jsonResponse(request, result?.duplicate ? 200 : 201, result);
  } catch (error) {
    return apiError(request, Number(error?.status) || (error?.code === 'UNAUTHENTICATED' ? 401 : error?.code === 'EDITOR_REQUIRED' ? 403 : 400), error instanceof Error ? error.message : 'Discovery operation failed.', error?.code || 'DISCOVERY_OPERATION_FAILED');
  }
}

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishDueStories(env).catch(error => console.error('Scheduled publishing failed', error)));
    ctx.waitUntil(runDiscoveryWorkflow(env).catch(error => console.error('Scheduled Source Graph discovery failed', error)));
  },
  async fetch(request, env, ctx) {
    const earlyRedirect = canonicalRedirect(request, env);
    if (earlyRedirect) return earlyRedirect;
    const earlyUrl = new URL(request.url);
    if ((request.method === 'GET' || request.method === 'HEAD') && FINGERPRINTED_ASSET.test(earlyUrl.pathname)) {
      try {
        const asset = await fetchAsset(request, env);
        return withResponseHeaders(asset, request);
      } catch (error) {
        console.error('Fingerprint asset request failed', error);
        return textResponse(request, 503, 'Service Unavailable');
      }
    }
    const publicApi = await handlePublicApi(request, env);
    if (publicApi) return publicApi;
    const analytics = await handleAnalyticsApi(request, env);
    if (analytics) return analytics;
    const xBrowser = await handleXBrowserApi(request, env);
    if (xBrowser) return xBrowser;
    const sourceIngestion = await handleSourceIngestionApi(request, env);
    if (sourceIngestion) return sourceIngestion;
    const discoveryOperations = await handleDiscoveryOperationsApi(request, env, fetch, ctx);
    if (discoveryOperations) return discoveryOperations;
    const mediaPipeline = await handleMediaPipelineApi(request, env);
    if (mediaPipeline) return mediaPipeline;
    const editorialScoring = await handleEditorialScoringApi(request, env);
    if (editorialScoring) return editorialScoring;
    const lunaEditorial = await handleLunaEditorialApi(request, env);
    if (lunaEditorial) return lunaEditorial;
    const editorialAutomation = await handleEditorialAutomationApi(request, env);
    if (editorialAutomation) return editorialAutomation;
    const api = await handlePipelineApi(request, env);
    if (api) return api;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return textResponse(request, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    const url = earlyUrl;
    if (url.pathname === '/robots.txt') {
      const origin = canonicalOrigin(env, url);
      return textResponse(request, 200, `User-agent: *\nDisallow: /newsroom\nDisallow: /api/\nDisallow: /search\nSitemap: ${origin}/sitemap.xml\n`, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    if (url.pathname === '/feed.xml') return feedResponse(request, env, 'xml');
    if (url.pathname === '/feed.json') return feedResponse(request, env, 'json');
    if (url.pathname === '/sitemap.xml') return sitemapResponse(request, env);
    const redirect = LEGACY_TAXONOMY_REDIRECTS.get(url.pathname.replace(/\/$/, ''));
    if (redirect) return withResponseHeaders(new Response(null, { status: 308, headers: { Location: redirect + url.search } }), request);
    try {
      const publicPage = await publicPageResponse(request, env, url);
      if (publicPage) return withResponseHeaders(publicPage, request);
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
      if (url.pathname.startsWith('/newsroom')) {
        const shellText = await shell.text();
        const newsroomShell = shellText
          .replace(/<title>[^<]*<\/title>/i, '<title>Newsroom | Anyways</title>')
          .replace(/<meta\s+name="robots"\s+content="[^"]*"\s*\/?>(?:\s*)/i, '<meta name="robots" content="noindex,nofollow">');
        return withResponseHeaders(new Response(request.method === 'HEAD' ? null : newsroomShell, { status: shell.status, statusText: shell.statusText, headers: new Headers(shell.headers) }), request);
      }
      return withResponseHeaders(shell, request);
    } catch (error) {
      console.error('Static asset request failed', error);
      return textResponse(request, 503, 'Service Unavailable');
    }
  }
};
