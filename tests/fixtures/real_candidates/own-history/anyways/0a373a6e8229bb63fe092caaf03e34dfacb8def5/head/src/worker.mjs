import { validateNewsroomJobRequest } from './newsroom-pipeline-controls.mjs';
import { canonicalizeUrl, fetchSource, isSafeFetchUrl, normalizeEvent } from './source-ingestion.mjs';
import { cacheMediaAsset, derivativePlans, heroEligibility, normalizeSourceEventMedia } from './media-pipeline.mjs';

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
  /* JS-driven motion (reading progress, parallax drift) writes style props
     from rAF handlers; attributes in markup itself stay authored in CSS. */
  "style-src-attr 'unsafe-inline'",
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
const NEWSROOM_COLLECTION_ROUTE = /^\/newsroom\/(?:pitches|stories|published|homepage|ideas|settings|editorial-candidates)\/?$/i;
const IMAGE_ASSET = /\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
const ANALYTICS_EVENT_TYPES = new Set(['page_view', 'engaged', 'scroll', 'outbound', 'share']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEGACY_TAXONOMY_REDIRECTS = new Map([
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
  return Array.isArray(rows) ? rows : [];
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
  const query = new URLSearchParams({ source_id: `eq.${sourceId}`, select: 'external_id,canonical_url,content_hash', limit: '10000' });
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

async function processSourceClaim(fetchImpl, config, claim, now) {
  const source = { ...claim, id: claim.source_id, active: true, review_status: 'ready', ingestion_status: 'ready', handle_or_url: claim.handle_or_url, source_type: claim.source_type };
  try {
    const result = await fetchSource(source, { fetchImpl, now });
    if (result.notModified) {
      await finishSourceIngestion(fetchImpl, config, claim, { status: 'not_modified', responseMetadata: result.responseMetadata, fetcher: result.fetcher });
      return { source_id: claim.source_id, status: 'not_modified', inserted: 0, duplicates: 0 };
    }
    const existing = await sourceEventsFor(fetchImpl, config, claim.source_id);
    const normalized = [];
    let duplicateCount = 0;
    for (const item of result.items) {
      try {
        const event = await normalizeEvent(item, source, { now, fetcher: result.fetcher, responseMetadata: result.responseMetadata });
        if (existing.some(row => row.external_id === event.external_id || (row.canonical_url && row.canonical_url === event.canonical_url) || row.content_hash === event.content_hash) || normalized.some(row => row.external_id === event.external_id || (row.canonical_url && row.canonical_url === event.canonical_url) || row.content_hash === event.content_hash)) duplicateCount += 1;
        else normalized.push({ ...event, ingestion_run_id: claim.run_id });
      } catch { duplicateCount += 1; }
    }
    const inserted = await insertSourceEvents(fetchImpl, config, normalized);
    const responseMetadata = { ...(result.responseMetadata || {}) };
    const status = normalized.length && (Array.isArray(inserted) ? inserted.length : normalized.length) < normalized.length ? 'degraded' : 'healthy';
    await finishSourceIngestion(fetchImpl, config, claim, { status, fetchedCount: result.items.length, insertedCount: Array.isArray(inserted) ? inserted.length : normalized.length, duplicateCount, errorCount: 0, responseMetadata, fetcher: result.fetcher });
    return { source_id: claim.source_id, status, inserted: Array.isArray(inserted) ? inserted.length : normalized.length, duplicates: duplicateCount };
  } catch (error) {
    const status = 'failed';
    await finishSourceIngestion(fetchImpl, config, claim, { status, fetchedCount: 0, errorCount: 1, errorSummary: error instanceof Error ? error.message : 'Source fetch failed.', responseMetadata: {}, fetcher: 'error' });
    return { source_id: claim.source_id, status, inserted: 0, duplicates: 0, error: error instanceof Error ? error.message : 'Source fetch failed.' };
  }
}

export async function runSourceIngestionScheduler(env, { fetchImpl = fetch, now = new Date(), limit = 3 } = {}) {
  const config = apiEnv(env);
  if (!config) return { skipped: true, reason: 'Source ingestion is not configured.' };
  const claims = await supabaseJson(fetchImpl, `${config.url}/rest/v1/rpc/claim_source_ingestion_batch`, {
    method: 'POST',
    headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_now: new Date(now).toISOString(), p_limit: Math.min(3, Math.max(0, Number(limit) || 0)), p_lease_seconds: 90 })
  }, 'Source ingestion claim');
  const results = [];
  for (const claim of Array.isArray(claims) ? claims.slice(0, 3) : []) results.push(await processSourceClaim(fetchImpl, config, claim, new Date(now)));
  return { skipped: false, claimed: results.length, results };
}

export default {
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(publishDueStories(env).catch(error => console.error('Scheduled publishing failed', error)));
    ctx.waitUntil(runSourceIngestionScheduler(env).catch(error => console.error('Source ingestion scheduler failed', error)));
  },
  async fetch(request, env) {
    const analytics = await handleAnalyticsApi(request, env);
    if (analytics) return analytics;
    const xBrowser = await handleXBrowserApi(request, env);
    if (xBrowser) return xBrowser;
    const sourceIngestion = await handleSourceIngestionApi(request, env);
    if (sourceIngestion) return sourceIngestion;
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
