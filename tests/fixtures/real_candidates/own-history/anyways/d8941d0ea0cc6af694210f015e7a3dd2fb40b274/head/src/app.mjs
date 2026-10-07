import { createClient } from '@supabase/supabase-js';
import { ARTICLE_LENGTHS, BEAT_ORDER, EDITORIAL_CLASSIFICATION_HELP, SECTION_ORDER, SECTION_PROMISES, STORY_FORMS } from './editorial.mjs';
import { PIPELINE_QUEUE_STATUSES, filterPipelineQueue, lineDiff, pipelineMetadata } from './newsroom-pipeline.mjs';
import { materializationState } from './pipeline/materialization.mjs';
import { ACTIVE_PIPELINE_JOB_STATUSES, PIPELINE_JOB_STATUSES, canRetryNewsroomPipelineJob, candidatePipelineAction, concisePipelineError, isPipelineV1Job, pipelineReviewHref, researchAgainDetails, researchAgainRequest, validateNewsroomJobRequest } from './newsroom-pipeline-controls.mjs';
import { ARTICLE_ACCENTS, ARTICLE_COMPOSITIONS, INLINE_IMAGE_LAYOUTS, decodeEntities, normalizePresentation, renderArticle } from './article-renderer.mjs';
import { IMAGE_LICENSE_OPTIONS, IMAGE_RIGHTS_BASIS_OPTIONS, PHOTO_PERMISSION_OPTIONS, STORY_MEDIA_BUCKET, imageIsPublishable, imageRightsPayload, normalizeImageRightsWorkflow, presentationForSave, storyMediaPath, storyMediaType, suggestedCreditLine, validateImageUrl, validateStoryMedia } from './newsroom-media.mjs';
import { parseStoryEmbed } from './story-embeds.mjs';
import { IMAGE_RIGHTS_POLICY, validateImageRights } from './image-rights-policy.mjs';
import { editorStatusLabel, lensLabel, modelLabel, NEWSROOM_LENSES, NEWSROOM_SECTIONS, PIPELINE_STAGE_LABELS, sectionLabel, topicLabel, beatLabel, pipelineStageIndex } from './newsroom-taxonomy.mjs';
import { canonicalSectionId } from './editorial.mjs';
import { EDITORIAL_STATUSES, deriveEditorialStatus, editorialActivityDate, editorialBlockingIssue, editorialStatusLabel } from './editorial-status.mjs';
import { aggregatePipelineHealth } from './pipeline/health.mjs';
import { executionTimeline } from './pipeline/execution-timeline.mjs';
import { replayPlan } from './pipeline/phase2-replay.mjs';
import { DEFAULT_WRITER_SELECTION, LENGTH_OPTIONS, WRITER_OPTIONS, lengthOption, writerOption } from './writer-selection.mjs';
import { distinctSourceCount, discoveryEnrichmentRetryable, editorReadyPitch, pitchEnrichmentReason, pitchInboxStatus, pitchRecord } from './pipeline/discovery-pitch.mjs';
import { PHOTO_CLEANUP_TIMEOUT_MS, PHOTO_RECORD_TIMEOUT_MS, PHOTO_UPLOAD_TIMEOUT_MS, inspectPhotoSource, inspectVideoSource, withPhotoTimeout } from './photo-operations.mjs';
import { DEFAULT_DISCOVERY_FOCUS_ID, DISCOVERY_FOCUSES, DISCOVERY_FOCUS_IDS, discoveryFocus } from './pipeline/discovery-focuses.mjs';
import { mockIdeaPitches } from './pipeline/idea-pitches.mjs';
import { INGESTION_STATUS, INGESTION_STATUSES, PLATFORM_OPTIONS, REVEAL_IDENTITY_POLICIES, REVIEW_STATUSES, SOURCE_CLASSES, SOURCE_TYPES, TRUST_LEVELS, duplicateSourceKeys, exportSourceRegistryCSV, parseSourceRegistryImport, validateSourceRecord } from './source-registry.mjs';
import { homepageSectionGroups, rankHomepageStories } from './homepage-ranking.mjs';
import { removeTrackingParameters, resolveAttribution } from './analytics-attribution.mjs';

/* Anyways · public signal view layer.
   Public presentation is intentionally isolated from the newsroom. Data access,
   authentication, workflow, and routing behavior stay unchanged. */

const config = window.ANYWAYS_CONFIG || {};
const sb = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false
  }
});
const app = document.querySelector('#app');
const isPublicRoute = !location.pathname.startsWith('/newsroom');
document.body.classList.toggle('public-site', isPublicRoute);
document.body.classList.toggle('newsroom-site', !isPublicRoute);
document.body.classList.toggle('route-home', location.pathname === '/');
document.body.classList.toggle('route-story', location.pathname.startsWith('/stories/'));
document.body.classList.toggle('route-interior', isPublicRoute && location.pathname !== '/');
document.querySelector('meta[name="robots"]')?.setAttribute('content', isPublicRoute ? 'index,follow' : 'noindex,nofollow');

function randomId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, byte => ('0' + byte.toString(16)).slice(-2)).join('');
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  }
  return Date.now().toString(16) + '-' + Math.random().toString(16).slice(2) + '-' + Math.random().toString(16).slice(2);
}

/* First-party reader signals. This deliberately avoids IP addresses, user
   agents, full referrer URLs, and all Newsroom routes. */
function analyticsSessionId() {
  try {
    const existing = sessionStorage.getItem('anyways.analytics.session');
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem('anyways.analytics.session', created);
    return created;
  } catch { return ''; }
}

function analyticsReferrerHost() {
  try {
    const referrer = document.referrer ? new URL(document.referrer) : null;
    return referrer && referrer.origin !== location.origin ? referrer.hostname : '';
  } catch { return ''; }
}

function storedAttribution(key, fallback = null) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return value && typeof value === 'object' ? value : fallback;
  } catch { return fallback; }
}

function sessionAttribution() {
  try {
    const value = JSON.parse(sessionStorage.getItem('anyways.analytics.attribution') || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }
}

function isInternalReferrer() {
  try { return Boolean(document.referrer) && new URL(document.referrer).origin === location.origin; }
  catch { return false; }
}

function captureAnalyticsAttribution() {
  const resolved = resolveAttribution({ url: location.href, referrer: document.referrer, siteOrigin: location.origin });
  const attribution = isInternalReferrer() ? (sessionAttribution() || resolved) : resolved;
  const firstTouch = storedAttribution('anyways.analytics.first-touch');
  try {
    if (!firstTouch) localStorage.setItem('anyways.analytics.first-touch', JSON.stringify(attribution));
    sessionStorage.setItem('anyways.analytics.attribution', JSON.stringify(attribution));
  } catch {}
  const clean = removeTrackingParameters(location.href);
  if (clean.changed) history.replaceState(null, '', `${clean.url.pathname}${clean.url.search}${clean.url.hash}`);
  return { session: attribution, first: firstTouch || attribution };
}

function installAnalytics() {
  if (!isPublicRoute || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  const sessionId = analyticsSessionId();
  if (!sessionId) return;
  const attribution = captureAnalyticsAttribution();
  const path = location.pathname;
  const send = (eventType, eventValue = null, detail = '') => {
    const payload = JSON.stringify({
      event_type: eventType, session_id: sessionId, path, landing_page: path,
      referrer_host: attribution.session.referrer_host || analyticsReferrerHost(),
      session_source: attribution.session.source, session_medium: attribution.session.medium,
      session_campaign: attribution.session.campaign, session_content: attribution.session.content,
      first_source: attribution.first.source, first_medium: attribution.first.medium,
      first_campaign: attribution.first.campaign, first_content: attribution.first.content,
      event_value: eventValue, detail
    });
    fetch('/api/analytics/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
  };
  send('page_view');
  let activeStartedAt = document.visibilityState === 'visible' ? Date.now() : 0;
  const reportEngagement = () => {
    if (!activeStartedAt) return;
    const seconds = Math.floor((Date.now() - activeStartedAt) / 1000);
    activeStartedAt = 0;
    if (seconds > 0) send('engaged', Math.min(seconds, 86400));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reportEngagement();
    else activeStartedAt = Date.now();
  });
  window.addEventListener('pagehide', reportEngagement, { once: true });
  const sentDepths = new Set();
  const reportScroll = () => {
    const height = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const depth = height ? Math.round((window.scrollY / height) * 100) : 100;
    [25, 50, 75, 100].forEach(mark => {
      if (depth >= mark && !sentDepths.has(mark)) { sentDepths.add(mark); send('scroll', mark); }
    });
  };
  window.addEventListener('scroll', reportScroll, { passive: true });
  reportScroll();
  document.addEventListener('click', event => {
    const shareControl = event.target.closest('[data-share-destination]');
    if (shareControl) send('share', null, shareControl.dataset.shareDestination || 'share');
    const link = event.target.closest('a[href]');
    if (!link) return;
    try {
      const destination = new URL(link.href, location.href);
      if (destination.origin !== location.origin) send('outbound', null, destination.hostname);
    } catch {}
  });
}

installAnalytics();

/* ---------- Shared editorial helpers (same rules as the local application) ---------- */

const esc = s => decodeEntities(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const humanize = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const workflowLabel = s => EDITORIAL_STATUSES.includes(String(s || '')) ? editorialStatusLabel(s) : editorStatusLabel(s);
const slugify = s => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 96);

function externalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return '';
    return url.href;
  } catch {
    return '';
  }
}

function imageRightsRecord(values, { originalFileUrl = '', defaultProvider = '', existingRecord = {} } = {}) {
  let sourceMetadata = existingRecord?.source_metadata && typeof existingRecord.source_metadata === 'object' ? existingRecord.source_metadata : null;
  if (values.has('source_metadata')) {
    try { sourceMetadata = JSON.parse(String(values.get('source_metadata') || '{}')); } catch { sourceMetadata = null; }
  }
  const previous = normalizeImageRightsWorkflow(existingRecord);
  const input = (name, fallback = '') => values.has(name) ? String(values.get(name) || '').trim() : fallback;
  const permissionStatus = input('permission_status', input('rights_basis', previous.rights_basis || 'not_verified'));
  const sourcePageUrl = input('source_url', input('source_page_url', existingRecord?.source_page_url || existingRecord?.source_url || ''));
  const rightsDetails = {
    rights_holder: input('rights_holder', previous.rights_holder),
    permission_contact: input('permission_contact', previous.permission_contact),
    permission_date: input('permission_date', previous.permission_date),
    usage_restrictions: input('license_notes', input('usage_restrictions', previous.usage_restrictions)),
    expiration_date: input('expiration_date', previous.expiration_date),
    proof_url: externalUrl(input('permission_evidence', input('proof_url', previous.proof_url))) || '',
    public_domain_basis: input('public_domain_basis', previous.public_domain_basis),
    required_attribution: input('required_attribution', previous.required_attribution),
    internal_rights_notes: input('internal_notes', input('internal_rights_notes', previous.internal_rights_notes))
  };
  return {
    provider: input('provider', existingRecord?.provider || defaultProvider || ''),
    source_page_url: externalUrl(sourcePageUrl) || '',
    original_file_url: originalFileUrl || externalUrl(input('original_file_url', existingRecord?.original_file_url || existingRecord?.original_url || '')) || '',
    creator: input('creator', existingRecord?.creator || ''),
    license_code: input('license_code', existingRecord?.license_code || ''),
    license_url: externalUrl(input('license_url', existingRecord?.license_url || '')) || '',
    credit_line: input('credit_line', existingRecord?.credit_line || existingRecord?.credit || ''),
    commercial_use_allowed: values.has('commercial_use_allowed') ? values.get('commercial_use_allowed') === 'true' : existingRecord?.commercial_use_allowed === true,
    modification_allowed: values.has('modification_allowed') ? values.get('modification_allowed') === 'true' : existingRecord?.modification_allowed === true,
    verification_method: input('verification_method', existingRecord?.verification_method || ''),
    verification_timestamp: input('verification_timestamp', existingRecord?.verification_timestamp || ''),
    source_metadata: sourceMetadata,
    rights_basis: permissionStatus,
    rights_details: rightsDetails,
    editorial_approved: values.has('editorial_approved') ? values.get('editorial_approved') === 'true' : existingRecord?.editorial_approved === true,
    rights_note: rightsDetails.internal_rights_notes
  };
}

function imageRightsFields({ prefix = 'photo', record = {} } = {}) {
  const workflow = normalizeImageRightsWorkflow(record);
  const license = String(record.license_code || '');
  return `<section class="photo-metadata-group photo-rights-group" data-rights-workflow>
    <h3>Rights</h3>
    <div class="photo-field-grid">
      <label>Rights status<select name="rights_basis" data-rights-basis>${IMAGE_RIGHTS_BASIS_OPTIONS.map(item => `<option value="${esc(item.value)}" ${workflow.rights_basis === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
      <label>Source page URL<input name="source_page_url" type="url" maxlength="2048" value="${esc(record.source_page_url || '')}" placeholder="Page where this image was found"></label>
    </div>
    <p class="field-note" data-rights-not-verified ${workflow.rights_basis === 'not_verified' ? '' : 'hidden'}>Not verified images can be used in the editor, but cannot be published.</p>
    <div class="rights-conditional" data-rights-when="licensed" ${workflow.rights_basis === 'licensed' ? '' : 'hidden'}>
      <label>Rights holder<input name="rights_holder" maxlength="240" value="${esc(workflow.rights_holder)}"></label>
      <label>Usage restrictions<textarea name="usage_restrictions" class="textarea-short">${esc(workflow.usage_restrictions)}</textarea></label>
      <label>Proof of license URL or file<input name="proof_url" type="url" maxlength="2048" value="${esc(workflow.proof_url)}" placeholder="https://"></label>
    </div>
    <div class="rights-conditional" data-rights-when="permission_granted" ${workflow.rights_basis === 'permission_granted' ? '' : 'hidden'}>
      <label>Rights holder<input name="rights_holder" maxlength="240" value="${esc(workflow.rights_holder)}"></label>
      <label>Permission contact<input name="permission_contact" maxlength="240" value="${esc(workflow.permission_contact)}"></label>
      <label>Permission date<input name="permission_date" type="date" value="${esc(workflow.permission_date)}"></label>
      <label>Usage restrictions<textarea name="usage_restrictions" class="textarea-short">${esc(workflow.usage_restrictions)}</textarea></label>
      <label>Proof of permission URL or file<input name="proof_url" type="url" maxlength="2048" value="${esc(workflow.proof_url)}" placeholder="https://"></label>
    </div>
    <div class="rights-conditional" data-rights-when="public_domain" ${workflow.rights_basis === 'public_domain' ? '' : 'hidden'}>
      <label>Public-domain basis or note<textarea name="public_domain_basis" class="textarea-short">${esc(workflow.public_domain_basis)}</textarea></label>
    </div>
    <div class="rights-conditional" data-rights-when="creative_commons" ${workflow.rights_basis === 'creative_commons' ? '' : 'hidden'}>
      <label>Required attribution<input name="required_attribution" maxlength="320" value="${esc(workflow.required_attribution)}"></label>
    </div>
    <details class="advanced-rights-details"><summary>Advanced rights details</summary>
      <div class="photo-field-grid">
        <label>Photographer or creator<input name="creator" maxlength="240" value="${esc(record.creator || '')}"></label>
        <label>License type<select name="license_code"><option value="">Choose a license</option>${IMAGE_LICENSE_OPTIONS.map(item => `<option value="${esc(item.value)}" ${license === item.value ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
        <label>License URL<input name="license_url" type="url" maxlength="2048" value="${esc(record.license_url || '')}" placeholder="https://"></label>
        <label>Expiration date<input name="expiration_date" type="date" value="${esc(workflow.expiration_date)}"></label>
        <label class="photo-field-span">Internal rights notes<textarea name="internal_rights_notes" class="textarea-short">${esc(workflow.internal_rights_notes)}</textarea></label>
        <label><input name="commercial_use_allowed" type="checkbox" value="true" ${record.commercial_use_allowed ? 'checked' : ''}> Commercial use is explicitly allowed</label>
        <label><input name="modification_allowed" type="checkbox" value="true" ${record.modification_allowed ? 'checked' : ''}> Modification is explicitly allowed</label>
      </div>
    </details>
  </section>`;
}

function mediaUrl(value) {
  const raw = String(value || '');
  if (raw.startsWith('/') && !raw.startsWith('//')) {
    try {
      const base = String(config.supabaseUrl || '').replace(/\/$/, '');
      const resolved = new URL(raw, `${base}/`);
      return resolved.protocol === 'https:' ? resolved.href : '';
    } catch {
      return '';
    }
  }
  return externalUrl(raw);
}

function resolvePresentationMedia(presentation) {
  const hero = presentation?.hero;
  if (!hero || typeof hero !== 'object') return presentation;
  const url = mediaUrl(hero.public_url || hero.url || hero.original_url);
  return url
    ? { ...presentation, hero: { ...hero, public_url: url, url, original_url: url } }
    : presentation;
}

function isVideoItem(value = {}) {
  const url = String(value.public_url || value.original_url || value.url || '');
  return value.media_type === 'video' || storyMediaType(value) === 'video' || /\.(?:mp4|webm)(?:[?#]|$)/i.test(url);
}

function defaultImageAlt(filename, storyTitle = '') {
  const label = String(filename || '').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return label || (storyTitle ? `Image for ${storyTitle}` : 'Article image');
}

function externalMediaMimeType(value) {
  const pathname = (() => { try { return new URL(value).pathname.toLowerCase(); } catch { return ''; } })();
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.avif')) return 'image/avif';
  if (pathname.endsWith('.mp4')) return 'video/mp4';
  if (pathname.endsWith('.webm')) return 'video/webm';
  return 'image/jpeg';
}

function externalImageFilename(value) {
  try {
    const pathname = new URL(value).pathname.split('/').filter(Boolean).at(-1);
    return pathname ? decodeURIComponent(pathname).slice(0, 180) : 'external-image.jpg';
  } catch {
    return 'external-image.jpg';
  }
}

async function dataOf(request, context) {
  const { data, error } = await request;
  if (error) {
    console.error(`Anyways data request failed: ${context}`);
    throw new Error(context);
  }
  return data;
}

async function optionalColumn(request) {
  const { data } = await request;
  return data || [];
}

function setBusy(form, busy, label = 'Working…') {
  const button = form?.querySelector('button[type="submit"], button:not([type])');
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
  } else {
    button.textContent = button.dataset.label || button.textContent;
    button.disabled = false;
    form.removeAttribute('aria-busy');
  }
}

function showFormMessage(form, message, kind = 'error') {
  const region = form?.querySelector('[data-form-message]');
  if (!region) return;
  region.textContent = message;
  region.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`;
  region.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
  region.hidden = !message;
}

function saveStoryFailureMessage(error) {
  const code = String(error?.code || '');
  const message = String(error?.message || '').trim();
  if (code === '40001' || /revision conflict/i.test(message)) return 'This story changed in another session. Reload this editor, then save your edits again.';
  if (code === '23514' || /imagery requires a valid rights decision/i.test(message)) return 'The selected hero or inline image needs a valid rights decision before this article can move forward.';
  if (code === '42501' || /cannot be edited|membership is required/i.test(message)) return 'This account does not currently have permission to save this story. Reload and sign in again, then try once more.';
  if (code === '23505' || /duplicate key|already exists/i.test(message)) return 'Another story already uses this slug. Change the slug in Publishing, then save again.';
  return message ? `The story could not be saved: ${message}` : 'The story could not be saved. Reload the editor and try again.';
}

const dLong = d => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const dShort = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dDateTime = d => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const localDateTimeValue = d => {
  const date = new Date(d);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/* Every published story carries a signal index, assigned in edition order. */
function numerals(stories) {
  const map = new Map();
  stories.filter(isPublished).slice().sort((a, b) => new Date(a.published_at) - new Date(b.published_at)).forEach((s, i) => map.set(s.id, i + 1));
  return map;
}
const isPublished = s => s.status === 'published' && s.published_at && new Date(s.published_at) <= new Date();

/* The promise each section makes to the reader, from the Anyways Handbook. */
const promises = SECTION_PROMISES;
const sectionOrder = SECTION_ORDER;
const statuses = ['idea', 'researching', 'draft', 'review', 'fact_check', 'scheduled', 'published', 'hidden', 'archived'];
const sourceTypes = ['article', 'official_announcement', 'filing', 'research_paper', 'court_document', 'legislation', 'earnings_report', 'documentation', 'video', 'podcast', 'social_post', 'dataset', 'repository', 'other'];
const publicStorySelect = [
  'id', 'title', 'slug', 'dek', 'summary', 'body', 'section_id', 'status',
  'published_at', 'updated_at', 'reading_time_minutes', 'hero_media_id', 'presentation',
  'seo_title', 'seo_description',
  'sections!stories_section_id_fkey(name,slug)', 'story_sections!story_sections_story_id_fkey(section_id,sections(name,slug))', 'story_beats(beats(name,slug))', 'story_tags(tags(name,slug))'
].join(',');

function storyBelongsToSection(story, sectionId) {
  return story?.section_id === sectionId
    || (story?.story_sections || []).some(item => (item.section_id || item.sections?.slug) === sectionId);
}

/* ---------- The public edition: twelve permanent story inks ----------
   The complete catalog yields one canonical edition order across every route,
   keeping each story's ink consistent while enforcing the homepage's
   previous-three exclusion. */

const PALETTE = ['cyan', 'magenta', 'mustard', 'yellow', 'brick', 'cobalt', 'coral', 'mint', 'lime', 'peach', 'lavender', 'deepgreen'];
function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function editionOrder(xs) {
  const stories = xs.filter(isPublished).slice().sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
  if (!stories.length) return stories;
  const lead = stories[0];
  const briefing = stories.slice(1, 5);
  const used = new Set([lead.id, ...briefing.map(s => s.id)]);
  const rest = stories.filter(s => !used.has(s.id));
  const pick = rest.length ? rest[Math.floor(rest.length / 2)] : null;
  const ordered = [lead, ...briefing];
  if (pick) { ordered.push(pick); used.add(pick.id); }
  for (const sectionId of sectionOrder) {
    const sectionStories = stories.filter(s => s.section_id === sectionId && !used.has(s.id)).slice(0, 4);
    ordered.push(...sectionStories);
    sectionStories.forEach(s => used.add(s.id));
  }
  ordered.push(...stories.filter(s => !used.has(s.id)));
  return ordered;
}
function accents(xs) {
  const map = new Map(), recent = [];
  const ordered = editionOrder(xs);
  for (const s of ordered) {
    let i = hash(s.id || s.slug) % PALETTE.length, c = PALETTE[i], guard = 0;
    while (recent.includes(c) && guard++ < PALETTE.length * 2) { i = (i + 1) % PALETTE.length; c = PALETTE[i]; }
    map.set(s.id, c); recent.push(c); if (recent.length > 3) recent.shift();
  }
  return map;
}

/* Signature 1: the signal index chip. Every published story carries one. */
function numChip(n, cls = '') {
  if (!n) return '';
  return `<span class="num${cls ? ` ${cls}` : ''}">[${String(n).padStart(3, '0')}]</span>`;
}

function signalMark(cls = '') {
  return `<span class="signal-mark${cls ? ` ${cls}` : ''}" aria-hidden="true"><i></i><i></i><i></i></span>`;
}

/* Signature 2: the frame. Real story media when it exists, a type-only
   plate when it doesn't — photography is optional, never invented. The same
   treatment on the cover, the indexes, and the story page. */
function frame(s, n, opts = {}) {
  // The live story and the edition cover must resolve the same editorial hero.
  // presentation.hero carries the selected crop and can exist without the
  // legacy hero_media_id pointer; retain that pointer as a fallback.
  const candidate = s.presentation?.hero || s.hero_media;
  const imageUrl = candidate ? mediaUrl(candidate.public_url || candidate.url || candidate.original_url) : '';
  const media = candidate && imageUrl ? candidate : null;
  const crop = ['auto', 'landscape', 'portrait', 'square'].includes(media?.crop) ? media.crop : 'auto';
  const fit = media?.fit === 'contain' ? 'contain' : 'cover';
  const focalX = Math.min(100, Math.max(0, Number(media?.focalX ?? 50)));
  const focalY = Math.min(100, Math.max(0, Number(media?.focalY ?? 50)));
  const credit = String(media?.credit || '').trim();
  const caption = credit
    ? `<figcaption class="mono"><span>${esc(credit)}</span></figcaption>`
    : '';
  const content = media
    ? `<img src="${esc(imageUrl)}" alt="${esc(media.alt_text || '')}" loading="${opts.eager ? 'eager' : 'lazy'}" decoding="async" style="object-position:${focalX}% ${focalY}%">`
    : `<div class="frame-type" aria-hidden="true">
        <span class="frame-glyph">${esc((s.title || 'A').trim().charAt(0).toUpperCase())}</span>
        <span class="frame-num">${n ? String(n).padStart(3, '0') : 'ANY'}</span>
      </div>`;
  return `<figure class="frame${media ? ' has-media' : ' is-type'} crop-${crop} fit-${fit}${opts.className ? ` ${opts.className}` : ''}">
    <div class="frame-cut">${content}</div>
    ${caption}
  </figure>`;
}

/* Signature 3: the sticker. One recognizable editorial interruption, reused
   across the cover, index pages, and search. */
function sticker(s, n, opts = {}) {
  const label = esc(opts.label || 'The detour');
  const text = esc(opts.text || s.summary || s.dek || '');
  if (!text && !opts.href) return '';
  return `<aside class="sticker${opts.className ? ` ${opts.className}` : ''}" data-reveal>
    ${signalMark('signal-mark--sticker')}
    <span class="sticker-label mono">${label}</span>
    <p>${text}</p>
    <div class="sticker-foot">${numChip(n)}${opts.href ? `<a class="sticker-link mono" href="${esc(opts.href)}">${esc(opts.linkTitle || s.title)} →</a>` : ''}</div>
  </aside>`;
}

/* ---------- Data (same records and permissions, with existing media hydrated) ---------- */

async function session() {
  try {
    const { data, error } = await sb.auth.getUser();
    if (!error && data.user) return data.user;
  } catch (error) {
    console.warn('Newsroom session check unavailable', error);
  }
  try {
    const { data } = await sb.auth.getSession();
    return data.session?.user || null;
  } catch (error) {
    console.warn('Newsroom session recovery unavailable', error);
    return null;
  }
}
async function profile() {
  const u = await session();
  if (!u) return null;
  try {
    return await dataOf(sb.from('profiles').select('id,name,slug,role').eq('id', u.id).maybeSingle(), 'profile');
  } catch (error) {
    console.warn('Newsroom profile unavailable', error);
    return null;
  }
}
async function hydrateMedia(stories) {
  const ids = [...new Set(stories.map(s => s.hero_media_id).filter(Boolean))];
  const [data, automatedHeroes] = await Promise.all([
    ids.length
      ? dataOf(sb.from('media').select('id,public_url,alt_text,caption,credit').in('id', ids), 'story media')
      : Promise.resolve([]),
    optionalColumn(sb.from('published_story_media').select('story_id,media_asset_id,cached_url,alt_text,attribution_text,source_page_url,width,height,mime_type,source_name,selection_rationale').in('story_id', stories.map(s => s.id)))
  ]);
  const byId = new Map((data || []).map(m => [m.id, m]));
  const automatedByStory = new Map((automatedHeroes || []).map(media => {
    const url = mediaUrl(media.cached_url);
    return [media.story_id, {
      id: `pipeline:${media.media_asset_id}`,
      public_url: url,
      url,
      original_url: url,
      alt_text: media.alt_text || '',
      caption: media.attribution_text || media.source_name || '',
      credit: media.attribution_text || media.source_name || '',
      source_url: media.source_page_url,
      source_page_url: media.source_page_url,
      width: media.width,
      height: media.height,
      mime_type: media.mime_type,
      selection_rationale: media.selection_rationale,
      rights_status: 'approved'
    }];
  }));
  return stories.map(s => ({
    ...s,
    presentation: resolvePresentationMedia(s.presentation),
    hero_media: byId.get(s.hero_media_id) || automatedByStory.get(s.id) || null
  }));
}

let publishedCatalogPromise;
async function publishedCatalog() {
  if (!publishedCatalogPromise) {
    publishedCatalogPromise = (async () => {
      const data = await dataOf(sb.from('stories')
        .select(publicStorySelect)
        .eq('status', 'published')
        .lte('published_at', new Date().toISOString())
        .order('published_at', { ascending: false }), 'published stories') || [];
      return hydrateMedia(data);
    })();
  }
  return publishedCatalogPromise;
}

async function published(filters = {}) {
  const stories = await publishedCatalog();
  return stories.filter(s => Object.entries(filters).every(([key, value]) => !value || s[key] === value));
}
async function allSections() {
  const data = await dataOf(sb.from('sections').select('id,name,slug,template'), 'sections') || [];
  return data.slice().sort((a, b) => sectionOrder.indexOf(a.id) - sectionOrder.indexOf(b.id));
}

/* ---------- Chrome: the masthead, the ticker, the colophon ---------- */

async function chrome() {
  const dateEl = document.querySelector('#dateline-date'), countEl = document.querySelector('#dateline-count'), yearEl = document.querySelector('#colophon-year');
  if (dateEl) dateEl.textContent = dShort(new Date());
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  try {
    const sections = (await allSections()).filter(section => SECTION_ORDER.includes(section.id));
    const sectionsMenu = document.querySelector('.nav-sections-menu');
    if (sectionsMenu && window.matchMedia('(max-width: 760px)').matches) sectionsMenu.removeAttribute('open');
    const nav = document.querySelector('#nav-sections');
    if (nav && sections.length) {
      const current = location.pathname.startsWith('/sections/') ? location.pathname.split('/')[2] : null;
      const links = sections.map(s => `<a href="/sections/${esc(s.slug)}" ${current === s.slug ? 'aria-current="page"' : ''}>${esc(s.name)}</a>`).join('');
      nav.innerHTML = links;
    }
    const colophonSections = document.querySelector('#colophon-sections');
    if (colophonSections && sections.length) colophonSections.innerHTML = sections.map(s => `<li><a href="/sections/${esc(s.slug)}">${esc(s.name)}</a></li>`).join('');
  } catch { /* navigation degrades to the desk links */ }
  const deskCurrent = location.pathname === '/' ? 'home'
    : location.pathname === '/latest' ? 'latest'
    : location.pathname === '/topics' || location.pathname.startsWith('/topics/') ? 'topics'
    : location.pathname === '/search' ? 'search' : null;
  if (deskCurrent) document.querySelector(`#index-nav [data-current="${deskCurrent}"]`)?.setAttribute('aria-current', 'page');
  try {
    const { count, error } = await sb.from('stories').select('id', { count: 'exact', head: true }).eq('status', 'published').lte('published_at', new Date().toISOString());
    if (error) throw error;
    if (countEl && count != null) countEl.textContent = `${count} stories on file · against the current`;
  } catch { /* keep the footer promise line */ }
  /* The wire ticker rides under the masthead on every public page. */
  if (isPublicRoute) {
    try {
      const fresh = (await published()).slice(0, 8);
      const ticker = document.querySelector('#ticker'), track = document.querySelector('#ticker-track');
      if (ticker && track && fresh.length) {
        track.innerHTML = fresh.map(s => `<a class="ticker-item" href="/stories/${esc(s.slug)}">${esc(s.title)}</a>`).join(signalMark('signal-mark--ticker'));
        ticker.hidden = false;
      }
    } catch { /* the ticker is optional */ }
  }
}

/* ---------- Shared story references: one record, two editorial weights ---------- */

/* The card: title, dek, chips, optional media. Used across the cover. */
function card(s, nums, opts = {}) {
  const n = nums.get(s.id);
  const href = opts.href || `/stories/${esc(s.slug)}`;
  const level = opts.level || 3;
  return `<article class="card${opts.media ? ' card--media' : ''}" data-reveal>
  ${opts.media ? `<a class="card-media" href="${href}" tabindex="-1" aria-hidden="true">${frame(s, n, { className: 'frame--card' })}</a>` : ''}
  <div class="card-body">
    <div class="chiprow">${numChip(n)}<a class="chip" href="/sections/${esc(s.sections?.slug || '')}">${esc(s.sections?.name || '')}</a></div>
    <h${level} class="card-title"><a href="${href}">${esc(s.title)}</a></h${level}>
    <p class="card-dek">${esc(s.dek)}</p>
    <div class="card-meta mono">
      ${s.published_at && isPublished(s) ? `<span>${dShort(s.published_at)}</span>` : ''}
      <span>${s.reading_time_minutes} min</span>
    </div>
  </div>
</article>`;
}

/* The index line: number, title, leader dots, metadata. Built for scanning. */
function indexline(s, nums) {
  const n = nums.get(s.id);
  return `<li class="indexrow" data-reveal><a class="indexrow-hit" href="/stories/${esc(s.slug)}">
    <span class="indexrow-num mono">${n ? String(n).padStart(3, '0') : '···'}</span>
    <span class="indexrow-title">${esc(s.title)}</span>
    <span class="indexrow-dots" aria-hidden="true"></span>
    <span class="indexrow-meta mono">${s.published_at ? `${dShort(s.published_at)} · ` : ''}${s.reading_time_minutes} min</span>
  </a></li>`;
}

const emptyNote = t => `<p class="empty-note">${t}</p>`;
const notFound = () => {
  document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,follow');
  return `<div class="lost">
    ${signalMark('signal-mark--huge')}
    <p class="mono">[ 404 · wiped out ]</p>
    <h1>This page doesn’t exist. Bold move looking for it.</h1>
    <p class="lede">You fell off the map. The front page is still standing.</p>
    <p><a class="more-link mono" href="/">back to the goods →</a></p>
  </div>`;
};
const unavailable = () => {
  document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,nofollow');
  return `<div class="lost" role="alert">
    ${signalMark('signal-mark--huge')}
    <p class="mono">[ interference ]</p>
    <h1>The edition is temporarily unavailable.</h1>
    <p class="lede">Nothing was lost. Check your connection and try the page again.</p>
    <p><button class="retry-button" type="button">Try again</button></p>
  </div>`;
};

function title(t, description = '') {
  document.title = t ? `${t} | Anyways` : 'Anyways';
  if (description) document.querySelector('meta[name="description"]')?.setAttribute('content', description);
}

async function homepageSelection(stories, sections) {
  const fallback = rankHomepageStories(stories);
  const rows = await optionalColumn(sb.rpc('get_homepage_story_ids', { p_now: new Date().toISOString() }));
  const byId = new Map(stories.map(story => [story.id, story]));
  const rankedRows = rows
    .map(row => ({ ...row, story: byId.get(row.story_id) }))
    .filter(row => row.story && isPublished(row.story));
  if (!rankedRows.length) return fallback;
  const lead = rankedRows.find(row => row.placement === 'lead')?.story || fallback.lead;
  const featured = rankedRows.filter(row => row.placement === 'homepage').sort((a, b) => a.position - b.position).map(row => row.story);
  const sectionRows = new Map();
  rankedRows.filter(row => row.placement === 'section').sort((a, b) => a.position - b.position).forEach(row => {
    const list = sectionRows.get(row.story.section_id) || [];
    list.push(row.story);
    sectionRows.set(row.story.section_id, list);
  });
  const sectionsWithStories = new Map(sections.map(section => [section.id, sectionRows.get(section.id) || []]).filter(([, list]) => list.length));
  const premium = new Set([lead?.id, ...featured.map(story => story.id)].filter(Boolean));
  return {
    lead,
    featured,
    latest: stories.filter(isPublished).slice().sort((a, b) => new Date(b.published_at) - new Date(a.published_at)),
    sections: sectionsWithStories,
    placements: new Map(rankedRows.map(row => [row.story.id, row.placement])),
    diagnostics: fallback.diagnostics,
    premium
  };
}

/* ---------- Homepage: a signal board, not a feed ---------- */

async function home() {
  const stories = await published(), nums = numerals(stories), sections = await allSections(), acc = accents(stories);
  const selection = await homepageSelection(stories, sections);
  const lead = selection.lead;
  title();
  if (!lead) {
    app.innerHTML = sticker({ title: 'The first edition', dek: 'The desk is setting its first edition.' }, null, { label: 'Soon / Anyways' });
    return;
  }
  const fallbackFeatured = selection.featured.filter(story => story.id !== lead.id).slice(0, 4);
  const latest = selection.latest.filter(story => story.id !== lead.id && !fallbackFeatured.some(item => item.id === story.id)).slice(0, 8);
  // Section modules are the archive-facing view: include every published
  // story, even if it was also promoted as the lead or a Featured story.
  // Chronology determines the section card, not the homepage rank.
  const sectionGroups = homepageSectionGroups(stories, sections);
  const marquee = 'follow the signal ✺ ignore the noise ✺ on-chain and in the world ✺ sourced to the teeth ✺ ';
  app.innerHTML = `
    <section class="hero">
      <div class="hero-aurora" data-drift="0.05" aria-hidden="true"></div>
      <p class="hero-eyebrow mono" data-reveal>[ fresh off the desk · ${dLong(new Date())} ]</p>
      <h1 class="hero-word" data-scramble="900">ANYWAYS</h1>
      <p class="hero-promise" data-reveal>We cover the stories the timeline will talk about tomorrow.</p>
      <div class="hero-facts mono" data-reveal>
        <span>${stories.length} ${stories.length === 1 ? 'story' : 'stories'} on file</span>
        ${signalMark('signal-mark--hero')}
        <span>Follow the signal. Ignore the noise.</span>
      </div>
    </section>
    <section class="billboard a-${acc.get(lead.id)}" aria-label="Top story">
      <a class="billboard-media" href="/stories/${esc(lead.slug)}" tabindex="-1" aria-hidden="true">${frame(lead, nums.get(lead.id), { className: 'frame--billboard', eager: true })}</a>
      <div class="billboard-copy">
        <div class="chiprow" data-reveal><span class="chip chip--hot">Lead story</span><a class="chip" href="/sections/${esc(lead.sections?.slug || '')}">${esc(lead.sections?.name || '')}</a>${numChip(nums.get(lead.id))}</div>
        <h2 class="billboard-title"><a href="/stories/${esc(lead.slug)}">${esc(lead.title)}</a></h2>
        <p class="lede" data-reveal>${esc(lead.dek)}</p>
        <div class="byline mono" data-reveal><span>${dLong(lead.published_at)}</span><span>${lead.reading_time_minutes} min read</span></div>
      </div>
    </section>
    ${fallbackFeatured.length ? `<section class="wire" aria-label="Featured stories">
      <header class="sec-head" data-reveal>
        <h2>Featured stories</h2>
        <p class="sec-sub mono">the stories with somewhere to go</p>
      </header>
      <div class="wire-row">${fallbackFeatured.map(s => card(s, nums, { media: true })).join('')}</div>
    </section>` : ''}
    <div class="marquee" aria-hidden="true"><div class="marquee-track">${marquee}${marquee}</div></div>
    ${latest.length ? `<section class="allindex">
      <header class="sec-head" data-reveal>
        <h2>Latest</h2>
        <p class="sec-sub mono">reverse chronological · lower-prominence stories included</p>
      </header>
      <ul class="indexlist indexlist--full">${latest.map(s => indexline(s, nums)).join('')}</ul>
      <p class="zonetail mono"><a href="/latest">see every recent story →</a></p>
    </section>` : ''}
    ${sectionGroups.map(({ sec, xs }, i) => `<section class="beatmod a-${acc.get(xs[0].id)}">
      <header class="beatmod-head" data-reveal>
        <span class="beatmod-count mono">${String(i + 1).padStart(2, '0')} / ${String(sectionGroups.length).padStart(2, '0')}</span>
        <h2 class="beatmod-name"><a href="/sections/${esc(sec.slug)}">${esc(sec.name)}</a></h2>
        <p class="beatmod-promise">${esc(promises[sec.id] || '')}</p>
        <a class="more-link mono" href="/sections/${esc(sec.slug)}">all ${esc(sec.name)} →</a>
      </header>
      <div class="beatmod-grid">
        ${card(xs[0], nums, { media: true })}
        <ul class="indexlist">${xs.slice(1).map(s => indexline(s, nums)).join('')}</ul>
      </div>
    </section>`).join('')}
    <section class="outro" data-reveal>
      ${signalMark('signal-mark--huge')}
      <p class="outro-line">That’s all.<br>Go touch grass.</p>
      <div class="outro-links"><a class="more-link mono" href="/latest">read the latest</a><a class="more-link mono" href="/search">search the archive</a></div>
    </section>`;
}

async function latest() {
  const catalog = await published();
  const nums = numerals(catalog);
  title('Latest', 'The latest stories from Anyways.');
  app.innerHTML = `<div class="zonepage">
    <header class="zone-head"><p class="zone-kicker mono" data-reveal>[ the live file · ${catalog.length} stories ]</p><h1 class="zone-name">Latest</h1><p class="zone-promise" data-reveal>Follow the signal. Ignore the noise.</p></header>
    <div class="zone-lead">${catalog.length ? `${card(catalog[0], nums, { media: true, level: 2 })}<ul class="indexlist indexlist--zone">${catalog.slice(1).map(story => indexline(story, nums)).join('')}</ul>` : emptyNote('No stories are published yet.')}</div>
  </div>`;
}

/* ---------- Story: the live transmission ---------- */

async function showStory(slug) {
  let story = await dataOf(
    sb.from('stories').select(publicStorySelect).eq('slug', slug).eq('status', 'published').lte('published_at', new Date().toISOString()).maybeSingle(),
    'story'
  );
  if (!story) {
    const redirect = await optionalData(sb.from('story_slug_redirects').select('story_id').eq('from_slug', slug).maybeSingle(), 'story redirect');
    if (redirect?.story_id) {
      const target = await dataOf(sb.from('stories').select('slug').eq('id', redirect.story_id).eq('status', 'published').lte('published_at', new Date().toISOString()).maybeSingle(), 'redirect target');
      if (target?.slug) { history.replaceState(null, '', `/stories/${encodeURIComponent(target.slug)}`); return showStory(target.slug); }
    }
    title('Not found'); return app.innerHTML = notFound();
  }
  const [s] = await hydrateMedia([story]);
  const presentationRows = await optionalColumn(sb.from('stories').select('presentation').eq('id', s.id).limit(1));
  s.presentation = resolvePresentationMedia(presentationRows[0]?.presentation || s.presentation);
  const sourceRows = await dataOf(
    sb.from('sources').select('id,title,publisher,url,source_type,published_at,sort_order').eq('story_id', s.id).order('sort_order'),
    'story sources'
  ) || [];
  const sources = sourceRows.map(source => ({ ...source, safe_url: externalUrl(source.url) })).filter(source => source.safe_url);
  const corrections = await optionalData(
    sb.from('story_corrections').select('id,corrected_at,note').eq('story_id', s.id).order('corrected_at', { ascending: false }),
    'story corrections'
  ) || [];
  const all = await published();
  const nums = numerals(all), acc = accents(all);
  let related = [];
  try {
    const links = await dataOf(sb.from('story_related').select('related_story_id').eq('story_id', s.id), 'related stories') || [];
    const ids = links.map(x => x.related_story_id);
    if (ids.length) {
      const data = await dataOf(
        sb.from('stories').select(publicStorySelect).in('id', ids).eq('status', 'published').lte('published_at', new Date().toISOString()).order('published_at', { ascending: false }),
        'related story records'
      ) || [];
      related = await hydrateMedia(data);
    }
  } catch { /* next reads are optional */ }
  title(s.seo_title || s.title, s.seo_description || s.dek);
  app.innerHTML = renderArticle({
    story: s,
    sources,
    corrections,
    related,
    catalog: all,
    numbers: nums,
    accent: acc.get(s.id) || 'brick',
    shareHref: location.href,
    relatedHtml: related.length
      ? `<div class="upnext-grid">${related.map((x, i) => card(x, nums, { media: i === 0 })).join('')}</div>`
      : ''
  });
}

/* ---------- Sections: the promise ---------- */

async function section(slug) {
  const sec = await dataOf(sb.from('sections').select('id,name,slug').eq('slug', slug).maybeSingle(), 'section');
  if (!sec) { title('Not found'); return app.innerHTML = notFound(); }
  const beatFilter = new URLSearchParams(location.search).get('topic') || new URLSearchParams(location.search).get('beat') || '';
  const catalog = await published(), xs = catalog.filter(s => storyBelongsToSection(s, sec.id));
  const nums = numerals(catalog), acc = accents(catalog);
  const filtered = beatFilter ? xs.filter(s => (s.story_beats || []).some(x => x.beats?.slug === beatFilter)) : xs;
  /* Pills list only the topics this section actually files under. */
  const beatMap = new Map();
  for (const s of xs) for (const x of s.story_beats || []) if (x.beats?.slug) beatMap.set(x.beats.slug, x.beats.name);
  const sectionBeats = [...beatMap.entries()].map(([beatSlug, name]) => ({ slug: beatSlug, name })).sort((a, b) => a.name.localeCompare(b.name));
  const lead = filtered[0], remaining = filtered.slice(1);
  title(sec.name);
  app.innerHTML = `<div class="zonepage${lead ? ` a-${acc.get(lead.id)}` : ''}">
    <header class="zone-head">
      <p class="zone-kicker mono" data-reveal>[ section · ${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'} ]</p>
      <h1 class="zone-name">${esc(sec.name)}</h1>
      <p class="zone-promise" data-reveal>${esc(promises[sec.id] || '')}</p>
      ${sectionBeats.length ? `<nav class="pillrow" data-reveal aria-label="Filter by topic">
        <a class="pill${!beatFilter ? ' is-on' : ''}" href="/sections/${esc(sec.slug)}">all</a>
        ${sectionBeats.map(b => `<a class="pill${beatFilter === b.slug ? ' is-on' : ''}" href="/sections/${esc(sec.slug)}?topic=${esc(b.slug)}">${esc(b.name)}</a>`).join('')}
      </nav>` : ''}
    </header>
    ${lead ? `<div class="zone-lead">
      ${card(lead, nums, { media: true, level: 2 })}
      ${remaining.length ? `<ul class="indexlist indexlist--zone">${remaining.map(s => indexline(s, nums)).join('')}</ul>` : ''}
    </div>` : sticker({ title: sec.name, dek: 'Nothing filed here yet.' }, null, {
      className: 'sticker--empty a-cobalt',
      label: 'The open slot',
      text: 'Nothing filed here yet. The archive is always open.'
    })}
  </div>`;
}

/* ---------- Topics ---------- */

async function topics() {
  const ts = await dataOf(sb.from('beats').select('id,name,slug').order('name'), 'beats') || [];
  const stories = await published();
  const rows = ts.map(t => ({
    beat: t,
    count: stories.filter(s => (s.story_beats || []).some(x => x.beats?.slug === t.slug)).length
  })).filter(row => row.count);
  title('Topics');
  app.innerHTML = `<div class="zonepage">
    <header class="zone-head">
      <p class="zone-kicker mono" data-reveal>[ the archive, by recurring subject ]</p>
      <h1 class="zone-name">Topics</h1>
      <p class="zone-promise" data-reveal>Subjects that keep coming back. Pick one and fall in.</p>
    </header>
    <ul class="beatmenu">${rows.map((row, i) => `<li class="beatmenu-row a-${PALETTE[hash(row.beat.slug) % PALETTE.length]}" data-reveal>
      <a class="beatmenu-hit" href="/topics/${esc(row.beat.slug)}">
        <span class="beatmenu-num mono">${String(i + 1).padStart(2, '0')}</span>
        <span class="beatmenu-name">${esc(row.beat.name)}</span>
        <span class="beatmenu-count mono">${row.count} ${row.count === 1 ? 'story' : 'stories'}</span>
      </a>
    </li>`).join('')}</ul>
    <p class="zonetail mono" data-reveal>${signalMark('signal-mark--inline')} that’s every topic on file · <a href="/search">search the whole archive →</a></p>
  </div>`;
}

async function topic(slug) {
  const t = await dataOf(sb.from('beats').select('id,name,slug').eq('slug', slug).maybeSingle(), 'beat');
  if (!t) { title('Not found'); return app.innerHTML = notFound(); }
  const catalog = await published();
  const ss = catalog.filter(s => (s.story_beats || []).some(x => x.beats?.slug === t.slug));
  const nums = numerals(catalog), acc = accents(catalog);
  const sectionFilter = new URLSearchParams(location.search).get('section') || '';
  const filtered = sectionFilter ? ss.filter(s => storyBelongsToSection(s, sectionFilter)) : ss;
  const sections = await allSections();
  const present = new Set(ss.flatMap(s => [s.section_id, ...(s.story_sections || []).map(item => item.section_id || item.sections?.slug)].filter(Boolean)));
  const filterSections = sections.filter(s => present.has(s.id));
  title(t.name);
  app.innerHTML = `<div class="zonepage${filtered.length ? ` a-${acc.get(filtered[0].id)}` : ''}">
    <header class="zone-head">
      <p class="zone-kicker mono" data-reveal>[ topic · ${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'} ]</p>
      <h1 class="zone-name">${esc(t.name)}</h1>
      ${filterSections.length > 1 ? `<nav class="pillrow" data-reveal aria-label="Filter by section">
        <a class="pill${!sectionFilter ? ' is-on' : ''}" href="/topics/${esc(t.slug)}">all</a>
        ${filterSections.map(s => `<a class="pill${sectionFilter === s.id ? ' is-on' : ''}" href="/topics/${esc(t.slug)}?section=${esc(s.id)}">${esc(s.name)}</a>`).join('')}
      </nav>` : ''}
    </header>
    ${filtered.length ? `<div class="zone-lead">
      ${card(filtered[0], nums, { media: true, level: 2 })}
      ${filtered.length > 1 ? `<ul class="indexlist indexlist--zone">${filtered.slice(1).map(s => indexline(s, nums)).join('')}</ul>` : ''}
    </div>` : emptyNote('No published stories match this filter.')}
  </div>`;
}

/* ---------- Search: ask the desk ---------- */

async function search() {
  const q = (new URLSearchParams(location.search).get('q') || '').trim().slice(0, 120);
  const sectionFilter = new URLSearchParams(location.search).get('section') || '';
  const catalog = await published();
  let ss = [];
  if (q) {
    const needle = q.toLocaleLowerCase('en-US');
    ss = catalog.filter(story => {
      if (sectionFilter && !storyBelongsToSection(story, sectionFilter)) return false;
      const haystack = [
        story.title, story.dek, story.summary, story.body,
        story.sections?.name, ...(story.story_sections || []).map(item => item.sections?.name),
        ...(story.story_beats || []).map(item => item.beats?.name), ...(story.story_tags || []).map(item => item.tags?.name)
      ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
      return haystack.includes(needle);
    });
  }
  const nums = numerals(catalog), acc = accents(catalog), sections = await allSections();
  title('Search');
  const results = q ? (ss.length
    ? `<p class="ask-results mono" data-reveal>[ ${ss.length} result${ss.length === 1 ? '' : 's'} · “${esc(q)}” ]</p>
      <div class="zone-lead">
        ${card(ss[0], nums, { media: true, level: 2 })}
        ${ss.length > 1 ? `<ul class="indexlist indexlist--zone">${ss.slice(1).map(s => indexline(s, nums)).join('')}</ul>` : ''}
      </div>`
    : sticker({ title: 'No result', dek: `Nothing filed under “${q}” yet.` }, null, {
      className: 'sticker--empty a-magenta',
      label: 'No match / Keep looking',
      text: `Nothing filed under “${q}” yet.`
    }) ) : sticker({ title: 'The archive', dek: 'Every story is numbered, sourced, and still on file.' }, null, {
      className: 'sticker--empty a-yellow',
      label: 'Search note / The whole archive',
      text: 'Try a person, a protocol, a company, a feeling, or the thing everyone keeps talking around.'
    });
  app.innerHTML = `<div class="askpage">
    <header class="zone-head">
      <p class="zone-kicker mono" data-reveal>[ the archive · ${catalog.length} ${catalog.length === 1 ? 'story' : 'stories'} ]</p>
      <h1 class="zone-name">Ask the desk</h1>
      <p class="zone-promise" data-reveal>Every story is numbered, sourced, and still on file.</p>
    </header>
    <form id="search" method="get" class="askbox" data-reveal>
      <div class="ask-line">
        <label class="sr-only" for="archive-query">Search the archive</label>
        <input id="archive-query" name="q" type="search" maxlength="120" value="${esc(q)}" placeholder="people, protocols, drama…">
        <button type="submit">search →</button>
      </div>
      <div class="ask-filter">
        <label class="mono" for="archive-section">in</label>
        <select id="archive-section" name="section"><option value="">All sections</option>${sections.map(s => `<option value="${esc(s.id)}" ${sectionFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </div>
    </form>
    ${results}
  </div>`;
  document.querySelector('#search').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target), params = new URLSearchParams();
    if (f.get('q')) params.set('q', f.get('q'));
    if (f.get('section')) params.set('section', f.get('section'));
    location.href = '/search' + (params.toString() ? '?' + params.toString() : '');
  };
}

/* ---------- Newsroom: the desk at night ---------- */

function deskNav(p, current = '') {
  const navLink = item => '<a href="' + item.href + '" ' + (current === item.current ? 'aria-current="page"' : '') + '>' + item.label + '</a>';
  const work = [
    { href: '/newsroom/on-deck', label: 'On Deck', current: 'on-deck' },
    { href: '/newsroom/pitches', label: 'Pitches', current: 'pitches' },
    { href: '/newsroom/stories', label: 'Stories', current: 'stories' },
    { href: '/newsroom/review', label: 'Review packages', current: 'review' },
    { href: '/newsroom/published', label: 'Published', current: 'published' },
    { href: '/newsroom/homepage', label: 'Homepage', current: 'homepage' }
  ];
  const planning = [
    { href: '/newsroom/ideas', label: 'Ideas', current: 'ideas' },
    { href: '/newsroom/editorial-candidates', label: 'Candidates', current: 'editorial-candidates' },
    { href: '/newsroom/analytics', label: 'Analytics', current: 'analytics' }
  ];
  const create = [
    { href: '/newsroom/new', label: 'New Story', current: 'new' },
    { href: '/newsroom/assignment', label: 'Assignment', current: 'assignment' }
  ];
  const operations = [
    { href: '/newsroom/pipeline', label: 'Pipeline', current: 'pipeline' },
    { href: '/newsroom/settings', label: 'Settings', current: 'settings' }
  ];
  return '<nav class="desk-nav" aria-label="Newsroom">'
    + '<details class="desk-nav-work" open><summary>Work</summary><div class="desk-nav-links">' + work.map(navLink).join('') + '</div></details>'
    + '<details class="desk-nav-group"><summary>Planning</summary><div class="desk-nav-menu">' + planning.map(navLink).join('') + '</div></details>'
    + '<details class="desk-nav-group"><summary>Create</summary><div class="desk-nav-menu">' + create.map(navLink).join('') + '</div></details>'
    + '<details class="desk-nav-group"><summary>Operations</summary><div class="desk-nav-menu">' + operations.map(navLink).join('') + '</div></details>'
    + '<span class="desk-nav-utility"><a href="/">View Site</a><span class="who">' + esc(p?.name || '') + ' · ' + esc(humanize(p?.role || '')) + ' · <button class="quiet compact-button" id="signout" type="button">Sign out</button></span></span>'
    + '</nav>';
}

const NEWSROOM_PAGE_SIZE = 25;

function pagingControls(id, shown, total) {
  if (!total) return '';
  return '<span class="meta-line" role="status" aria-live="polite">Showing ' + shown + ' of ' + total + '</span>'
    + (shown < total ? '<button class="quiet compact-button" id="' + id + '" type="button">Show 25 more</button>' : '');
}

function prepareResponsiveTable(table) {
  if (!table) return;
  const headings = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
  table.querySelectorAll('tbody tr').forEach(row => {
    if (row.querySelector('[colspan]')) return;
    [...row.children].forEach((cell, index) => {
      if (!cell.dataset.label && headings[index]) cell.dataset.label = headings[index];
    });
  });
}

function bindTablePaging(table, id, pageSize = NEWSROOM_PAGE_SIZE) {
  if (!table) return;
  prepareResponsiveTable(table);
  const rows = [...table.querySelectorAll('tbody tr')].filter(row => !row.querySelector('[colspan]'));
  if (!rows.length) return;
  let visibleCount = pageSize;
  const controls = document.createElement('div');
  controls.className = 'newsroom-paging';
  table.closest('.table-scroll')?.insertAdjacentElement('afterend', controls);
  const render = () => {
    rows.forEach((row, index) => { row.hidden = index >= visibleCount; });
    const shown = Math.min(visibleCount, rows.length);
    controls.innerHTML = pagingControls(id, shown, rows.length);
    controls.querySelector('#' + id)?.addEventListener('click', () => {
      visibleCount += pageSize;
      render();
    });
  };
  render();
}

function bindCollectionPaging(container, selector, id, pageSize = NEWSROOM_PAGE_SIZE) {
  if (!container) return;
  const items = [...container.querySelectorAll(selector)];
  if (!items.length) return;
  let visibleCount = pageSize;
  const controls = document.createElement('div');
  controls.className = 'newsroom-paging';
  container.insertAdjacentElement('afterend', controls);
  const render = () => {
    items.forEach((item, index) => { item.hidden = index >= visibleCount; });
    const shown = Math.min(visibleCount, items.length);
    controls.innerHTML = pagingControls(id, shown, items.length);
    controls.querySelector('#' + id)?.addEventListener('click', () => {
      visibleCount += pageSize;
      render();
    });
    container.dispatchEvent(new CustomEvent('newsroom:page'));
  };
  render();
}

function settingsPanel(element, { id, title: panelTitle, status = '', open = false }) {
  if (!element) return null;
  const panel = document.createElement('details');
  panel.className = 'settings-panel';
  panel.id = id;
  panel.open = open;
  const summary = document.createElement('summary');
  summary.innerHTML = '<span>' + esc(panelTitle) + '</span>' + (status ? '<small>' + esc(status) + '</small>' : '');
  element.removeAttribute('id');
  element.classList.add('settings-panel-body');
  element.before(panel);
  panel.append(summary, element);
  return panel;
}

function analyticsNumber(value) { return new Intl.NumberFormat('en-US').format(Number(value) || 0); }
function analyticsDuration(value) {
  const seconds = Math.max(0, Number(value) || 0);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function analyticsChart(rows) {
  const values = rows.map(row => Number(row.pageviews) || 0);
  const max = Math.max(1, ...values);
  const points = values.map((value, index) => `${values.length === 1 ? 50 : (index / (values.length - 1)) * 100},${92 - ((value / max) * 76)}`).join(' ');
  const area = values.length ? `0,100 ${points} 100,100` : '';
  const labels = rows.length ? `${rows[0].day} to ${rows.at(-1).day}` : 'No data yet';
  return `<div class="analytics-chart" role="img" aria-label="Daily page views, ${esc(labels)}"><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><polygon points="${area}"/><polyline points="${points}"/></svg><div class="analytics-chart-labels"><span>${esc(rows[0]?.day || '')}</span><span>${esc(rows.at(-1)?.day || '')}</span></div></div>`;
}
function analyticsBars(rows, empty = 'No data yet.') {
  const maximum = Math.max(1, ...rows.map(row => Number(row.value) || 0));
  return rows.length ? `<div class="analytics-bars">${rows.map(row => `<div class="analytics-bar"><span title="${esc(row.name)}">${esc(row.name)}</span><div><i style="width:${Math.max(3, ((Number(row.value) || 0) / maximum) * 100)}%"></i></div><strong>${analyticsNumber(row.value)}</strong></div>`).join('')}</div>` : `<p class="field-note">${empty}</p>`;
}

async function analyticsDashboard() {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  if (!['admin', 'editor'].includes(p.role)) {
    title('Analytics');
    app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Analytics</span></div><h1>Analytics are for editors.</h1><p class="standfirst">Ask an editor for a reporting view.</p></div>${deskNav(p, 'analytics')}</div>`;
    bindSignOut();
    return;
  }
  const allowed = [1, 7, 30, 90, 365];
  const requested = Number(new URLSearchParams(location.search).get('range'));
  const days = allowed.includes(requested) ? requested : 7;
  const report = await dataOf(sb.rpc('newsroom_analytics_report', { p_days: days }), 'analytics report') || {};
  const daily = Array.isArray(report.daily) ? report.daily : [];
  const ranges = [['1d', 1], ['7d', 7], ['30d', 30], ['90d', 90], ['1yr', 365]];
  title('Analytics');
  app.innerHTML = `<div class="desk analytics-desk">
    <div class="page-head">
      <div class="kicker"><span>The desk</span><span class="sep">·</span><span>Reader signals</span></div>
      <h1>What readers are doing.</h1>
      <p class="standfirst">First-party, privacy-conscious signals from the public site. Newsroom activity is excluded.</p>
    </div>
    ${deskNav(p, 'analytics')}
    <nav class="analytics-ranges" aria-label="Analytics date range">${ranges.map(([label, value]) => `<a href="/newsroom/analytics?range=${value}" ${days === value ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <section class="analytics-kpis" aria-label="Analytics overview">
      <article><span class="label">Visitors</span><strong>${analyticsNumber(report.visitors)}</strong><small>unique sessions</small></article>
      <article><span class="label">Page views</span><strong>${analyticsNumber(report.pageviews)}</strong><small>public pages opened</small></article>
      <article><span class="label">Avg. engaged</span><strong>${analyticsDuration(report.avg_engaged_seconds)}</strong><small>active reading time</small></article>
      <article><span class="label">Avg. scroll</span><strong>${analyticsNumber(report.avg_scroll_depth)}%</strong><small>deepest reader progress</small></article>
    </section>
    <section class="desk-section analytics-feature"><div class="section-head"><div><span class="label">Traffic</span><h2>Daily page views</h2></div><p class="field-note">${esc(String(report.from || ''))} to ${esc(String(report.to || ''))}</p></div>${analyticsChart(daily)}</section>
    <div class="analytics-grid">
      <section class="desk-section"><span class="label">Acquisition</span><h2>Where readers came from</h2>${analyticsBars(Array.isArray(report.sources) ? report.sources : [])}</section>
      <section class="desk-section"><span class="label">Attention</span><h2>What they opened</h2>${analyticsBars(Array.isArray(report.pages) ? report.pages : [])}</section>
      <section class="desk-section"><span class="label">Behavior</span><h2>What they did</h2>${analyticsBars(Array.isArray(report.actions) ? report.actions : [])}</section>
    </div>
  </div>`;
  bindSignOut();
}

function bindSignOut() {
  const button = document.querySelector('#signout');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Signing out…';
    await sb.auth.signOut();
    location.href = '/newsroom';
  });
}

async function newsroom() {
  const u = await session();
  if (!u) {
    title('Sign in');
    app.innerHTML = `<div class="signin desk">
      <div class="kicker"><span>The desk</span></div>
      <h1>Newsroom sign in</h1>
      <p class="hint">The desk is for editors and contributors. Sign in with your newsroom account.</p>
      <form id="login">
        <label for="login-email">Email</label>
        <input id="login-email" name="email" type="email" inputmode="email" autocomplete="username" placeholder="you@example.com" required>
        <label for="login-password">Password</label>
        <input id="login-password" name="password" type="password" autocomplete="current-password" placeholder="Password" required>
        <p class="notice form-message" data-form-message role="alert" hidden></p>
        <div class="form-actions"><button type="submit">Sign in</button></div>
      </form>
    </div>`;
    const loginForm = document.querySelector('#login');
    if (!loginForm) return;
    loginForm.onsubmit = async e => {
      e.preventDefault();
      const form = e.currentTarget;
      showFormMessage(form, '');
      setBusy(form, true, 'Signing in…');
      const f = new FormData(form);
      const { error } = await sb.auth.signInWithPassword({
        email: String(f.get('email') || '').trim(),
        password: String(f.get('password') || '')
      });
      if (error) {
        setBusy(form, false);
        showFormMessage(form, 'We could not sign you in. Check your email and password, then try again.');
        return;
      }
      location.href = '/newsroom';
    };
    return;
  }
  const p = await profile();
  if (!p) {
    title('Account unavailable');
    app.innerHTML = `<div class="signin desk"><div class="kicker"><span>The desk</span></div><h1>This account is not on the desk.</h1><p class="hint">Ask an administrator to provision your newsroom profile.</p><button class="quiet" id="signout" type="button">Sign out</button></div>`;
    bindSignOut();
    return;
  }
  return onDeck(p);
}

function ideaStatusLabel(status) { return ({ processing: 'Processing', ready: 'Ready', failed: 'Needs attention', archived: 'Archived' })[status] || humanize(status || 'idea'); }
const ideaPitchKey = pitch => pitch.id || `local-${pitch.position || 'pitch'}`;
function ideaPitchRowMarkup(pitch) {
  const key = ideaPitchKey(pitch);
  const status = pitch.status || 'generated';
  const section = sectionLabel(pitch.primary_section) || pitch.primary_section || 'Not assigned';
  const score = pitch.editorial_score === null || pitch.editorial_score === undefined ? 'Not scored' : `${pitch.editorial_score}/10`;
  const summary = [section, `Score ${score}`, pitch.ready_now ? 'Ready now' : 'Needs reporting'].join(' · ');
  return `<article class="pitch-row idea-pitch-row" data-idea-pitch-row="${esc(key)}" tabindex="0">
    <div class="pitch-row-main"><span class="stamp st-${esc(status)}">${esc(humanize(status))}</span><button type="button" class="pitch-row-title" data-open-idea-pitch="${esc(key)}">${esc(pitch.headline)}</button><p class="pitch-row-meta">${esc(pitch.angle)} · ${esc(summary)}</p></div>
    <div class="pitch-row-actions"><button type="button" class="quiet compact-button" data-open-idea-pitch="${esc(key)}">Open</button></div>
  </article>`;
}
function ideaPitchDetailMarkup(pitch, { local = false } = {}) {
  const source = [...(Array.isArray(pitch.source_urls) ? pitch.source_urls : []), pitch.primary_source]
    .map(value => String(value || '').trim())
    .find(value => /^https?:\/\/[^\s]+$/i.test(value)) || '';
  const topics = Array.isArray(pitch.topics) ? pitch.topics : [];
  const tests = Array.isArray(pitch.significance_tests) ? pitch.significance_tests : [];
  const score = pitch.editorial_score === null || pitch.editorial_score === undefined ? 'Not scored' : `${pitch.editorial_score}/10`;
  return `<div class="pitch-detail idea-pitch-detail"><div class="section-head"><div><span class="label">Pitch ${esc(String(pitch.position || ''))} · ${esc(humanize(pitch.status || 'generated'))}</span><h2>${esc(pitch.headline)}</h2></div><button type="button" class="quiet compact-button" data-close-idea-pitch>Close</button></div>
    <p class="pitch-summary">${esc(pitch.angle)}</p>
    <dl class="pitch-facts"><div><dt>Why now</dt><dd>${esc(pitch.why_now)}</dd></div><div><dt>Audience</dt><dd>${esc(pitch.audience)}</dd></div><div><dt>Primary section</dt><dd>${esc(sectionLabel(pitch.primary_section) || pitch.primary_section || 'Not assigned')}</dd></div><div><dt>Topics</dt><dd>${esc(topics.join(', ') || 'None suggested')}</dd></div><div><dt>Internal length</dt><dd>${esc(pitch.recommended_length || 'standard')}</dd></div><div><dt>Editorial score</dt><dd>${esc(score)}</dd></div><div><dt>Confidence / newness</dt><dd>${esc(`${pitch.confidence ?? '—'} / ${pitch.newness ?? '—'}`)}</dd></div><div><dt>Ready now</dt><dd>${pitch.ready_now ? 'Yes' : 'Not yet'}</dd></div></dl>
    <p class="field-note"><strong>Research limitation:</strong> ${esc(pitch.research_limitation || 'None recorded.')}</p>${tests.length ? `<p class="field-note"><strong>Editorial tests:</strong> ${esc(tests.join(' · '))}</p>` : ''}${pitch.reasoning_summary ? `<p class="field-note"><strong>Rationale:</strong> ${esc(pitch.reasoning_summary)}</p>` : ''}
    ${local ? '<p class="field-note">Local preview only. Nothing is written to Supabase.</p>' : `<form class="idea-commission-form" data-idea-commission-form><div class="section-head"><div><span class="label">Assignment</span><h3>Commission reporting</h3></div><p class="field-note">Add or confirm one verified primary source before sending this pitch to the research queue.</p></div><label>Primary source URL<input type="url" data-idea-source value="${esc(source)}" placeholder="https://…" required></label><label>Length<select data-idea-length><option value="brief" ${pitch.recommended_length === 'brief' ? 'selected' : ''}>Brief</option><option value="standard" ${pitch.recommended_length === 'standard' ? 'selected' : ''}>Standard</option><option value="feature" ${pitch.recommended_length === 'feature' ? 'selected' : ''}>Feature</select></label><button type="submit" data-commission-idea-pitch="${esc(pitch.id || '')}" ${pitch.status === 'commissioned' ? 'disabled' : ''}>${pitch.status === 'commissioned' ? 'Commissioned' : 'Commission'}</button><p class="notice form-message" data-idea-message hidden></p></form>`}
  </div>`;
}

async function ideas(p = null) {
  const profileRecord = p || await profile();
  if (!profileRecord) return location.href = '/newsroom';
  const params = new URLSearchParams(location.search);
  const local = params.get('mock') === '1';
  const selectedId = params.get('idea');
  const [ideaRows, pitchRows] = local ? [[], []] : await Promise.all([
    optionalData(sb.from('editorial_ideas').select('id,prompt,status,generation_job_id,error,created_at,updated_at,archived_at').order('updated_at', { ascending: false }).limit(50), 'editorial ideas'),
    optionalData(sb.from('editorial_idea_pitches').select('id,idea_id,position,headline,angle,why_now,audience,primary_section,topics,recommended_length,research_limitation,primary_source,source_urls,confidence,newness,editorial_score,ready_now,reasoning_summary,significance_tests,status,candidate_id,commission_job_id,commissioned_at,created_at,updated_at').order('position'), 'idea pitches')
  ]);
  const idea = local ? { id: 'local-preview', prompt: params.get('prompt') || 'Something interesting about RWAs.', status: 'ready', local: true } : ideaRows.find(row => row.id === selectedId) || ideaRows[0] || null;
  const pitches = local ? mockIdeaPitches(idea.prompt) : pitchRows.filter(row => row.idea_id === idea?.id);
  const history = local ? [] : ideaRows;
  title('Ideas');
  app.innerHTML = `<div class="desk newsroom-home"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div><h1>Ideas</h1><p class="standfirst">Start with a loose editorial request. Luna returns distinct angles for the desk to choose from.</p></div>${deskNav(profileRecord, 'ideas')}
    <section class="desk-section"><div class="section-head"><div><span class="label">New idea</span><h2>What should we look into?</h2></div><p class="field-note">The request can be informal. Pitches stay attached to the original idea for auditability.</p></div><form id="idea-form" class="desk-form" novalidate><label for="idea-prompt">Editorial request</label><textarea id="idea-prompt" name="prompt" rows="4" minlength="12" maxlength="2000" required placeholder="Something interesting about RWAs.">${esc(idea?.prompt || '')}</textarea><p class="notice form-message" data-form-message hidden></p><div class="form-actions"><button type="submit">Generate Pitches</button>${idea ? `<button type="button" class="quiet" data-regenerate-idea>Regenerate pitches</button>` : ''}</div></form></section>
    ${idea ? `<section class="desk-section" id="idea-${esc(idea.id)}"><div class="section-head"><div><span class="label">${esc(ideaStatusLabel(idea.status))}</span><h2>Angles for this idea</h2></div><p class="field-note">${idea.local ? 'Local provider preview. No fictional stories or production records are created.' : `${pitches.length} pitch${pitches.length === 1 ? '' : 'es'} · Updated ${esc(dShort(idea.updated_at))}`}</p></div><div class="pitch-list idea-pitch-list">${pitches.map(ideaPitchRowMarkup).join('') || `<p class="empty-note">${idea.status === 'processing' ? 'Luna is generating pitches. Refresh in a moment.' : idea.error?.message || 'No pitches are available yet.'}</p>`}</div>${idea.status === 'failed' ? '<p class="story-blocker">Pitch generation needs attention. Regenerate the idea to retry.</p>' : ''}${idea.local ? '<p class="field-note"><a class="text-link" href="/newsroom/ideas?mock=1&prompt=Is%20Hyperliquid%20taking%20market%20share%3F">Try another local preview</a></p>' : `<div class="form-actions"><button type="button" class="quiet" data-archive-idea="${esc(idea.id)}">Archive idea</button>${['admin', 'editor'].includes(profileRecord.role) ? `<details class="destructive-actions"><summary>Permanent deletion</summary><p class="field-note">Deletes this idea and its generated pitch choices. Any downstream commissioned newsroom work remains intact.</p><button type="button" class="danger-quiet compact-button" data-delete-idea="${esc(idea.id)}">Delete idea permanently</button></details>` : ''}</div>`}</section><dialog id="idea-pitch-dialog" class="commission-dialog"></dialog>` : '<section class="desk-section"><p class="empty-note">No ideas yet. Submit the first loose request above.</p></section>'}
    ${history.length ? `<section class="desk-section"><div class="section-head"><div><span class="label">Idea history</span><h2>Recent requests</h2></div></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Request</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${history.map(row => `<tr><td>${esc(row.prompt)}</td><td><span class="stamp st-${esc(row.status)}">${esc(ideaStatusLabel(row.status))}</span></td><td>${esc(dShort(row.updated_at))}</td><td><a class="text-link" href="/newsroom/ideas?idea=${encodeURIComponent(row.id)}">Open</a></td></tr>`).join('')}</tbody></table></div></section>` : ''}
  </div>`;
  const form = document.querySelector('#idea-form');
  form.onsubmit = async event => {
    event.preventDefault();
    const message = form.querySelector('[data-form-message]');
    const prompt = String(new FormData(form).get('prompt') || '').trim();
    try {
      const request = validateNewsroomJobRequest({ job_type: 'generate_idea_pitches', prompt, priority: 50 });
      if (local) return location.href = `/newsroom/ideas?mock=1&prompt=${encodeURIComponent(prompt)}`;
      setBusy(form, true, 'Generating…');
      const result = await pipelineRequest('/api/newsroom/pipeline/jobs', request);
      if (!result?.idea?.id) throw new Error('The idea was accepted without an idea ID. Reload the page and try again.');
      location.href = `/newsroom/ideas?idea=${encodeURIComponent(result.idea.id)}`;
    } catch (error) { setBusy(form, false); showFormMessage(form, error.message); if (message) message.hidden = false; }
  };
  document.querySelector('[data-regenerate-idea]')?.addEventListener('click', () => { form.querySelector('[name="prompt"]').focus(); form.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  document.querySelector('[data-archive-idea]')?.addEventListener('click', async event => { const button = event.currentTarget; button.disabled = true; const { error } = await sb.from('editorial_ideas').update({ status: 'archived', archived_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', button.dataset.archiveIdea); if (error) { button.disabled = false; return showFormMessage(form, error.message); } location.href = '/newsroom/ideas'; });
  document.querySelector('[data-delete-idea]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const confirmation = window.prompt('This permanently deletes the idea and its generated pitch choices. Commissioned downstream newsroom work is preserved. Type DELETE IDEA to continue.');
    if (confirmation !== 'DELETE IDEA') return;
    button.disabled = true;
    const { error } = await sb.rpc('delete_editorial_idea', { p_idea_id: button.dataset.deleteIdea, p_confirmation: confirmation });
    if (error) { button.disabled = false; return showFormMessage(form, error.message || 'The idea could not be deleted.'); }
    location.href = '/newsroom/ideas';
  });
  const ideaPitchDialog = document.querySelector('#idea-pitch-dialog');
  const pitchById = new Map(pitches.map(pitch => [ideaPitchKey(pitch), pitch]));
  let ideaPitchTrigger = null;
  ideaPitchDialog?.addEventListener('close', () => ideaPitchTrigger?.focus?.());
  const showDialog = dialog => {
    ideaPitchTrigger = document.activeElement;
    dialog.setAttribute('aria-modal', 'true');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => dialog.querySelector('[data-close-idea-pitch], button, input, select, textarea')?.focus());
  };
  const openIdeaPitch = pitchId => {
    const pitch = pitchById.get(pitchId); if (!pitch || !ideaPitchDialog) return;
    ideaPitchDialog.innerHTML = ideaPitchDetailMarkup(pitch, { local: Boolean(idea.local) });
    showDialog(ideaPitchDialog);
    ideaPitchDialog.querySelector('[data-close-idea-pitch]')?.addEventListener('click', () => ideaPitchDialog.close?.());
    const commissionForm = ideaPitchDialog.querySelector('[data-idea-commission-form]');
    if (!commissionForm) return;
    commissionForm.setAttribute('novalidate', '');
    commissionForm.querySelector('[data-idea-source]')?.setAttribute('name', 'source_url');
    commissionForm.querySelector('[data-idea-length]')?.setAttribute('name', 'length');
    commissionForm.addEventListener('submit', async event => {
      event.preventDefault();
      const button = commissionForm.querySelector('[data-commission-idea-pitch]');
      const values = Object.fromEntries(new FormData(commissionForm));
      const sourceUrl = String(values.source_url || '').trim();
      if (!/^https?:\/\/[^\s]+$/i.test(sourceUrl)) {
        showFormMessage(commissionForm, 'Add a verified http or https primary source before commissioning this pitch.');
        commissionForm.querySelector('[data-idea-source]')?.focus();
        return;
      }
      button.disabled = true; showFormMessage(commissionForm, 'Commissioning into the existing research and writing queue…');
      try {
        const result = await pipelineRequest(`/api/newsroom/ideas/${encodeURIComponent(idea.id)}/commission`, { pitch_id: button.dataset.commissionIdeaPitch, length: values.length, source_url: sourceUrl });
        if (result.status !== 'commissioned') throw new Error('The pitch was not commissioned.');
        pitch.status = 'commissioned'; pitch.recommended_length = values.length; button.textContent = 'Commissioned'; showFormMessage(commissionForm, 'Commission accepted. The focused pitch will appear under Pitches after processing. Choose Commission reporting there to start source acquisition; On Deck appears after writing is complete.', 'ok');
        const row = document.querySelector(`[data-idea-pitch-row="${CSS.escape(ideaPitchKey(pitch))}"]`); row?.querySelector('.stamp')?.replaceChildren(document.createTextNode('Commissioned'));
      } catch (error) { button.disabled = false; showFormMessage(commissionForm, error.message); }
    });
  };
  ideaPitchDialog?.addEventListener('click', event => { if (event.target === ideaPitchDialog) ideaPitchDialog.close?.(); });
  document.querySelectorAll('[data-open-idea-pitch]').forEach(button => button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openIdeaPitch(button.dataset.openIdeaPitch); }));
  document.querySelectorAll('[data-idea-pitch-row]').forEach(row => {
    row.addEventListener('click', event => { if (!event.target.closest('button, a, input, label')) openIdeaPitch(row.dataset.ideaPitchRow); });
    row.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button, a, input, label')) { event.preventDefault(); openIdeaPitch(row.dataset.ideaPitchRow); } });
  });
  bindSignOut();
}

const PITCH_STATUS_LABELS = { pitch: 'Pitch', processing: 'Processing', needs_attention: 'Needs attention', passed: 'Passed' };

function pitchRowMarkup({ candidate, pitch, status }) {
  const sourceLabel = `${pitch.sourceCount} source${pitch.sourceCount === 1 ? '' : 's'}`;
  const taxonomy = [lensLabel(pitch.lens), sectionLabel(pitch.section), pitch.beats.map(beatLabel).join(', ')].filter(Boolean).join(' · ');
  const detail = status === 'processing'
    ? 'Enrichment is still running.'
    : status === 'needs_attention'
      ? pitchEnrichmentReason(candidate)
      : status === 'passed'
        ? pitchEnrichmentReason(candidate)
        : [taxonomy, sourceLabel].filter(Boolean).join(' · ');
  return `<article class="pitch-row" id="pitch-${esc(candidate.id)}" data-pitch-row data-candidate-id="${esc(candidate.id)}" tabindex="0"><label class="pitch-row-select"><input type="checkbox" data-pitch-select value="${esc(candidate.id)}" aria-label="Select ${esc(pitch.headline)}"></label><div class="pitch-row-main"><span class="stamp st-${esc(status === 'processing' ? 'writing' : status)}">${esc(PITCH_STATUS_LABELS[status] || status)}</span><a href="#pitch-${esc(candidate.id)}" class="pitch-row-title" data-open-pitch="${esc(candidate.id)}">${esc(pitch.headline)}</a><p class="pitch-row-meta">${esc(detail)} · ${esc(dShort(pitch.discoveryDate))}</p></div><div class="pitch-row-actions"><button type="button" class="quiet compact-button" data-open-pitch="${esc(candidate.id)}">Open</button><button type="button" class="quiet compact-button" data-archive-pitch="${esc(candidate.id)}">Archive</button><p class="notice form-message" data-pitch-message hidden></p></div></article>`;
}

function pitchDetailMarkup({ candidate, pitch, status, profile }) {
  const cleanup = disposableCleanupMarkup({ candidate, profile });
  const sourceLabel = `${pitch.sourceCount} source${pitch.sourceCount === 1 ? '' : 's'}`;
  const actions = status === 'pitch'
    ? `<button type="button" data-detail-commission="${esc(candidate.id)}">Commission</button>`
    : status === 'needs_attention'
      ? discoveryEnrichmentRetryable(candidate)
        ? `<button type="button" data-retry-enrichment="${esc(candidate.external_id || '')}">Retry enrichment</button>`
        : '<span class="field-note">Enrichment has completed; review the retained pitch fields.</span>'
      : status === 'processing'
        ? '<button type="button" disabled>Processing…</button>'
        : '';
  return `<div class="pitch-detail"><div class="section-head"><div><span class="label">${esc(PITCH_STATUS_LABELS[status] || status)}</span><h2>${esc(pitch.headline)}</h2></div><button type="button" class="quiet compact-button" data-close-pitch-detail>Close</button></div><p class="pitch-summary">${esc(pitch.pitch || (status === 'processing' ? 'Enrichment is still running.' : pitchEnrichmentReason(candidate)))}</p><dl class="pitch-facts"><div><dt>Why it matters</dt><dd>${esc(pitch.why || 'Not retained')}</dd></div><div><dt>Lens</dt><dd>${esc(lensLabel(pitch.lens) || 'Not assigned')}</dd></div><div><dt>Section</dt><dd>${esc(sectionLabel(pitch.section) || 'Not assigned')}</dd></div><div><dt>Beat</dt><dd>${esc(pitch.beats.map(beatLabel).join(', ') || 'Not assigned')}</dd></div><div><dt>Sources</dt><dd>${esc(sourceLabel)}</dd></div><div><dt>Discovered</dt><dd>${esc(dShort(pitch.discoveryDate))}</dd></div></dl>${pitch.warnings?.map(warning => `<p class="field-note" role="status">${esc(warning)}</p>`).join('') || ''}${status === 'processing' ? '<p class="field-note">Commission will appear after the pitch, taxonomy, and source reference are retained.</p>' : ''}${status === 'needs_attention' || status === 'passed' ? `<p class="story-blocker"><strong>${status === 'passed' ? 'Why we passed' : 'Issue'}</strong> ${esc(pitchEnrichmentReason(candidate))}</p>` : ''}<div class="form-actions">${actions}<button type="button" class="quiet" data-detail-archive="${esc(candidate.id)}">Archive</button>${cleanup}</div><p class="notice form-message" data-detail-message hidden></p></div>`;
}

function writerDisplay({ candidate = {}, job = null } = {}) {
  const selection = job?.parameters?.writer || candidate.classification?.editorial_assignment?.writer;
  if (selection) return writerOption(selection).label;
  return modelLabel(job?.parameters?.writer_model || candidate.model || '', job?.job_type || '');
}

function lengthDisplay({ candidate = {}, job = null } = {}) {
  const value = job?.parameters?.length || candidate.classification?.editorial_assignment?.length;
  return value ? lengthOption(value).label : '';
}

function jobForCandidate(candidate, jobs = []) {
  return jobs
    .filter(job => job.pipeline_candidate_id === candidate.id || job.parameters?.candidate_id === candidate.external_id)
    .sort((a, b) => new Date(b.finished_at || b.started_at || b.created_at || 0) - new Date(a.finished_at || a.started_at || a.created_at || 0))[0] || null;
}

function editorialStatusFor(candidate, story, job) {
  return deriveEditorialStatus({ candidate: candidate || {}, story: story || {}, job: job || null });
}

function researchAgainActionMarkup({ candidate = {}, job = null } = {}) {
  const research = researchAgainDetails(candidate, job);
  const externalId = esc(candidate.external_id || job?.parameters?.candidate_id || candidate.id || '');
  if (!research.required) return '';
  if (research.active) return '<div class="form-actions"><button class="quiet" type="button" data-research-again-disabled disabled title="Research is already queued or running.">Research Again</button><span class="field-note">Research already queued or running.</span></div>';
  if (!research.assignmentComplete) return '<p class="field-note">Research Again is unavailable because the original writer assignment was not retained.</p>';
  return `<div class="form-actions"><button class="button" type="button" data-research-again="${externalId}">Research Again</button><span class="field-note">More evidence is required before drafting can continue.</span></div>`;
}

function replayStageForJob(job = {}) {
  const stage = job.error?.details?.stage || job.error?.stage || job.result?.error?.details?.stage || job.result?.result?.error?.details?.stage || '';
  return ({ source_inventory: 'research', researching: 'research', research: 'research', evidence_packet: 'packet', packet: 'packet', draft: 'writer', drafting: 'writer', draft_review: 'review', ai_review: 'review', review: 'review' })[stage] || null;
}

function replayRunIdForJob(job = {}) {
  const records = [job.result, job.result?.result, job.result?.result?.result, job.error, job.error?.details];
  return records.find(item => item?.run_id)?.run_id || null;
}

function replayActionMarkup({ candidate = {}, job = null } = {}) {
  if (!job || job.status !== 'failed') return '';
  const stage = replayStageForJob(job);
  const parentRunId = replayRunIdForJob(job);
  if (!stage || !parentRunId) return '';
  const assignment = candidate.classification?.editorial_assignment || {};
  const writer = job.parameters?.writer || assignment.writer;
  const length = job.parameters?.length || assignment.length;
  if (!writer || !length) return '';
  const plan = replayPlan(stage);
  return `<div class="form-actions"><button class="quiet" type="button" data-replay-stage="${esc(stage)}" data-replay-parent-run="${esc(parentRunId)}" data-replay-writer="${esc(writer)}" data-replay-length="${esc(length)}" data-replay-candidate="${esc(candidate.external_id || job.parameters?.candidate_id || candidate.id || '')}">Replay from ${esc(plan.canonical_stage === 'evidence_packet' ? 'Packet' : plan.canonical_stage === 'draft' ? 'Writer' : plan.canonical_stage === 'ai_review' ? 'Review' : 'Research')}</button><span class="field-note">Prior attempts remain in Activity.</span></div>`;
}

function disposableCleanupMarkup({ candidate = {}, story = null, profile: profileRecord = null } = {}) {
  if (!candidate?.id || !['admin', 'editor'].includes(profileRecord?.role)) return '';
  if (story?.status === 'published' || story?.status === 'scheduled' || story?.published_at || story?.scheduled_for) return '';
  return `<details class="destructive-actions"><summary>Destructive actions</summary><p class="field-note">For disposable or test records only. Published, scheduled, and active work are rejected by the server.</p><button type="button" class="danger-quiet compact-button" data-cleanup-disposable="${esc(candidate.id)}" data-cleanup-story="${esc(story?.id || '')}">Delete test record</button></details>`;
}

function storyPrimaryAction({ status, story, job, candidate }) {
  const href = story?.id ? `/newsroom/${story.id}` : '';
  const researchAction = researchAgainActionMarkup({ candidate, job });
  if (status === 'writing') return `${researchAction}${job?.id ? `<a class="button quiet" href="/newsroom/stories?job=${encodeURIComponent(job.id)}#diagnostics">View progress</a>` : '<span class="field-note">Writer queued</span>'}`;
  if (status === 'draft') return href ? `<a class="button" href="${href}">Open draft</a>` : '<span class="field-note">Draft is being assembled</span>';
  if (status === 'needs_attention') return `${researchAction}${replayActionMarkup({ candidate, job })}${href ? ` <a class="button quiet" href="${href}#sources">Review claims</a>` : '<span class="field-note">Open the retained review package</span>'}`;
  if (status === 'ready') return story?.id ? `<a class="button" href="/newsroom/on-deck#story-${esc(story.id)}">Publish now</a>` : candidate?.id ? `<a class="button" href="/newsroom/stories?candidate=${encodeURIComponent(candidate.external_id || candidate.id)}#review-package">Review claims</a>` : '<span class="field-note">Ready for editorial handoff</span>';
  if (status === 'commissioned') return candidate?.external_id ? `<a class="button quiet" href="/newsroom/review/${encodeURIComponent(candidate.external_id)}">Open commissioned pitch</a>` : '<span class="field-note">Commissioned pitch retained</span>';
  if (status === 'failed' && job?.id) {
    const replayAction = replayActionMarkup({ candidate, job });
    if (isPipelineV1Job(job)) return `${researchAction}${replayAction || '<span class="field-note">No authorized retry is available for this attempt.</span>'}`;
    return `${researchAction}<button class="quiet" type="button" data-retry-job="${esc(job.id)}">Retry</button>${replayAction}`;
  }
  if (href) return `<a class="button quiet" href="${href}">Open story</a>`;
  return '<span class="field-note">Open assignment</span>';
}

async function pitchesInbox(p = null) {
  const profileRecord = p || await profile();
  if (!profileRecord) return location.href = '/newsroom';
  const [candidates, pitchReadyCandidates, sourceRows] = await Promise.all([
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,model,created_at,updated_at,canonical_url').in('status', ['discovered', 'rejected']).order('updated_at', { ascending: false }).limit(500), 'editorial pitches'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,model,created_at,updated_at,canonical_url').eq('status', 'pitch_ready').order('updated_at', { ascending: false }).limit(100), 'ready editorial pitches'),
    optionalData(sb.from('discovered_documents').select('candidate_id,id,url,canonical_url,normalized_url'), 'pitch source counts')
  ]);
  const sourceRowsByCandidate = new Map();
  sourceRows.forEach(row => { const rows = sourceRowsByCandidate.get(row.candidate_id) || []; rows.push(row); sourceRowsByCandidate.set(row.candidate_id, rows); });
  const records = [...pitchReadyCandidates, ...candidates].map(candidate => { const pitch = pitchRecord(candidate, distinctSourceCount(candidate, sourceRowsByCandidate.get(candidate.id) || [])); return { candidate, pitch, status: pitchInboxStatus(candidate, pitch) }; }).filter(item => item.status);
  const newCount = records.filter(item => item.status === 'pitch').length;
  const processingCount = records.filter(item => item.status === 'processing').length;
  const attentionCount = records.filter(item => item.status === 'needs_attention').length;
  const visible = records.filter(item => ['pitch', 'processing', 'needs_attention', 'passed'].includes(item.status));
  title('Pitches');
  app.innerHTML = `<div class="desk newsroom-home">
    <div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div><h1>Pitches</h1><p class="standfirst">Choose the next idea worth assigning. ${newCount ? `${newCount} new pitch${newCount === 1 ? '' : 'es'} need a decision.` : 'Nothing new is waiting for a decision.'}</p></div>
    ${deskNav(profileRecord, 'pitches')}
    <section class="desk-section newsroom-next"><span class="label">What needs attention next</span><div class="newsroom-counts"><strong>${newCount} <small>new</small></strong><strong>${processingCount} <small>processing</small></strong><strong>${attentionCount} <small>needs attention</small></strong></div>${editorialBatchFormMarkup()}</section>
    <section class="desk-section"><div class="section-head"><div><span class="label">Inbox</span><h2>${visible.length} item${visible.length === 1 ? '' : 's'} to decide</h2></div><p class="field-note">Select several pitches to archive, delete, or commission. Open a row for the full pitch and retained sources.</p></div>
      <div class="pitch-bulk-toolbar"><label class="pitch-select-all"><input type="checkbox" id="select-all-pitches"> Select all</label><span id="pitch-selection-count" class="field-note">0 selected</span><div class="form-actions"><button type="button" class="quiet compact-button" id="bulk-commission" disabled>Commission selected</button><button type="button" class="quiet compact-button" id="bulk-archive" disabled>Archive selected</button><button type="button" class="danger-quiet compact-button" id="bulk-delete" disabled>Delete selected</button></div><p class="notice form-message" id="pitch-bulk-message" hidden></p></div>
      <div class="pitch-list">${visible.map(item => pitchRowMarkup(item)).join('') || '<p class="empty-note">No new pitches are waiting. Run discovery when you are ready for the next batch.</p>'}</div>
    </section>
    <dialog id="pitch-detail-dialog" class="commission-dialog"></dialog>
    <dialog id="commission-dialog" class="commission-dialog"><form method="dialog" id="commission-form"><div class="section-head"><div><span class="label">Assign story</span><h2>Commission selected pitches</h2></div><button type="button" class="quiet compact-button" data-close-commission>Close</button></div><p class="field-note" id="commission-pitch-label"></p><input type="hidden" name="candidate_id"><input type="hidden" name="external_id"><div class="commission-grid"><label>Writer<select name="writer">${WRITER_OPTIONS.map(option => `<option value="${option.value}" ${option.value === DEFAULT_WRITER_SELECTION.writer ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label><label>Length<select name="length">${LENGTH_OPTIONS.map(option => `<option value="${option.value}" ${option.value === DEFAULT_WRITER_SELECTION.length ? 'selected' : ''}>${esc(option.label)}</option>`).join('')}</select></label></div><details><summary>Advanced</summary><label>Research requirement<select name="research_requirement"><option value="">Use pitch decision</option><option value="none">Bounded source acquisition</option><option value="required">Additional research required</option></select></label></details><p class="notice form-message" data-form-message hidden></p><div class="form-actions"><button type="submit">Start writing</button></div></form></dialog>
    <dialog id="bulk-delete-dialog" class="commission-dialog"><form method="dialog" id="bulk-delete-form"><div class="section-head"><div><span class="label">Destructive action</span><h2>Delete selected pitches</h2></div><button type="button" class="quiet compact-button" data-close-bulk-delete>Cancel</button></div><p class="field-note">This permanently removes each selected candidate and its retained pipeline records. Linked unpublished stories are deleted. Published or scheduled stories are preserved and detached. Active work must finish or be cancelled first.</p><label for="bulk-delete-confirmation">Type <strong>DELETE SELECTED PITCHES</strong> to continue</label><input id="bulk-delete-confirmation" name="confirmation" autocomplete="off" required><p class="notice form-message" data-form-message hidden></p><div class="form-actions"><button type="submit" class="danger-quiet">Delete pitches</button></div></form></dialog>
  </div>`;
  bindEditorialBatchForm(document.querySelector('#run-editorial-batch'));
  const itemByCandidateId = new Map(visible.map(item => [item.candidate.id, item]));
  const detailDialog = document.querySelector('#pitch-detail-dialog');
  const commissionDialog = document.querySelector('#commission-dialog');
  const commissionForm = document.querySelector('#commission-form');
  const selectionCount = document.querySelector('#pitch-selection-count');
  const bulkMessage = document.querySelector('#pitch-bulk-message');
  const selectAll = document.querySelector('#select-all-pitches');
  const bulkCommission = document.querySelector('#bulk-commission');
  const bulkArchive = document.querySelector('#bulk-archive');
  const bulkDelete = document.querySelector('#bulk-delete');
  let bulkCommissionIds = [];

  const dialogTriggers = new WeakMap();
  const showDialog = dialog => {
    dialogTriggers.set(dialog, document.activeElement);
    dialog.setAttribute('aria-modal', 'true');
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => dialog.querySelector('button, input, select, textarea, [tabindex="0"]')?.focus());
  };
  [detailDialog, commissionDialog].forEach(dialog => {
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close?.(); });
    dialog.addEventListener('close', () => dialogTriggers.get(dialog)?.focus?.());
  });
  const selectedItems = () => [...document.querySelectorAll('[data-pitch-select]:checked')].map(input => itemByCandidateId.get(input.value)).filter(Boolean);
  const setBulkMessage = (message, kind = 'error') => { bulkMessage.textContent = message; bulkMessage.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`; bulkMessage.setAttribute('role', kind === 'ok' ? 'status' : 'alert'); bulkMessage.hidden = !message; };
  const updateSelection = () => {
    const boxes = [...document.querySelectorAll('[data-pitch-select]')];
    const selected = selectedItems();
    selectionCount.textContent = `${selected.length} selected`;
    selectAll.checked = boxes.length > 0 && selected.length === boxes.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
    bulkCommission.disabled = !selected.some(item => item.status === 'pitch');
    bulkArchive.disabled = selected.length === 0;
    bulkDelete.disabled = selected.length === 0;
  };
  const openPitchDetail = candidateId => {
    const item = itemByCandidateId.get(candidateId); if (!item) return;
    detailDialog.innerHTML = pitchDetailMarkup({ ...item, profile: profileRecord });
    showDialog(detailDialog);
    detailDialog.querySelector('[data-close-pitch-detail]').onclick = () => detailDialog.close?.();
    detailDialog.querySelector('[data-detail-commission]')?.addEventListener('click', () => { detailDialog.close?.(); openCommission([item]); });
    detailDialog.querySelector('[data-detail-archive]')?.addEventListener('click', () => archiveCandidates([item.candidate.id], detailDialog.querySelector('[data-detail-message]')));
    detailDialog.querySelector('[data-retry-enrichment]')?.addEventListener('click', event => retryEnrichment(event.currentTarget));
    bindDisposableCleanupActions();
  };
  const openCommission = items => {
    bulkCommissionIds = items.map(item => item.candidate.id);
    const first = items[0];
    commissionForm.candidate_id.value = items.length === 1 ? first.candidate.id : '';
    commissionForm.external_id.value = items.length === 1 ? first.candidate.external_id || '' : '';
    document.querySelector('#commission-pitch-label').textContent = items.length === 1 ? first.pitch.headline : `${items.length} editor-ready pitches selected`;
    showDialog(commissionDialog);
  };
  const archiveCandidates = async (ids, messageRegion = bulkMessage) => {
    const { error } = await sb.from('candidate_stories').update({ status: 'archived', updated_at: new Date().toISOString() }).in('id', ids).in('status', ['discovered', 'rejected', 'pitch_ready']);
    if (error) { messageRegion.hidden = false; messageRegion.textContent = 'The selected pitches could not be archived.'; return false; }
    location.reload(); return true;
  };
  const retryEnrichment = async button => {
    const message = button.closest('.pitch-row, .pitch-detail')?.querySelector('[data-pitch-message], [data-detail-message]') || bulkMessage;
    button.disabled = true; button.textContent = 'Retrying…';
    try { await pipelineRequest('/api/newsroom/pipeline/jobs', validateNewsroomJobRequest({ job_type: 'enrich_discovery_candidate', candidate_id: button.dataset.retryEnrichment, priority: 60 })); location.reload(); }
    catch (error) { button.disabled = false; button.textContent = 'Retry enrichment'; message.hidden = false; message.textContent = error.message || 'Enrichment could not be queued.'; }
  };
  document.querySelectorAll('[data-pitch-select]').forEach(input => input.addEventListener('change', updateSelection));
  selectAll.onchange = () => { document.querySelectorAll('[data-pitch-select]').forEach(input => { input.checked = selectAll.checked; }); updateSelection(); };
  document.querySelectorAll('[data-open-pitch]').forEach(button => button.onclick = event => { event.preventDefault(); event.stopPropagation(); openPitchDetail(button.dataset.openPitch); });
  document.querySelectorAll('[data-pitch-row]').forEach(row => {
    row.onclick = event => { if (!event.target.closest('button, input, a, label')) openPitchDetail(row.dataset.candidateId); };
    row.onkeydown = event => { if ((event.key === 'Enter' || event.key === ' ') && !event.target.closest('button, input, a, label')) { event.preventDefault(); openPitchDetail(row.dataset.candidateId); } };
  });
  bulkCommission.onclick = () => { const items = selectedItems().filter(item => item.status === 'pitch'); if (!items.length) return setBulkMessage('Select at least one editor-ready pitch to commission.'); openCommission(items); };
  bulkArchive.onclick = () => archiveCandidates(selectedItems().map(item => item.candidate.id));
  document.querySelector('[data-close-commission]').onclick = () => { bulkCommissionIds = []; commissionDialog.close?.(); };
  commissionForm.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(commissionForm));
    const items = (bulkCommissionIds.length ? bulkCommissionIds.map(id => itemByCandidateId.get(id)).filter(Boolean) : [itemByCandidateId.get(values.candidate_id)]).filter(Boolean);
    try {
      if (!items.length) throw new Error('Select a pitch before commissioning.');
      const requests = items.map(item => validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: item.candidate.external_id, pipeline_version: 'v1', writer: values.writer, length: values.length, ...(values.research_requirement ? { research_requirement: values.research_requirement } : {}) }));
      setBusy(commissionForm, true, `Starting 1 of ${requests.length}…`);
      const failures = [];
      for (let offset = 0; offset < requests.length; offset += 8) {
        const batch = requests.slice(offset, offset + 8);
        const results = await Promise.all(batch.map((request, batchIndex) => pipelineRequest('/api/newsroom/pipeline/jobs', request).catch(error => ({ error, index: offset + batchIndex }))));
        results.forEach(result => { if (result?.error) failures.push(`${items[result.index].pitch.headline}: ${result.error.message || 'request failed'}`); });
        const button = commissionForm.querySelector('button[type="submit"]'); if (button) button.textContent = `Starting ${Math.min(offset + batch.length + 1, requests.length)} of ${requests.length}…`;
      }
      if (failures.length) { setBusy(commissionForm, false); showFormMessage(commissionForm, `${requests.length - failures.length} started; ${failures.length} could not be queued. ${failures[0]}`); return; }
      location.href = '/newsroom/stories';
    } catch (error) {
      setBusy(commissionForm, false); showFormMessage(commissionForm, error.message || 'The pitch could not be commissioned.');
    }
  };
  document.querySelectorAll('[data-retry-enrichment]').forEach(button => button.onclick = () => retryEnrichment(button));
  document.querySelectorAll('[data-archive-pitch]').forEach(button => button.onclick = () => archiveCandidates([button.dataset.archivePitch], button.closest('.pitch-row')?.querySelector('[data-pitch-message]') || bulkMessage));
  const deleteDialog = document.querySelector('#bulk-delete-dialog');
  const deleteForm = document.querySelector('#bulk-delete-form');
  deleteDialog.addEventListener('click', event => { if (event.target === deleteDialog) deleteDialog.close?.(); });
  deleteDialog.addEventListener('close', () => dialogTriggers.get(deleteDialog)?.focus?.());
  bulkDelete.onclick = () => { deleteForm.reset(); deleteForm.querySelector('[data-form-message]').hidden = true; showDialog(deleteDialog); deleteForm.querySelector('[name="confirmation"]').focus(); };
  document.querySelector('[data-close-bulk-delete]').onclick = () => deleteDialog.close?.();
  deleteForm.onsubmit = async event => {
    event.preventDefault();
    if (new FormData(deleteForm).get('confirmation') !== 'DELETE SELECTED PITCHES') return showFormMessage(deleteForm, 'Type DELETE SELECTED PITCHES exactly to continue.');
    const ids = selectedItems().map(item => item.candidate.id); setBusy(deleteForm, true, `Deleting 1 of ${ids.length}…`);
    const failures = [];
    for (let offset = 0; offset < ids.length; offset += 8) {
      const batch = ids.slice(offset, offset + 8);
      const results = await Promise.all(batch.map(id => sb.rpc('delete_newsroom_queue_items', { p_story_ids: [], p_candidate_ids: [id], p_confirmation: 'DELETE NEWSROOM ITEMS' })));
      results.forEach((result, index) => { if (result.error) failures.push(`${itemByCandidateId.get(batch[index])?.pitch.headline || batch[index]}: ${result.error.message || 'request failed'}`); });
      const button = deleteForm.querySelector('button[type="submit"]'); if (button) button.textContent = `Deleting ${Math.min(offset + batch.length + 1, ids.length)} of ${ids.length}…`;
    }
    if (failures.length) { setBusy(deleteForm, false); showFormMessage(deleteForm, `${ids.length - failures.length} deleted; ${failures.length} could not be removed. ${failures[0]}`); return; }
    location.reload();
  };
  updateSelection();
  bindDisposableCleanupActions();
  bindSignOut();
}

function evidenceCompactionFromJob(job) {
  return job?.result?.result?.result?.evidence_compaction
    || job?.result?.result?.evidence_compaction
    || job?.result?.error?.details?.compaction
    || job?.error?.details?.compaction
    || null;
}

function evidenceCompactionSummary(report) {
  if (!report || !Number.isFinite(report.original_characters) || !Number.isFinite(report.compacted_characters)) return '';
  const trimmed = Number(report.sources_trimmed || 0);
  const removed = Number(report.sources_removed || 0);
  const sourceText = removed ? `${trimmed} source${trimmed === 1 ? '' : 's'} trimmed; ${removed} removed.` : `${trimmed} source${trimmed === 1 ? '' : 's'} trimmed. No claim-linked sources removed.`;
  return `<p class="field-note evidence-compaction-summary">Evidence packet compacted from ${esc(report.original_characters.toLocaleString())} to ${esc(report.compacted_characters.toLocaleString())} characters. ${esc(sourceText)}</p>`;
}

async function storiesInbox() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const diagnosticJobId = new URLSearchParams(location.search).get('job');
  const [stories, candidates, jobs, links, diagnosticEvents] = await Promise.all([
    optionalData(sb.from('stories').select('id,title,slug,dek,body,status,published_at,scheduled_for,updated_at,sections!stories_section_id_fkey(name),profiles!stories_author_id_fkey(name)').order('updated_at', { ascending: false }).limit(160), 'active stories'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,model,created_at,updated_at').order('updated_at', { ascending: false }).limit(160), 'commissioned pitches'),
    optionalData(sb.from('pipeline_jobs').select('id,pipeline_candidate_id,job_type,parameters,status,error,result,created_at,started_at,finished_at,profiles(name)').order('created_at', { ascending: false }).limit(240), 'story writer jobs'),
    optionalData(sb.from('pipeline_story_links').select('candidate_id,story_id'), 'story links'),
    diagnosticJobId ? optionalData(sb.from('pipeline_job_events').select('id,at,level,event_type,message,metadata').eq('job_id', diagnosticJobId).order('at'), 'story diagnostics') : Promise.resolve([])
  ]);
  const storiesById = new Map(stories.map(story => [story.id, story]));
  const linksByCandidate = new Map(links.map(link => [link.candidate_id, link.story_id]));
  const linkedStoryIds = new Set();
  const cards = [];
  candidates.forEach(candidate => {
    const storyId = linksByCandidate.get(candidate.id); const story = storyId ? storiesById.get(storyId) : null; if (storyId) linkedStoryIds.add(storyId);
    const job = jobForCandidate(candidate, jobs); const status = editorialStatusFor(candidate, story, job);
    if (!['pitch', 'archived', 'published', 'scheduled'].includes(status)) cards.push({ candidate, story, job, status, activity: editorialActivityDate({ candidate, story: story || {}, job: job || null }), issue: editorialBlockingIssue({ candidate, job }) });
  });
  stories.filter(story => !linkedStoryIds.has(story.id)).forEach(story => {
    const status = deriveEditorialStatus({ story });
    if (!['published', 'scheduled', 'archived'].includes(status)) cards.push({ story, status, activity: editorialActivityDate({ story }), issue: '' });
  });
  const requested = new URLSearchParams(location.search).get('status') || 'all';
  const allowed = new Set(['all', 'writing', 'draft', 'needs_attention', 'ready']);
  const filter = allowed.has(requested) ? requested : 'all';
  const visible = cards.filter(card => filter === 'all' || card.status === filter);
  const attention = cards.filter(card => card.status === 'needs_attention' || card.status === 'failed');
  const filterLink = value => `/newsroom/stories${value === 'all' ? '' : `?status=${value}`}`;
  const reviewCandidateId = new URLSearchParams(location.search).get('candidate');
  const reviewCandidate = reviewCandidateId ? candidates.find(candidate => candidate.external_id === reviewCandidateId || candidate.id === reviewCandidateId) : null;
  const reviewCandidateJob = reviewCandidate ? jobForCandidate(reviewCandidate, jobs) : null;
  const reviewDraftRows = reviewCandidate
    ? await optionalData(sb.from('pipeline_drafts').select('id,version,headline,dek,body_markdown,pipeline_claims(id,claim,status,note,resolved_at)').eq('candidate_id', reviewCandidate.id).order('version', { ascending: false }).limit(1), 'story review package')
    : [];
  const reviewDraft = reviewDraftRows[0] || null;
  const reviewClaims = reviewDraft?.pipeline_claims || [];
  const reviewMarkup = reviewCandidate
    ? `<section class="desk-section inline-review" id="review-package"><div class="section-head"><div><span class="label">Ready package</span><h2>Review claims · ${esc(reviewCandidate.title || 'Untitled story')}</h2></div><a class="text-link" href="/newsroom/stories">Close</a></div><p class="field-note">This is the retained review package. Approving it creates the canonical story record and opens the existing editor; it does not publish.</p>${reviewDraft ? `<p><strong>${esc(reviewDraft.headline || reviewCandidate.title || 'Untitled story')}</strong>${reviewDraft.dek ? ` · ${esc(reviewDraft.dek)}` : ''}</p><details><summary>Draft text</summary><pre class="packet-data">${esc(reviewDraft.body_markdown || 'No draft text retained.')}</pre></details>` : '<p class="field-note">No draft text was retained for this package.</p>'}${reviewClaims.length ? `<details open><summary>Claims and citation mapping (${reviewClaims.length})</summary><div class="claim-list">${reviewClaims.map(claim => `<div class="claim-row"><strong>${esc(claim.claim)}</strong><span class="stamp st-${esc(claim.status || 'unresolved')}">${esc(humanize(claim.status || 'unresolved'))}</span>${claim.note ? `<p class="field-note">${esc(claim.note)}</p>` : ''}</div>`).join('')}</div></details>` : ''}<div class="form-actions">${storyPrimaryAction({ status: editorialStatusFor(reviewCandidate, null, reviewCandidateJob), candidate: reviewCandidate, job: reviewCandidateJob })}<button type="button" data-approve-review-candidate="${esc(reviewCandidate.id)}">Approve into story editor</button></div><p class="notice form-message" data-review-message hidden></p></section>`
    : '';
  const diagnosticJob = diagnosticJobId ? jobs.find(job => job.id === diagnosticJobId) : null;
  const diagnosticMarkup = diagnosticJobId
    ? `<details class="story-diagnostics" id="diagnostics"><summary>${diagnosticJob ? `Technical details · ${esc(humanize(diagnosticJob.job_type))}` : 'Technical details unavailable'}</summary>${diagnosticJob ? `<div class="pipeline-status-grid"><div><span class="label">Status</span><p><span class="stamp st-${esc(diagnosticJob.status)}">${esc(humanize(diagnosticJob.status))}</span></p></div><div><span class="label">Assignment</span><p class="field-note">${esc(writerDisplay({ job: diagnosticJob }))}${lengthDisplay({ job: diagnosticJob }) ? ` · ${esc(lengthDisplay({ job: diagnosticJob }))}` : ''}</p></div><div><span class="label">Attempts</span><p class="field-note">${esc(`${diagnosticJob.attempt_count ?? 0}/${diagnosticJob.max_attempts ?? 0}`)}</p></div></div>${diagnosticJob.error ? `<h3>Error</h3><pre class="packet-data">${esc(JSON.stringify(diagnosticJob.error, null, 2))}</pre>` : ''}${diagnosticJob.result ? `<h3>Result</h3><pre class="packet-data">${esc(JSON.stringify(diagnosticJob.result, null, 2))}</pre>` : ''}<details><summary>Parameters</summary><pre class="packet-data">${esc(JSON.stringify(diagnosticJob.parameters || {}, null, 2))}</pre></details><h3>Timeline</h3><div class="activity-list">${diagnosticEvents.map(event => `<div class="activity-row"><span class="activity-date">${esc(dDateTime(event.at))}</span><strong>${esc(humanize(event.event_type))}</strong><span>${esc(event.message || '')}</span><span class="field-note">${esc(humanize(event.level || 'info'))}</span></div>`).join('') || '<p class="field-note">No event history retained.</p>'}</div>` : '<p class="field-note">That job is no longer in the retained queue view.</p>'}</details>`
    : '';
  title('Stories');
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div><h1>Stories</h1><p class="standfirst">${attention.length ? `${attention.length} item${attention.length === 1 ? '' : 's'} need attention next.` : 'Nothing is blocked. Keep moving the strongest story forward.'}</p></div>${deskNav(p, 'stories')}<nav class="story-filters" aria-label="Story filters">${[['all','All'],['writing','Writing'],['draft','Drafts'],['needs_attention','Needs attention'],['ready','Ready']].map(([value,label]) => `<a href="${filterLink(value)}" ${filter === value ? 'aria-current="page"' : ''}>${label}<span>${value === 'all' ? cards.length : cards.filter(card => card.status === value).length}</span></a>`).join('')}</nav>${diagnosticMarkup}${reviewMarkup}<section class="desk-section"><div class="story-list">${visible.map(card => { const candidate = card.candidate || {}; const story = card.story || {}; const label = story.title || candidate.title || 'Untitled story'; const writer = writerDisplay(card); const length = lengthDisplay(card); return `<article class="story-card" id="candidate-${esc(candidate.id || story.id)}"><div class="story-card-main"><div class="meta-line"><span class="stamp st-${esc(card.status)}">${esc(workflowLabel(card.status))}</span><span>${esc(story.sections?.name || lensLabel(candidate.classification?.primary_section || ''))}</span></div><h2>${story.id ? `<a href="/newsroom/${story.id}">${esc(label)}</a>` : esc(label)}</h2><p class="story-card-dek">${esc(story.dek || candidate.classification?.editorial_pitch?.reader_takeaway || '')}</p><p class="field-note">${esc(writer)}${length ? ` · ${esc(length)}` : ''} · Last activity ${esc(card.activity ? dDateTime(card.activity) : 'Not recorded')}</p>${card.issue ? `<p class="story-blocker"><strong>Blocking issue</strong> ${esc(card.issue)}</p>` : ''}</div><div class="story-card-action">${storyPrimaryAction(card)}${disposableCleanupMarkup({ candidate, story, profile: p })}</div></article>`; }).join('') || '<p class="empty-note">No active stories match this filter. New commissions will appear here as soon as they are queued.</p>'}</div></section></div>`;
  document.querySelector('[data-approve-review-candidate]')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const message = document.querySelector('[data-review-message]');
    button.disabled = true; button.textContent = 'Opening story editor…';
    const { data, error } = await sb.rpc('approve_pipeline_story', { p_candidate_id: button.dataset.approveReviewCandidate });
    const result = Array.isArray(data) ? data[0] : data;
    if (error || !result?.story_id) {
      button.disabled = false; button.textContent = 'Approve into story editor'; message.hidden = false; message.textContent = error?.message || 'The review package could not be opened.'; return;
    }
    location.href = `/newsroom/${result.story_id}#article`;
  });
  bindResearchAgainActions(cards.map(card => ({ candidate: card.candidate, job: card.job })).filter(item => item.candidate));
  bindReplayActions(cards.map(card => ({ candidate: card.candidate, job: card.job })).filter(item => item.candidate));
  bindDisposableCleanupActions();
  document.querySelectorAll('[data-retry-job]').forEach(button => button.onclick = async () => {
    button.disabled = true; button.textContent = 'Retrying…';
    try { await pipelineRequest(`/api/newsroom/pipeline/jobs/${button.dataset.retryJob}/retry`, {}); location.reload(); }
    catch (error) { button.disabled = false; button.textContent = 'Retry'; window.alert(error.message || 'The job could not be retried.'); }
  });
  const compactionSummary = evidenceCompactionSummary(evidenceCompactionFromJob(diagnosticJob));
  if (compactionSummary) document.querySelector('#diagnostics')?.insertAdjacentHTML('afterbegin', compactionSummary);
  bindSignOut();
}

function bindResearchAgainActions(records = []) {
  const byId = new Map(records.flatMap(record => [[record.candidate.external_id, record], [record.candidate.id, record], [record.job?.parameters?.candidate_id, record]].filter(([key]) => key)));
  document.querySelectorAll('[data-research-again]').forEach(button => {
    button.onclick = async () => {
      const cardId = button.closest('[id^="candidate-"]')?.id.replace(/^candidate-/, '');
      const record = byId.get(button.dataset.researchAgain) || byId.get(cardId);
      if (!record) return;
      const details = researchAgainDetails(record.candidate, record.job);
      if (!details.required || details.active) return;
      const writer = writerOption(details.writer).label;
      const length = lengthOption(details.length).label;
      if (!await confirmResearchAgain(details, writer, length)) return;
      button.disabled = true;
      button.textContent = 'Starting research…';
      try {
        const payload = validateNewsroomJobRequest(researchAgainRequest(record.candidate, record.job));
        const result = await pipelineRequest('/api/newsroom/pipeline/jobs', payload);
        if (!result?.job?.id) throw new Error('The Research Again request did not return a job ID.');
        location.href = `/newsroom/stories?job=${encodeURIComponent(result.job.id)}#diagnostics`;
      } catch (error) {
        button.disabled = false;
        button.textContent = 'Research Again';
        window.alert(error.message || 'Research could not be started.');
      }
    };
  });
}

function bindReplayActions(records = []) {
  const byCandidate = new Map(records.map(record => [record.candidate.external_id || record.candidate.id, record]));
  document.querySelectorAll('[data-replay-stage]').forEach(button => {
    button.onclick = async () => {
      const record = byCandidate.get(button.dataset.replayCandidate) || records.find(item => item.job?.parameters?.candidate_id === button.dataset.replayCandidate);
      if (!record) return;
      const plan = replayPlan(button.dataset.replayStage);
      const assignment = record.candidate.classification?.editorial_assignment || {};
      const writer = record.job?.parameters?.writer || assignment.writer;
      const length = record.job?.parameters?.length || assignment.length;
      if (!await confirmReplay(plan, writerOption(writer).label, lengthOption(length).label, record.job?.error?.message || record.job?.result?.error?.message || 'The stage failed.')) return;
      button.disabled = true; button.textContent = 'Replaying…';
      try {
        const payload = validateNewsroomJobRequest({ job_type: 'process_candidate', candidate_id: button.dataset.replayCandidate, pipeline_version: 'v1', authorization: 'replay_from_stage', replay_from_stage: button.dataset.replayStage, parent_run_id: button.dataset.replayParentRun, writer, length });
        const result = await pipelineRequest('/api/newsroom/pipeline/jobs', payload);
        if (!result?.job?.id) throw new Error('The replay request did not return a job ID.');
        location.href = `/newsroom/stories?job=${encodeURIComponent(result.job.id)}#diagnostics`;
      } catch (error) {
        button.disabled = false; button.textContent = `Replay from ${plan.canonical_stage}`;
        window.alert(error.message || 'The stage could not be replayed.');
      }
    };
  });
}

function confirmReplay(plan, writer, length, reason) {
  const trigger = document.activeElement;
  let dialog = document.querySelector('[data-replay-dialog]');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.dataset.replayDialog = 'true'; dialog.className = 'commission-dialog'; document.body.append(dialog); }
  dialog.innerHTML = `<form method="dialog"><div class="section-head"><div><span class="label">Needs attention</span><h2>Replay from ${esc(plan.canonical_stage)}</h2></div><button type="button" class="quiet compact-button" data-replay-cancel>Cancel</button></div><p><strong>Blocking reason</strong><br>${esc(reason)}</p><p><strong>Reused artifacts</strong><br>${esc(plan.reuse.join(', ') || 'None')}</p><p><strong>Stages to rerun</strong><br>${esc(plan.rerun.join(', '))}</p><p><strong>Preserved writer configuration</strong><br>${esc(writer)} · ${esc(length)}</p><p class="field-note">The earlier attempt remains visible in Activity. Published and scheduled stories are not eligible.</p><div class="form-actions"><button type="button" data-replay-confirm>Start replay</button></div></form>`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; if (dialog.open) dialog.close?.(); resolve(value); };
    dialog.addEventListener('close', () => { trigger?.focus?.(); finish(false); }, { once: true });
    dialog.querySelector('[data-replay-cancel]').onclick = () => finish(false);
    dialog.querySelector('[data-replay-confirm]').onclick = () => finish(true);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => dialog.querySelector('[data-replay-cancel]')?.focus());
  });
}

function confirmResearchAgain(details, writer, length) {
  const trigger = document.activeElement;
  let dialog = document.querySelector('[data-research-again-dialog]');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.dataset.researchAgainDialog = 'true';
    dialog.className = 'commission-dialog';
    document.body.append(dialog);
  }
  dialog.innerHTML = `<form method="dialog"><div class="section-head"><div><span class="label">Needs attention</span><h2>Research Again</h2></div><button type="button" class="quiet compact-button" data-research-again-cancel>Cancel</button></div><p class="field-note">More research is required before this story can be drafted safely.</p><p><strong>Reason</strong><br>${esc(details.reason)}</p><p><strong>Preserved assignment</strong><br>${esc(writer)} · ${esc(length)}</p><p class="field-note">This starts one new attempt for the same candidate and keeps the prior attempt in Activity.</p><div class="form-actions"><button type="button" data-research-again-confirm>Start Research Again</button></div></form>`;
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (settled) return; settled = true; if (dialog.open) dialog.close?.(); resolve(value); };
    dialog.addEventListener('close', () => { trigger?.focus?.(); finish(false); }, { once: true });
    dialog.querySelector('[data-research-again-cancel]').onclick = () => finish(false);
    dialog.querySelector('[data-research-again-confirm]').onclick = () => finish(true);
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    window.requestAnimationFrame(() => dialog.querySelector('[data-research-again-cancel]')?.focus());
  });
}

async function publishedStories() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const [rows, links] = await Promise.all([
    optionalData(sb.from('stories').select('id,title,slug,dek,status,published_at,scheduled_for,updated_at,promotion_level,sections!stories_section_id_fkey(name),profiles!stories_author_id_fkey(name)').in('status', ['scheduled', 'published']).order('published_at', { ascending: false, nullsFirst: true }).order('scheduled_for', { ascending: true, nullsFirst: true }), 'published stories'),
    optionalData(sb.from('pipeline_story_links').select('story_id'), 'published story origins')
  ]);
  const automated = new Set(links.map(link => link.story_id));
  const requested = new URLSearchParams(location.search).get('status') || 'all'; const filter = ['all', 'scheduled', 'published'].includes(requested) ? requested : 'all';
  const visible = rows.filter(row => filter === 'all' || row.status === filter);
  title('Published');
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div><h1>Published</h1><p class="standfirst">Published stories and scheduled releases stay here, with their public links and newsroom provenance.</p></div>${deskNav(p, 'published')}<nav class="story-filters" aria-label="Publication filters">${[['all','All'],['scheduled','Scheduled'],['published','Published']].map(([value,label]) => `<a href="/newsroom/published${value === 'all' ? '' : `?status=${value}`}" ${filter === value ? 'aria-current="page"' : ''}>${label}<span>${value === 'all' ? rows.length : rows.filter(row => row.status === value).length}</span></a>`).join('')}</nav><section class="desk-section"><div class="published-list">${visible.map(story => { const publicPath = story.slug ? `/stories/${encodeURIComponent(story.slug)}` : ''; const origin = automated.has(story.id) ? 'automated' : 'manual idea'; return `<article class="published-card"><div><div class="meta-line"><span class="stamp st-${esc(deriveEditorialStatus({ story }))}">${esc(workflowLabel(deriveEditorialStatus({ story })))}</span><span>${story.status === 'scheduled' && story.scheduled_for ? `Publishes ${esc(dDateTime(story.scheduled_for))}` : story.published_at ? `Published ${esc(dDateTime(story.published_at))}` : ''}</span><span>Updated ${esc(dShort(story.updated_at))}</span></div><h2><a href="/newsroom/${esc(story.id)}">${esc(story.title || 'Untitled story')}</a></h2><p>${esc(story.dek || '')}</p><p class="field-note">${esc(story.sections?.name || 'Section not assigned')} · Promotion: ${esc(story.promotion_level || 'none')} · Origin: ${esc(origin)}</p><p class="form-actions">${publicPath ? `<a class="text-link" href="${esc(publicPath)}">Public URL</a>` : '<span class="field-note">Public URL not assigned</span>'} · <a class="text-link" href="/newsroom/${esc(story.id)}">Open/edit</a></p></div></article>`; }).join('') || '<p class="empty-note">No scheduled or published stories match this filter.</p>'}</div></section></div>`;
  bindSignOut();
}

async function homepageRankingNewsroom() {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  if (!['admin', 'editor'].includes(p.role)) {
    title('Homepage ranking');
    app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Homepage</span></div><h1>Editor access required</h1><p class="standfirst">Homepage ranking controls are available to editors and administrators.</p></div>${deskNav(p, 'homepage')}</div>`;
    bindSignOut();
    return;
  }
  const rows = await optionalData(sb.rpc('get_homepage_ranking_newsroom', { p_now: new Date().toISOString() }), 'homepage ranking diagnostics');
  const placementLabel = row => row.written_publishable ? ({ lead: 'Lead', homepage: 'Featured', section: 'Section row', latest: 'Latest / Search' }[row.placement] || 'Latest / Search') : 'Not eligible';
  const control = (row, action, label, className = 'quiet') => `<button type="button" class="${className} compact-button" data-ranking-action="${action}" data-ranking-story="${row.story_id}">${label}</button>`;
  const controls = row => `<div class="form-actions ranking-controls">${control(row, 'force_lead', 'Force lead')}${control(row, 'force_homepage', 'Force homepage')}${control(row, 'demote', 'Demote', 'danger-quiet')}${row.is_pinned ? control(row, 'unpin', 'Unpin') : control(row, 'pin', 'Pin')}${row.ranking_state === 'manual' || row.promotion_override ? control(row, 'release', 'Release to automatic') : ''}</div>`;
  const card = row => `<article class="published-card homepage-ranking-card"><div><div class="meta-line"><span class="stamp st-${esc(row.placement)}">${esc(placementLabel(row))}</span><span>${esc(row.section_name || 'Section not assigned')}</span><span>${row.ranking_state === 'manual' ? 'Manual' : 'Automatic'}${row.is_pinned ? ' · Pinned' : ''}</span><span>Rank ${esc(row.overall_rank)}</span></div><h2>${row.story_slug ? `<a href="/stories/${esc(row.story_slug)}">${esc(row.story_title || 'Untitled story')}</a>` : esc(row.story_title || 'Untitled story')}</h2><p class="field-note"><strong>Why:</strong> ${esc(row.ranking_reason || 'No placement explanation recorded.')}</p><div class="pipeline-status-grid ranking-factors"><div><span class="label">Editorial</span><p class="meta-line">${esc(row.editorial_score)}/10</p></div><div><span class="label">Freshness</span><p class="meta-line">${esc(Number(row.freshness_score || 0).toFixed(1))}/10</p></div><div><span class="label">Broad interest</span><p class="meta-line">${esc(Number(row.broad_interest_score || 0).toFixed(1))}/10</p></div><div><span class="label">Section relevance</span><p class="meta-line">${esc(Number(row.section_relevance_score || 0).toFixed(1))}/10</p></div><div><span class="label">Promotion</span><p class="meta-line">${esc(Number(row.promotion_score || 0).toFixed(1))}/10</p></div><div><span class="label">Topic saturation</span><p class="meta-line">${esc(Number(row.saturation_penalty || 0).toFixed(1))} penalty</p></div></div><p class="field-note">Composite rank is internal newsroom guidance. It is never sent to the public edition. ${row.promotion_override ? `Override: ${esc(row.promotion_override)}.` : 'No active promotion override.'}${row.written_publishable ? '' : ' This story is not written/publishable and cannot occupy a premium slot.'}</p>${controls(row)}</div></article>`;
  title('Homepage ranking');
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Homepage</span></div><h1>Homepage ranking</h1><p class="standfirst">Promotion is separate from publication. The homepage selects from published, written stories; everything else remains available in Latest and Search.</p></div>${deskNav(p, 'homepage')}<section class="desk-section"><div class="section-head"><div><span class="label">Editorial ranking V1</span><h2>${rows.filter(row => ['lead', 'homepage', 'section'].includes(row.placement)).length} premium placements</h2></div><p class="field-note">Automatic ranking weighs editorial score, freshness, reader breadth, section fit, the existing promotion baseline, and topic saturation. Manual choices remain active until released.</p></div><p class="notice form-message" id="homepage-ranking-message" hidden></p><div class="published-list">${rows.map(card).join('') || '<p class="empty-note">No published stories are eligible for ranking yet.</p>'}</div></section></div>`;
  const rankingList = document.querySelector('.homepage-ranking-card')?.parentElement;
  if (rankingList) {
    const renderedCards = [...rankingList.querySelectorAll('.homepage-ranking-card')];
    const otherRows = rows.map((row, index) => ({ row, card: renderedCards[index] }))
      .filter(item => !['lead', 'homepage', 'section'].includes(item.row.placement));
    if (otherRows.length) {
      const other = document.createElement('details');
      other.className = 'homepage-ranking-other';
      other.innerHTML = '<summary>All other published stories <span>' + otherRows.length + '</span></summary><div class="published-list"></div>';
      otherRows.forEach(item => other.querySelector('.published-list').append(item.card));
      rankingList.append(other);
    }
  }
  document.querySelectorAll('[data-ranking-action]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    const message = document.querySelector('#homepage-ranking-message');
    try {
      const { error } = await sb.rpc('set_homepage_ranking_override', { p_story_id: button.dataset.rankingStory, p_action: button.dataset.rankingAction });
      if (error) throw error;
      location.reload();
    } catch (error) {
      button.disabled = false;
      message.textContent = error.message || 'The homepage ranking choice could not be saved.';
      message.hidden = false;
    }
  }));
  bindSignOut();
}

function bindDisposableCleanupActions() {
  const confirmCleanup = (candidateId, storyId) => {
    const trigger = document.activeElement;
    let dialog = document.querySelector('[data-disposable-cleanup-dialog]');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.dataset.disposableCleanupDialog = 'true';
      dialog.className = 'commission-dialog';
      document.body.append(dialog);
    }
    dialog.innerHTML = `<form method="dialog"><div class="section-head"><div><span class="label">Destructive action</span><h2>Delete test record</h2></div><button type="button" class="quiet compact-button" data-disposable-cleanup-cancel>Cancel</button></div><p class="field-note">This removes the candidate, assignment metadata, inactive jobs, review package, disposable sources, and linked unpublished story. Published, scheduled, or active records are rejected by the server.</p><label for="disposable-cleanup-confirmation">Type <strong>DELETE TEST RECORD</strong> to continue</label><input id="disposable-cleanup-confirmation" name="confirmation" autocomplete="off" required><div class="form-actions"><button type="button" data-disposable-cleanup-confirm>Delete test record</button></div></form>`;
    const input = dialog.querySelector('#disposable-cleanup-confirmation');
    return new Promise(resolve => {
      let settled = false;
      const finish = value => { if (settled) return; settled = true; if (dialog.open) dialog.close?.(); resolve(value); };
      dialog.addEventListener('close', () => { trigger?.focus?.(); finish(null); }, { once: true });
      dialog.querySelector('[data-disposable-cleanup-cancel]').onclick = () => finish(null);
      dialog.querySelector('[data-disposable-cleanup-confirm]').onclick = () => finish(input.value);
      if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
      input.focus();
    });
  };
  document.querySelectorAll('[data-cleanup-disposable]').forEach(button => {
    button.onclick = async () => {
      const confirmation = await confirmCleanup(button.dataset.cleanupDisposable, button.dataset.cleanupStory || null);
      if (confirmation !== 'DELETE TEST RECORD') return;
      button.disabled = true;
      try {
        const { error } = await sb.rpc('cleanup_disposable_pipeline_record', {
          p_candidate_id: button.dataset.cleanupDisposable,
          p_story_id: button.dataset.cleanupStory || null,
          p_confirmation: confirmation
        });
        if (error) throw error;
        location.reload();
      } catch (error) {
        button.disabled = false;
        window.alert(error.message || 'The disposable record could not be removed.');
      }
    };
  });
}

function sourceRegistryOptionList(values, selected, labels = values) {
  return values.map((value, index) => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(labels[index] || humanize(value))}</option>`).join('');
}

function sourceRegistryArrayInput(values = []) {
  return esc((Array.isArray(values) ? values : []).join(', '));
}

function sourceRegistryPayload(values, existingId = '') {
  const raw = {
    name: values.name,
    handle_or_url: values.handle_or_url,
    platform: values.platform,
    source_type: values.source_type,
    primary_class: values.primary_class,
    description: values.description,
    active: values.active === 'on' || values.active === true,
    priority: Number(values.priority),
    trust_level: values.trust_level,
    direct_publish_eligible: values.direct_publish_eligible === 'on' || values.direct_publish_eligible === true,
    requires_primary_source_lookup: values.requires_primary_source_lookup === 'on' || values.requires_primary_source_lookup === true,
    primary_sections: String(values.primary_sections || '').split(',').map(item => item.trim()).filter(Boolean),
    topic_tags: String(values.topic_tags || '').split(',').map(item => item.trim()).filter(Boolean),
    chain_tags: String(values.chain_tags || '').split(',').map(item => item.trim()).filter(Boolean),
    project_tags: String(values.project_tags || '').split(',').map(item => item.trim()).filter(Boolean),
    poll_interval_seconds: Number(values.poll_interval_seconds),
    public_display_name: values.public_display_name,
    editorial_title: values.editorial_title,
    legal_or_real_name: values.legal_or_real_name,
    x_handle: values.x_handle,
    reveal_identity_policy: values.reveal_identity_policy,
    recurring_character: values.recurring_character === 'on' || values.recurring_character === true,
    public_bio: values.public_bio,
    internal_notes: values.internal_notes,
    recurring_formats: String(values.recurring_formats || '').split(',').map(item => item.trim()).filter(Boolean),
    internal_queue: values.internal_queue,
    review_status: values.review_status
  };
  const normalized = validateSourceRecord(raw, { allowId: false });
  const { id: _id, created_at: _created, updated_at: _updated, last_checked_at: _checked, last_success_at: _success, last_error: _error, ...payload } = normalized;
  return existingId ? { ...payload, id: existingId } : payload;
}

function sourceRegistryEditorMarkup(record = {}) {
  const editing = Boolean(record.id);
  return `<section class="desk-section source-registry-editor" id="source-registry-editor" aria-labelledby="source-registry-editor-heading">
    <div class="section-head"><div><span class="label">${editing ? 'Edit source' : 'Add source'}</span><h2 id="source-registry-editor-heading">${editing ? esc(record.name || 'Source') : 'New monitored source'}</h2></div><p class="field-note">Blank locators are allowed while a record is marked review needed. No polling is enabled here.</p></div>
    <form id="source-registry-form" class="desk-form" novalidate data-edit-id="${esc(record.id || '')}">
      <p class="notice form-message" data-form-message role="alert" hidden></p>
      <div class="source-registry-form-grid">
        <label>Name<input name="name" maxlength="240" required value="${esc(record.name || '')}"></label>
        <label>Handle or URL<input name="handle_or_url" maxlength="2048" placeholder="@account or https://" value="${esc(record.handle_or_url || '')}"></label>
        <label>Platform<select name="platform">${sourceRegistryOptionList(PLATFORM_OPTIONS, record.platform || 'unknown')}</select></label>
        <label>Source type<select name="source_type">${sourceRegistryOptionList(SOURCE_TYPES, record.source_type || 'official_announcements')}</select></label>
        <label>Primary class<select name="primary_class">${sourceRegistryOptionList(SOURCE_CLASSES, record.primary_class || 'community')}</select></label>
        <label>Trust level<select name="trust_level">${sourceRegistryOptionList(TRUST_LEVELS, record.trust_level || 'unknown')}</select></label>
        <label>Priority (1–10)<input name="priority" type="number" min="1" max="10" step="1" required value="${esc(record.priority ?? 5)}"></label>
        <label>Poll interval (seconds)<input name="poll_interval_seconds" type="number" min="60" step="60" required value="${esc(record.poll_interval_seconds ?? 3600)}"></label>
        <label class="source-registry-span">Description<textarea name="description" class="textarea-short" maxlength="1200">${esc(record.description || '')}</textarea></label>
        <label>Primary sections<input name="primary_sections" placeholder="Markets, Chains" value="${sourceRegistryArrayInput(record.primary_sections)}"></label>
        <label>Topic tags<input name="topic_tags" placeholder="security, protocol upgrades" value="${sourceRegistryArrayInput(record.topic_tags)}"></label>
        <label>Chain tags<input name="chain_tags" placeholder="ethereum, solana" value="${sourceRegistryArrayInput(record.chain_tags)}"></label>
        <label>Project tags<input name="project_tags" placeholder="project-slug" value="${sourceRegistryArrayInput(record.project_tags)}"></label>
        <label>Public display name<input name="public_display_name" maxlength="240" value="${esc(record.public_display_name || '')}"></label>
        <label>Editorial title<input name="editorial_title" maxlength="240" value="${esc(record.editorial_title || '')}"></label>
        <label>Legal or real name<input name="legal_or_real_name" maxlength="240" value="${esc(record.legal_or_real_name || '')}"></label>
        <label>X handle<input name="x_handle" maxlength="80" placeholder="@account" value="${esc(record.x_handle || '')}"></label>
        <label>Identity reveal policy<select name="reveal_identity_policy">${sourceRegistryOptionList(REVEAL_IDENTITY_POLICIES, record.reveal_identity_policy || 'always')}</select></label>
        <label>Internal queue<select name="internal_queue"><option value="" ${!record.internal_queue ? 'selected' : ''}>No hidden queue</option><option value="timeline_entertainment" ${record.internal_queue === 'timeline_entertainment' ? 'selected' : ''}>timeline_entertainment</option></select></label>
        <label>Review status<select name="review_status">${sourceRegistryOptionList(REVIEW_STATUSES, record.review_status || 'review_needed', ['Ready', 'Review needed'])}</select></label>
        <label class="source-registry-span">Public bio<textarea name="public_bio" class="textarea-short" maxlength="1200">${esc(record.public_bio || '')}</textarea></label>
        <label class="source-registry-span">Recurring formats<input name="recurring_formats" placeholder="balcony rant, street interaction" value="${sourceRegistryArrayInput(record.recurring_formats)}"></label>
        <label class="source-registry-span">Internal notes<textarea name="internal_notes" class="textarea-short" maxlength="2000">${esc(record.internal_notes || '')}</textarea></label>
      </div>
      <div class="source-registry-checks">
        <label class="check-line"><input name="active" type="checkbox" ${record.active !== false ? 'checked' : ''}> Registry record active</label>
        <label class="check-line"><input name="direct_publish_eligible" type="checkbox" ${record.direct_publish_eligible ? 'checked' : ''}> Eligible to support direct publication after verification</label>
        <label class="check-line"><input name="requires_primary_source_lookup" type="checkbox" ${record.requires_primary_source_lookup !== false ? 'checked' : ''}> Requires primary-source lookup</label>
        <label class="check-line"><input name="recurring_character" type="checkbox" ${record.recurring_character ? 'checked' : ''}> Recurring character</label>
      </div>
      <p class="field-note">Ingestion status: <span class="stamp">${INGESTION_STATUS.replace('_', ' ')}</span>. This editor never starts a poll or discovery job.</p>
      <div class="form-actions"><button type="submit">${editing ? 'Save source' : 'Add source'}</button>${editing ? '<button type="button" class="quiet" data-source-cancel>Cancel</button>' : ''}</div>
    </form>
  </section>`;
}

function sourceRegistryRowMarkup(source) {
  const locator = externalUrl(source.handle_or_url);
  const locatorMarkup = locator ? `<a href="${esc(locator)}" target="_blank" rel="noreferrer">${esc(source.handle_or_url)}</a>` : esc(source.handle_or_url || 'Locator unresolved');
  const tags = [...(source.topic_tags || []), ...(source.chain_tags || []), ...(source.project_tags || [])];
  const status = source.active ? 'active' : 'inactive';
  const ingestionStatus = source.ingestion_status || INGESTION_STATUS;
  const isXSource = source.source_type === 'x_account';
  const supportsIngestion = (isXSource ? source.review_status === 'ready' && /^@[A-Za-z0-9_]{1,15}$/.test(String(source.x_handle || '')) : ['rss', 'blog', 'official_announcements'].includes(source.source_type) && source.review_status === 'ready' && Boolean(locator));
  const validated = Boolean(source.ingestion_validated_at && source.ingestion_validation_url && source.ingestion_validation_url === locator);
  const actionButtons = supportsIngestion
    ? isXSource
      ? `${source.active ? '<button type="button" class="quiet compact-button" data-ingestion-action="test" data-source-id="' + esc(source.id) + '">Test browser ingestion</button>' : '<button type="button" class="quiet compact-button" data-ingestion-action="activate" data-source-id="' + esc(source.id) + '">Activate browser ingestion</button>'}${source.active || ['polling', 'healthy', 'degraded', 'failed'].includes(ingestionStatus) ? `<button type="button" class="quiet compact-button" data-ingestion-action="pause" data-source-id="${esc(source.id)}">Pause ingestion</button>` : ''}`
      : `<button type="button" class="quiet compact-button" data-ingestion-action="test" data-source-id="${esc(source.id)}">Test source</button>${validated ? `<button type="button" class="quiet compact-button" data-ingestion-action="activate" data-source-id="${esc(source.id)}">Activate ingestion</button>` : ''}${source.active || ['polling', 'healthy', 'degraded', 'failed'].includes(ingestionStatus) ? `<button type="button" class="quiet compact-button" data-ingestion-action="pause" data-source-id="${esc(source.id)}">Pause ingestion</button>` : ''}`
    : '';
  return `<article class="source-registry-card" data-source-id="${esc(source.id)}">
    <div class="source-registry-card-head"><div><div class="meta-line"><span class="stamp st-${status}">${status}</span><span class="stamp st-${esc(ingestionStatus)}">${esc(humanize(ingestionStatus))}</span><span class="stamp">${esc(source.review_status === 'ready' ? 'ready' : 'review needed')}</span><span>${esc(humanize(source.source_type))}</span><span>${esc(humanize(source.primary_class))}</span></div><h3>${esc(source.public_display_name || source.name)}</h3><p class="field-note">${isXSource ? esc(source.x_handle || 'Handle unresolved') : locatorMarkup} · ${esc(source.platform || 'unknown')} · priority ${esc(source.priority)} · ${esc(humanize(source.trust_level))}</p></div><div class="source-registry-actions"><button type="button" class="quiet compact-button" data-source-edit="${esc(source.id)}">Edit</button>${isXSource ? '' : `<button type="button" class="quiet compact-button" data-source-toggle="${esc(source.id)}">${source.active ? 'Deactivate' : 'Activate'}</button>`}${actionButtons}</div></div>
    <p>${esc(source.description || 'No description.')}</p>
    <p class="field-note">Sections: ${esc((source.primary_sections || []).join(', ') || 'None')} · Tags: ${esc(tags.join(', ') || 'None')}</p>
    <p class="field-note">${source.direct_publish_eligible ? 'May support direct publication after verification' : 'Research signal only'} · ${source.requires_primary_source_lookup ? 'Primary-source lookup required' : 'Primary-source lookup not required'} · ${source.recurring_character ? `Recurring character${source.internal_queue ? ` · ${esc(source.internal_queue)}` : ''}` : 'Not a recurring character'}</p>
    <p class="field-note">Last checked: ${source.last_checked_at ? esc(dDateTime(source.last_checked_at)) : 'Not checked'} · Last success: ${source.last_success_at ? esc(dDateTime(source.last_success_at)) : 'Not recorded'} · Next eligible: ${source.ingestion_next_eligible_at ? esc(dDateTime(source.ingestion_next_eligible_at)) : 'Not scheduled'} · Last inserted: ${esc(source.ingestion_last_inserted_count ?? 0)}${source.last_error ? ` · Last error: ${esc(source.last_error)}` : ''}${source.ingestion_blocker ? ` · Blocker: ${esc(source.ingestion_blocker)}` : ''}</p>
  </article>`;
}

async function editorialCandidates() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const [candidates, events, sources, relations, attempts, queue, lunaSettings, lunaJobs, enrichmentJobs, lunaDecisions, lunaArticles, lunaEnrichments, lunaEvidencePackets, mediaAssets] = await Promise.all([
    optionalData(sb.from('editorial_candidates').select('id,source_event_id,decision,confidence,newness,editorial_score,recommended_length,primary_section,topic_tags,audience_tags,primary_source,ready_now,concise_rationale,related_event_ids,scoring_attempt_id,updated_at').order('updated_at', { ascending: false }).limit(250), 'editorial candidates'),
    optionalData(sb.from('source_events').select('id,source_id,title,canonical_url,published_at,discovered_at,source_type').order('discovered_at', { ascending: false }).limit(500), 'scored source events'),
    optionalData(sb.from('source_registry').select('id,name,handle_or_url,public_display_name,editorial_title,legal_or_real_name'), 'candidate sources'),
    optionalData(sb.from('editorial_candidate_related_events').select('candidate_id,related_event_id,relation_type'), 'candidate relations'),
    optionalData(sb.from('editorial_scoring_attempts').select('id,source_event_id,status,model,prompt_version,attempt_number,validation_errors,created_at,completed_at').order('created_at', { ascending: false }).limit(500), 'scoring attempts'),
    optionalData(sb.from('editorial_scoring_queue').select('source_event_id,status,attempt_count,last_error,next_attempt_at'), 'scoring queue'),
    optionalData(sb.from('luna_editorial_settings').select('model,reasoning,minimum_score,enabled,recurring_max_candidates_per_run,recurring_max_calls_per_hour,recurring_processing_lease_minutes,recurring_retry_limit,recurring_interval_minutes,updated_at').eq('id', 'default').limit(1), 'Luna settings'),
    optionalData(sb.from('pipeline_jobs').select('id,job_type,parameters,status,error,result,created_at,started_at,finished_at').eq('job_type', 'luna_editorial_candidate').order('created_at', { ascending: false }).limit(500), 'Luna jobs'),
    optionalData(sb.from('pipeline_jobs').select('id,job_type,parameters,status,error,result,created_at,started_at,finished_at').eq('job_type', 'luna_evidence_enrichment').order('created_at', { ascending: false }).limit(500), 'Luna enrichment jobs'),
    optionalData(sb.from('luna_decision_attempts').select('id,editorial_candidate_id,status,outcome,decision,reject_reason,wait_reason,editorial_rationale,model,prompt_version,attempt_number,validation_errors,created_at,completed_at').order('created_at', { ascending: false }).limit(500), 'Luna decisions'),
    optionalData(sb.from('luna_article_attempts').select('id,editorial_candidate_id,status,outcome,story_id,article_length,word_count,validation_errors,created_at,completed_at').order('created_at', { ascending: false }).limit(500), 'Luna articles'),
    optionalData(sb.from('luna_evidence_enrichment_packets').select('id,editorial_candidate_id,status,outcome,evidence_quality,confidence,new_evidence_chars,new_concrete_facts,new_official_statements,fetched_urls,canonical_urls,failure_reasons,created_at,completed_at').order('created_at', { ascending: false }).limit(500), 'Luna enrichment packets'),
    optionalData(sb.from('luna_evidence_packets').select('id,editorial_candidate_id,version,packet,created_at').order('created_at', { ascending: false }).limit(500), 'Luna evidence packets'),
    optionalData(sb.from('media_assets').select('id,source_event_id,original_url,cached_url,attribution_text,rights_basis,usage_scope,status,cache_state,error,width,height,hero_score,alt_text,metadata').order('created_at', { ascending: false }).limit(500), 'candidate media assets')
  ]);
  const eventById = new Map(events.map(event => [event.id, event]));
  const mediaByEvent = new Map();
  mediaAssets.forEach(asset => { const list = mediaByEvent.get(asset.source_event_id) || []; list.push(asset); mediaByEvent.set(asset.source_event_id, list); });
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const attemptById = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const queueById = new Map(queue.map(row => [row.source_event_id, row]));
  const latestLunaByCandidate = (rows, rank = () => 0) => {
    const result = new Map();
    for (const row of rows) {
      const key = row.parameters?.candidate_id || row.editorial_candidate_id;
      if (!key) continue;
      const current = result.get(key);
      const score = rank(row);
      const currentScore = current ? rank(current) : -1;
      if (!current || score > currentScore || (score === currentScore && new Date(row.created_at || 0).getTime() > new Date(current.created_at || 0).getTime())) result.set(key, row);
    }
    return result;
  };
  const lunaJobByCandidate = latestLunaByCandidate(lunaJobs, job => ({ queued: 4, claimed: 4, running: 4, completed: 3, failed: 2, cancelled: 1 }[job.status] || 0));
  const enrichmentJobByCandidate = latestLunaByCandidate(enrichmentJobs, job => ({ queued: 4, claimed: 4, running: 4, completed: 3, failed: 2, cancelled: 1 }[job.status] || 0));
  const lunaDecisionByCandidate = latestLunaByCandidate(lunaDecisions, attempt => ({ processing: 4, succeeded: 3, needs_attention: 3, invalid: 2, failed: 1 }[attempt.status] || 0));
  const lunaEnrichmentByCandidate = latestLunaByCandidate(lunaEnrichments, attempt => ({ processing: 4, succeeded: 3, failed: 2 }[attempt.status] || 0));
  const lunaEvidenceByCandidate = latestLunaByCandidate(lunaEvidencePackets, packet => Number(packet.version || 0));
  const lunaArticleByCandidate = new Map();
  for (const attempt of lunaArticles) {
    const current = lunaArticleByCandidate.get(attempt.editorial_candidate_id);
    const shouldReplace = !current
      || (attempt.status === 'succeeded' && current.status !== 'succeeded')
      || (attempt.status === current.status && new Date(attempt.created_at || 0).getTime() > new Date(current.created_at || 0).getTime());
    if (shouldReplace) lunaArticleByCandidate.set(attempt.editorial_candidate_id, attempt);
  }
  const lunaSetting = lunaSettings[0] || { model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, enabled: false, recurring_max_candidates_per_run: 3, recurring_max_calls_per_hour: 6, recurring_processing_lease_minutes: 45, recurring_retry_limit: 1, recurring_interval_minutes: 15 };
  const relatedByCandidate = new Map();
  relations.forEach(relation => { const list = relatedByCandidate.get(relation.candidate_id) || []; list.push(relation); relatedByCandidate.set(relation.candidate_id, list); });
  const filter = new URLSearchParams(location.search).get('decision') || 'all';
  const visible = candidates.filter(candidate => filter === 'all' || candidate.decision === filter);
  const card = candidate => {
    const event = eventById.get(candidate.source_event_id) || {};
    const source = sourceById.get(event.source_id) || {};
    const attempt = attemptById.get(candidate.scoring_attempt_id) || {};
    const state = queueById.get(candidate.source_event_id) || {};
    const lunaJob = lunaJobByCandidate.get(candidate.id) || {};
    const enrichmentJob = enrichmentJobByCandidate.get(candidate.id) || {};
    const lunaDecision = lunaDecisionByCandidate.get(candidate.id) || {};
    const lunaArticle = lunaArticleByCandidate.get(candidate.id) || {};
    const enrichment = lunaEnrichmentByCandidate.get(candidate.id) || {};
    const evidencePacket = lunaEvidenceByCandidate.get(candidate.id) || {};
    const candidateMedia = mediaByEvent.get(candidate.source_event_id) || [];
    const related = (relatedByCandidate.get(candidate.id) || []).map(row => eventById.get(row.related_event_id)?.title || row.related_event_id).join(', ');
    const sourceUrl = externalUrl(candidate.primary_source);
    const eventTitle = event.canonical_url && externalUrl(event.canonical_url) ? '<a href="' + esc(externalUrl(event.canonical_url)) + '" target="_blank" rel="noreferrer">' + esc(event.title || 'Untitled event') + '</a>' : esc(event.title || 'Untitled event');
    const activeLunaJob = ['queued', 'claimed', 'running'].includes(lunaJob.status);
    const lunaJobIsNewer = activeLunaJob && Boolean(lunaJob.created_at) && (!lunaDecision.created_at || new Date(lunaJob.created_at).getTime() > new Date(lunaDecision.created_at).getTime());
    const decisionIsNewer = Boolean(lunaDecision.created_at) && (!lunaArticle.created_at || new Date(lunaDecision.created_at).getTime() >= new Date(lunaArticle.created_at).getTime());
    const terminalDecision = ['reject', 'wait'].includes(lunaDecision.outcome);
    const lunaState = lunaJobIsNewer ? 'processing' : terminalDecision ? lunaDecision.outcome : decisionIsNewer && lunaDecision.outcome ? lunaDecision.outcome : lunaArticle.status === 'needs_attention' ? 'needs_attention' : lunaArticle.outcome === 'written' ? 'written' : lunaDecision.outcome || (lunaJob.status === 'failed' ? 'failed' : activeLunaJob ? 'processing' : 'not sent');
    const activeEnrichmentJob = ['queued', 'claimed', 'running'].includes(enrichmentJob.status);
    const enrichmentSummary = enrichment.id ? `Enrichment ${esc(enrichment.outcome || enrichment.status)} · ${esc(enrichment.new_evidence_chars || 0)} new chars · ${esc(enrichment.new_concrete_facts || 0)} new dates/numbers · ${esc(enrichment.evidence_quality || 'unrated')}` : '';
    const enrichmentMarkup = enrichment.id ? `<details class="candidate-enrichment"><summary>Evidence enrichment</summary><p class="field-note">${enrichmentSummary}${enrichment.confidence !== null && enrichment.confidence !== undefined ? ` · confidence ${esc(Math.round(Number(enrichment.confidence) * 100))}%` : ''}</p><p class="field-note">Fetched URLs: ${esc((enrichment.fetched_urls || []).join(', ') || 'None')}${enrichment.canonical_urls?.length ? ` · Canonical: ${esc(enrichment.canonical_urls.join(', '))}` : ''}</p>${enrichment.failure_reasons?.length ? `<p class="field-note">Failures: ${esc(enrichment.failure_reasons.map(item => item.message || item.code || String(item)).join(' · '))}</p>` : ''}</details>` : '';
    const evidenceSources = Array.isArray(evidencePacket.packet?.sources) ? evidencePacket.packet.sources : [];
    const evidenceMarkup = evidencePacket.id ? `<details class="candidate-evidence"><summary>Evidence available · packet v${esc(evidencePacket.version)}</summary>${evidenceSources.slice(0, 12).map(sourceRecord => `<div class="evidence-record"><p class="field-note">${esc(sourceRecord.title || sourceRecord.source_name || sourceRecord.role || 'Evidence')} · ${esc(sourceRecord.source_url || 'No URL')}</p><p>${esc(String(sourceRecord.evidence_excerpt || '').slice(0, 900))}</p></div>`).join('') || '<p class="field-note">No retained evidence excerpts.</p>'}</details>` : '';
    const mediaMarkup = candidateMedia.length ? `<details class="candidate-media"><summary>Source media · ${candidateMedia.length}</summary>${candidateMedia.map(asset => `<p class="field-note">${asset.cached_url || asset.original_url ? sourceHref(asset.cached_url || asset.original_url, asset.attribution_text || 'Media asset') : esc(asset.attribution_text || 'Media asset')} · ${esc(asset.rights_basis)} · ${esc(asset.usage_scope)} · cache ${esc(asset.cache_state || 'pending')}${asset.width && asset.height ? ` · ${esc(asset.width)} × ${esc(asset.height)}` : ' · dimensions unknown'}${asset.hero_score !== null && asset.hero_score !== undefined ? ` · hero score ${esc(asset.hero_score)}` : ` · ${esc(asset.metadata?.hero_eligibility?.reason || 'not hero-eligible')}`}${asset.error ? ` · ${esc(asset.error)}` : ''}</p>`).join('')}</details>` : '';
    const lunaAction = lunaState === 'written' && lunaArticle.story_id
      ? '<a class="button quiet compact-button" href="/newsroom/' + esc(lunaArticle.story_id) + '">Open On Deck</a>'
      : ['processing'].includes(lunaState)
        ? '<span class="stamp st-running">Luna processing</span>'
        : lunaState === 'wait' && activeEnrichmentJob
          ? '<span class="stamp st-running">Evidence enrichment</span>'
          : lunaState === 'wait' && enrichment.outcome === 'improved' && !activeLunaJob
            ? '<button type="button" class="quiet compact-button" data-retry-luna="' + esc(candidate.id) + '">Retry Luna</button>'
            : lunaState === 'wait' && enrichment.status === 'succeeded'
              ? '<span class="field-note">No new evidence; Luna remains waiting</span>'
            : lunaState === 'wait'
              ? '<button type="button" class="compact-button" data-enrich-luna="' + esc(candidate.id) + '">Enrich Evidence</button>'
        : ['failed', 'needs_attention', 'reject', 'wait'].includes(lunaState)
          ? '<button type="button" class="quiet compact-button" data-retry-luna="' + esc(candidate.id) + '">Retry Luna</button>'
          : !lunaDecision.id && candidate.decision === 'candidate' && Number(candidate.editorial_score) >= Number(lunaSetting.minimum_score)
            ? '<button type="button" class="compact-button" data-send-luna="' + esc(candidate.id) + '">Send to Luna</button>'
            : '<span class="field-note">Below Luna threshold</span>';
    const lunaDetail = lunaState === 'reject' ? `Luna rejected: ${esc(lunaDecision.reject_reason || 'No reason recorded.')}` : lunaState === 'wait' ? `Luna is waiting: ${esc(lunaDecision.wait_reason || 'More verified evidence is needed.')}` : lunaState === 'written' ? `Written ${esc(lunaArticle.article_length || candidate.recommended_length || 'standard')} · ${esc(lunaArticle.word_count || '—')} words · On Deck` : lunaState === 'needs_attention' ? 'Luna output needs editorial attention; no On Deck story was created.' : lunaState === 'failed' ? `Luna failed${lunaJob.error?.message ? `: ${esc(lunaJob.error.message)}` : '.'}` : `Luna: ${esc(lunaState)}`;
    return `<article class="editorial-candidate-card"><div class="meta-line"><span class="stamp st-${esc(candidate.decision)}">${esc(candidate.decision)}</span><span class="stamp">Score ${esc(candidate.editorial_score)}</span><span>${esc(candidate.recommended_length)}</span><span>${candidate.ready_now ? 'Ready now' : 'Needs reporting'}</span></div><h2>${eventTitle}</h2><p class="field-note">${esc(source.name || 'Unknown source')} · ${esc(candidate.primary_section || 'Unclassified')} · confidence ${esc(Math.round(Number(candidate.confidence || 0) * 100))}% · ${event.published_at ? esc(dDateTime(event.published_at)) : 'No publish time'}</p><p>${esc(candidate.concise_rationale || 'No rationale recorded.')}</p><details class="candidate-supporting-details"><summary>Candidate details</summary><p class="field-note">Audience: ${esc((candidate.audience_tags || []).join(', ') || 'Not specified')} · Topics: ${esc((candidate.topic_tags || []).join(', ') || 'None')}</p><p class="field-note">Primary source: ${sourceUrl ? `<a class="text-link" href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">${esc(candidate.primary_source)}</a>` : 'Not recorded'}${related ? ` · Related: ${esc(related)}` : ''}</p><p class="field-note">Local model ${esc(attempt.model || 'unknown')} · ${esc(attempt.status || state.status || 'not scored')} · Luna model ${esc(lunaSetting.model)} · ${lunaDetail}</p>${evidenceMarkup}${enrichmentMarkup}${mediaMarkup}</details><div class="form-actions">${lunaAction}<button type="button" class="quiet compact-button" data-retry-editorial-event="${esc(candidate.source_event_id)}">Retry / rescore</button></div></article>`;
  };
  title('Editorial Candidates');
  const tabs = [['all', 'All'], ['candidate', 'Candidate'], ['wait', 'Wait'], ['reject', 'Reject']].map(([value, label]) => '<a href="/newsroom/editorial-candidates' + (value === 'all' ? '' : '?decision=' + value) + '" ' + (filter === value ? 'aria-current="page"' : '') + '>' + label + '<span>' + (value === 'all' ? candidates.length : candidates.filter(item => item.decision === value).length) + '</span></a>').join('');
  app.innerHTML = '<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Local review</span></div><h1>Editorial Candidates</h1><p class="standfirst">Local scoring prepares a bounded evidence packet for targeted Luna review. Recurring Luna processing is disabled, and nothing is published automatically.</p></div>' + deskNav(p, 'editorial-candidates') + '<section class="desk-section"><div class="section-head"><div><span class="label">Scoring queue</span><h2>' + candidates.length + ' reviewed event' + (candidates.length === 1 ? '' : 's') + '</h2></div><div class="form-actions"><a class="button quiet" href="/newsroom/settings#luna-editorial-settings">Luna settings</a><button type="button" data-run-editorial-scoring>Run local scoring batch</button></div></div><nav class="story-filters" aria-label="Candidate decisions">' + tabs + '</nav><p class="notice form-message" data-editorial-message hidden></p><div class="editorial-candidate-grid">' + (visible.map(card).join('') || '<p class="empty-note">No editorial candidates are available. Queue a controlled backfill in Settings, then run a batch while scoring is enabled.</p>') + '</div></section></div>';
  const message = document.querySelector('[data-editorial-message]');
  const candidateGrid = document.querySelector('.editorial-candidate-grid');
  const candidateCards = [...document.querySelectorAll('.editorial-candidate-card')];
  if (candidateGrid && candidateCards.length) {
    const candidateById = new Map(visible.map(candidate => [candidate.id, candidate]));
    candidateCards.forEach((card, index) => {
      const candidate = visible[index];
      if (!candidate) return;
      card.dataset.editorialCandidate = candidate.id;
      const selector = document.createElement('label');
      selector.className = 'editorial-candidate-select';
      selector.innerHTML = `<input type="checkbox" data-editorial-candidate-select="${esc(candidate.id)}" aria-label="Select ${esc(eventById.get(candidate.source_event_id)?.title || 'editorial candidate')}"> <span>Select</span>`;
      card.prepend(selector);
    });
    const toolbar = document.createElement('div');
    toolbar.className = 'candidate-bulk-toolbar';
    toolbar.innerHTML = '<label class="pitch-select-all"><input type="checkbox" data-editorial-candidate-select-all> Select all</label><span class="field-note" data-editorial-candidate-count>0 selected</span><button type="button" class="danger-quiet compact-button" data-delete-editorial-candidates disabled>Delete selected</button><p class="field-note">Deleting removes the candidate and its scoring/Luna records. Any article already written from it is preserved.</p>';
    candidateGrid.before(toolbar);
    bindCollectionPaging(candidateGrid, '.editorial-candidate-card', 'editorial-candidates-more');
    const selectAll = toolbar.querySelector('[data-editorial-candidate-select-all]');
    const count = toolbar.querySelector('[data-editorial-candidate-count]');
    const deleteButton = toolbar.querySelector('[data-delete-editorial-candidates]');
    const updateCandidateSelection = () => {
      const boxes = [...document.querySelectorAll('[data-editorial-candidate-select]')].filter(box => !box.closest('.editorial-candidate-card')?.hidden);
      const selected = boxes.filter(box => box.checked);
      count.textContent = `${selected.length} selected`;
      selectAll.checked = boxes.length > 0 && selected.length === boxes.length;
      selectAll.indeterminate = selected.length > 0 && selected.length < boxes.length;
      deleteButton.disabled = selected.length === 0;
    };
    candidateGrid.addEventListener('newsroom:page', updateCandidateSelection);
    document.querySelectorAll('[data-editorial-candidate-select]').forEach(box => box.addEventListener('change', updateCandidateSelection));
    selectAll.addEventListener('change', () => { document.querySelectorAll('[data-editorial-candidate-select]').forEach(box => { if (!box.closest('.editorial-candidate-card')?.hidden) box.checked = selectAll.checked; }); updateCandidateSelection(); });
    deleteButton.addEventListener('click', async () => {
      const ids = [...document.querySelectorAll('[data-editorial-candidate-select]:checked')].map(box => box.dataset.editorialCandidateSelect).filter(id => candidateById.has(id));
      if (!ids.length) return;
      const confirmation = window.prompt(`Type DELETE EDITORIAL CANDIDATES to remove ${ids.length} selected candidate${ids.length === 1 ? '' : 's'}.`);
      if (confirmation !== 'DELETE EDITORIAL CANDIDATES') return;
      deleteButton.disabled = true;
      const failures = [];
      for (let offset = 0; offset < ids.length; offset += 8) {
        const batch = ids.slice(offset, offset + 8);
        const results = await Promise.all(batch.map(id => sb.rpc('delete_editorial_candidate', { p_candidate_id: id, p_confirmation: confirmation, p_reason: 'bulk_editorial_candidate_cleanup' })));
        results.forEach((result, index) => { if (result.error) failures.push(result.error.message || batch[index]); });
      }
      if (failures.length) {
        deleteButton.disabled = false;
        message.hidden = false;
        message.textContent = `${ids.length - failures.length} deleted; ${failures.length} could not be removed. ${failures[0]}`;
        return;
      }
      location.reload();
    });
    updateCandidateSelection();
  }
  document.querySelector('[data-run-editorial-scoring]')?.addEventListener('click', async event => { event.currentTarget.disabled = true; event.currentTarget.textContent = 'Starting…'; try { await pipelineRequest('/api/newsroom/editorial-scoring/run', {}); location.reload(); } catch (error) { event.currentTarget.disabled = false; event.currentTarget.textContent = 'Run local scoring batch'; message.hidden = false; message.textContent = error.message || 'Scoring is paused or unavailable.'; } });
  document.querySelectorAll('[data-send-luna], [data-retry-luna], [data-enrich-luna]').forEach(button => button.addEventListener('click', async () => { button.disabled = true; const isRetry = button.hasAttribute('data-retry-luna'); const isEnrich = button.hasAttribute('data-enrich-luna'); button.textContent = isEnrich ? 'Enriching…' : isRetry ? 'Retrying…' : 'Sending…'; try { await pipelineRequest('/api/newsroom/luna-editorial/candidates/' + (button.dataset.sendLuna || button.dataset.retryLuna || button.dataset.enrichLuna) + '/' + (isEnrich ? 'enrich' : isRetry ? 'retry' : 'send'), {}); location.reload(); } catch (error) { button.disabled = false; button.textContent = isEnrich ? 'Enrich Evidence' : isRetry ? 'Retry Luna' : 'Send to Luna'; message.hidden = false; message.textContent = error.message || 'The Luna handoff could not be started.'; } }));
  document.querySelectorAll('[data-retry-editorial-event]').forEach(button => button.addEventListener('click', async () => { button.disabled = true; try { await pipelineRequest('/api/newsroom/editorial-scoring/events/' + button.dataset.retryEditorialEvent + '/retry', {}); location.reload(); } catch (error) { button.disabled = false; message.hidden = false; message.textContent = error.message || 'The event could not be queued again.'; } }));
  bindSignOut();
}

async function newsroomSettings() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const [healthJobs, healthArtifacts] = p.role === 'admin' ? await Promise.all([
    optionalData(sb.from('pipeline_jobs').select('status,result,error,parameters,created_at,started_at,finished_at').order('created_at', { ascending: false }).limit(500), 'pipeline health jobs'),
    optionalData(sb.from('pipeline_phase2_artifacts').select('payload,updated_at').order('updated_at', { ascending: false }).limit(500), 'pipeline health stages')
  ]) : [[], []];
  const health = p.role === 'admin' ? aggregatePipelineHealth({ jobs: healthJobs, attempts: healthArtifacts.flatMap(row => row.payload?.phase2_attempts || []) }) : null;
  const healthWindow = summary => `<div class="pipeline-status-grid"><div><span class="label">Jobs</span><p class="meta-line">${summary.total_jobs}</p><p class="field-note">${summary.succeeded} succeeded · ${summary.failed} failed</p></div><div><span class="label">Research outcomes</span><p class="meta-line">${(summary.success_rate * 100).toFixed(0)}% success</p><p class="field-note">${(summary.empty_result_rate * 100).toFixed(0)}% empty · ${(summary.provider_error_rate * 100).toFixed(0)}% provider error</p></div><div><span class="label">Stage timing</span><p class="meta-line">${summary.median_stage_duration_ms === null ? '—' : `${Math.round(summary.median_stage_duration_ms)} ms`}</p><p class="field-note">${summary.queued_or_running} queued or running</p></div></div>`;
  const failureTable = summary => `<div class="table-scroll"><table class="desk-table"><thead><tr><th>Stage</th><th>Failures</th></tr></thead><tbody>${Object.entries(summary.failures_by_stage).map(([stage, count]) => `<tr><td>${esc(humanize(stage))}</td><td>${count}</td></tr>`).join('') || '<tr><td colspan="2" class="empty-row">No failures recorded.</td></tr>'}</tbody></table></div>`;
  const countTable = (titleText, counts) => `<div><h3>${titleText} · 7 days</h3><div class="table-scroll"><table class="desk-table"><thead><tr><th>Name</th><th>Success</th><th>Error</th></tr></thead><tbody>${Object.entries(counts).map(([name, value]) => `<tr><td>${esc(humanize(name))}</td><td>${value.success || 0}</td><td>${value.error || 0}</td></tr>`).join('') || '<tr><td colspan="3" class="empty-row">No execution records.</td></tr>'}</tbody></table></div></div>`;
  const healthMarkup = health ? `<section class="desk-section" id="pipeline-health"><div class="section-head"><div><span class="label">Admin operations</span><h2>Pipeline health</h2></div><p class="field-note">Derived from retained queue and execution records. Empty research results are not counted as provider failures.</p></div><h3>Last 24 hours</h3>${healthWindow(health.last_24_hours)}<h3>Last 7 days</h3>${healthWindow(health.last_7_days)}<div class="health-columns"><div><h3>Failures by stage · 7 days</h3>${failureTable(health.last_7_days)}</div><div><h3>Failures by category · 7 days</h3><div class="table-scroll"><table class="desk-table"><thead><tr><th>Category</th><th>Failures</th></tr></thead><tbody>${Object.entries(health.last_7_days.failures_by_category).map(([category, count]) => `<tr><td>${esc(humanize(category))}</td><td>${count}</td></tr>`).join('') || '<tr><td colspan="2" class="empty-row">No failures recorded.</td></tr>'}</tbody></table></div></div>${countTable('Provider outcomes', health.last_7_days.provider_counts)}${countTable('Writer outcomes', health.last_7_days.writer_counts)}</div></section>` : '';
  const sourceRows = await optionalData(sb.from('source_registry').select('id,name,handle_or_url,platform,source_type,primary_class,description,active,priority,trust_level,direct_publish_eligible,requires_primary_source_lookup,primary_sections,topic_tags,chain_tags,project_tags,poll_interval_seconds,last_checked_at,last_success_at,last_error,public_display_name,editorial_title,legal_or_real_name,x_handle,reveal_identity_policy,recurring_character,public_bio,internal_notes,recurring_formats,internal_queue,review_status,identity_key,created_at,updated_at').order('priority', { ascending: false }).order('name'), 'source registry');
  const xBrowserSettingsRows = await optionalData(sb.from('x_browser_ingestion_settings').select('enabled,max_accounts_per_run,max_posts_per_account,page_concurrency,reply_min_chars,min_visit_gap_seconds,max_visit_gap_seconds,max_visits_per_hour,long_break_every_visits,long_break_min_seconds,long_break_max_seconds,next_eligible_visit_at,visits_since_long_break,active_source_id,last_success_source_id,backoff_level,manual_review_required,status,authenticated,session_path_display,browser_version,polling_state,last_run_at,last_success_at,last_success_post_at,last_error,backoff_until,updated_at').eq('id', 'default').limit(1), 'X browser ingestion settings');
  const ingestionRows = await optionalData(sb.from('source_registry').select('id,ingestion_status,ingestion_next_eligible_at,ingestion_failure_count,ingestion_validated_at,ingestion_validation_url,ingestion_blocker,ingestion_last_inserted_count,ingestion_last_duplicate_count,ingestion_last_fetcher').order('priority', { ascending: false }), 'source ingestion state');
  const runRows = await optionalData(sb.from('source_ingestion_runs').select('id,source_id,started_at,completed_at,status,fetched_count,inserted_count,duplicate_count,error_count,error_summary,response_metadata').order('started_at', { ascending: false }).limit(120), 'source ingestion runs');
  const eventRows = await optionalData(sb.from('source_events').select('id,source_id,source_type,external_id,canonical_url,title,raw_text,summary,author_name,published_at,discovered_at,fetched_at,raw_payload,content_hash,media,source_metadata,ingestion_run_id,status,error,created_at,updated_at').order('published_at', { ascending: false, nullsFirst: false }).limit(200), 'source events');
  const mediaAssetRows = await optionalData(sb.from('media_assets').select('id,source_event_id,original_url,cached_url,source_page_url,media_type,width,height,file_size,mime_type,creator_or_account,attribution_text,rights_basis,usage_scope,alt_text,cached_at,status,error,hero_score,metadata,cache_state,cache_attempt_count,cache_last_attempt_at').order('created_at', { ascending: false }).limit(500), 'media assets');
  const mediaDerivativeRows = await optionalData(sb.from('media_asset_derivatives').select('id,asset_id,derivative_kind,status,error,width,height').order('created_at', { ascending: false }).limit(1000), 'media derivatives');
  const derivativesByAsset = new Map();
  mediaDerivativeRows.forEach(row => { const list = derivativesByAsset.get(row.asset_id) || []; list.push(row); derivativesByAsset.set(row.asset_id, list); });
  const scoringSettingRows = await optionalData(sb.from('editorial_scoring_settings').select('model,prompt_version,fallback_model,fallback_prompt_version,batch_size,minimum_score,enabled,updated_at').eq('id', 'default').limit(1), 'editorial scoring settings');
  const lunaSettingRows = await optionalData(sb.from('luna_editorial_settings').select('model,reasoning,minimum_score,enabled,recurring_max_candidates_per_run,recurring_max_calls_per_hour,recurring_processing_lease_minutes,recurring_retry_limit,recurring_interval_minutes,enrichment_enabled,enrichment_max_attempts,enrichment_max_urls_per_attempt,enrichment_max_bytes_per_page,enrichment_timeout_ms,enrichment_cooldown_minutes,updated_at').eq('id', 'default').limit(1), 'Luna editorial settings');
  const [automationRows, automationQueue, automationCandidates, automationDecisions, automationArticles, automationStories, automationJobs] = await Promise.all([
    optionalData(sb.from('editorial_automation_settings').select('enabled,scoring_enabled,enrichment_enabled,luna_enabled,max_scoring_events_per_hour,max_scoring_batch_size,max_candidates_per_run,max_luna_calls_per_hour,max_enrichment_attempts,max_enrichment_urls_per_attempt,processing_lease_minutes,retry_limit,last_run_at,last_success_at,last_error,updated_at').eq('id', 'default').limit(1), 'editorial automation settings'),
    optionalData(sb.from('editorial_scoring_queue').select('status'), 'automation scoring queue'),
    optionalData(sb.from('editorial_candidates').select('decision'), 'automation candidates'),
    optionalData(sb.from('luna_decision_attempts').select('status,outcome'), 'automation Luna decisions'),
    optionalData(sb.from('luna_article_attempts').select('status,story_id'), 'automation Luna articles'),
    optionalData(sb.from('stories').select('id').eq('origin', 'automated').gte('created_at', new Date(Date.now() - 86400000).toISOString()), 'automated On Deck stories today'),
    optionalData(sb.from('pipeline_jobs').select('status,error,finished_at,created_at').in('job_type', ['score_editorial_events', 'luna_evidence_enrichment', 'luna_editorial_candidate']).order('created_at', { ascending: false }).limit(50), 'automation job health')
  ]);
  const scoringSetting = scoringSettingRows[0] || { model: 'qwen3:8b', prompt_version: 'discipline_direct_v1', fallback_model: 'qwen3:30b', fallback_prompt_version: 'discipline_direct_v1', batch_size: 3, minimum_score: 4, enabled: false };
  const lunaSetting = lunaSettingRows[0] || { model: 'gpt-5.6-luna', reasoning: 'high', minimum_score: 4, enabled: false, recurring_max_candidates_per_run: 3, recurring_max_calls_per_hour: 6, recurring_processing_lease_minutes: 45, recurring_retry_limit: 1, recurring_interval_minutes: 15, enrichment_enabled: false, enrichment_max_attempts: 1, enrichment_max_urls_per_attempt: 3, enrichment_max_bytes_per_page: 524288, enrichment_timeout_ms: 8000, enrichment_cooldown_minutes: 60 };
  const automation = automationRows[0] || { enabled: false, scoring_enabled: false, enrichment_enabled: false, luna_enabled: false, max_scoring_events_per_hour: 20, max_scoring_batch_size: 5, max_candidates_per_run: 2, max_luna_calls_per_hour: 2, max_enrichment_attempts: 1, max_enrichment_urls_per_attempt: 3, processing_lease_minutes: 45, retry_limit: 1, last_run_at: null, last_success_at: null, last_error: null };
  const xBrowser = xBrowserSettingsRows[0] || { enabled: false, max_accounts_per_run: 1, max_posts_per_account: 20, page_concurrency: 1, reply_min_chars: 140, min_visit_gap_seconds: 90, max_visit_gap_seconds: 360, max_visits_per_hour: 8, long_break_every_visits: 4, long_break_min_seconds: 480, long_break_max_seconds: 1200, next_eligible_visit_at: null, visits_since_long_break: 0, active_source_id: null, last_success_source_id: null, backoff_level: 0, manual_review_required: false, status: 'paused', authenticated: false, session_path_display: null, browser_version: null, polling_state: 'paused', last_run_at: null, last_success_at: null, last_success_post_at: null, last_error: null, backoff_until: null };
  const automationStatus = value => value ? 'running' : 'paused';
  const queueWaiting = automationQueue.filter(row => ['unscored', 'queued', 'processing'].includes(row.status)).length;
  const candidatesWaiting = automationCandidates.filter(row => row.decision === 'candidate').length;
  const waitStates = automationDecisions.filter(row => row.outcome === 'wait').length;
  const needsAttention = automationArticles.filter(row => row.status === 'needs_attention').length;
  const onDeckToday = automationStories.length;
  const sourceIngestionRunning = ingestionRows.some(row => ['polling', 'healthy', 'degraded'].includes(row.ingestion_status));
  const latestAutomationError = automation.last_error || automationJobs.find(job => job.status === 'failed')?.error?.message || '';
  const automationMarkup = `<section class="desk-section" id="editorial-automation"><div class="section-head"><div><span class="label">Editorial automation</span><h2>Low-volume loop</h2></div><button type="button" class="quiet" id="editorial-automation-pause">${automation.enabled ? 'Pause Editorial Automation' : 'Resume Editorial Automation'}</button></div><p class="field-note">Source ingestion and scheduled publishing remain independent. Automated stories are unpublished and land in On Deck for review.</p><div class="pipeline-status-grid"><div><span class="label">Source ingestion</span><p class="meta-line">${automationStatus(sourceIngestionRunning)}</p></div><div><span class="label">Local scoring</span><p class="meta-line">${automationStatus(automation.enabled && automation.scoring_enabled)}</p></div><div><span class="label">Evidence enrichment</span><p class="meta-line">${automationStatus(automation.enabled && automation.enrichment_enabled)}</p></div><div><span class="label">Luna</span><p class="meta-line">${automationStatus(automation.enabled && automation.luna_enabled)}</p></div><div><span class="label">Events waiting</span><p class="meta-line">${queueWaiting}</p></div><div><span class="label">Candidates waiting</span><p class="meta-line">${candidatesWaiting}</p></div><div><span class="label">Wait states</span><p class="meta-line">${waitStates}</p></div><div><span class="label">Needs attention</span><p class="meta-line">${needsAttention}</p></div><div><span class="label">On Deck today</span><p class="meta-line">${onDeckToday}</p></div><div><span class="label">Last successful run</span><p class="meta-line">${automation.last_success_at ? esc(dDateTime(automation.last_success_at)) : '—'}</p></div><div><span class="label">Last error</span><p class="meta-line">${esc(latestAutomationError || 'None')}</p></div></div><form id="editorial-automation-form" class="settings-grid"><label class="checkbox-field"><input name="scoring_enabled" type="checkbox" ${automation.scoring_enabled ? 'checked' : ''}> Recurring local scoring</label><label class="checkbox-field"><input name="enrichment_enabled" type="checkbox" ${automation.enrichment_enabled ? 'checked' : ''}> Automatic evidence enrichment</label><label class="checkbox-field"><input name="luna_enabled" type="checkbox" ${automation.luna_enabled ? 'checked' : ''}> Recurring Luna</label><label>Max new events/hour<input name="max_scoring_events_per_hour" type="number" min="1" max="20" value="${esc(automation.max_scoring_events_per_hour)}" required></label><label>Scoring batch size<input name="max_scoring_batch_size" type="number" min="1" max="5" value="${esc(automation.max_scoring_batch_size)}" required></label><label>Max candidates/run<input name="max_candidates_per_run" type="number" min="1" max="2" value="${esc(automation.max_candidates_per_run)}" required></label><label>Max Luna calls/hour<input name="max_luna_calls_per_hour" type="number" min="1" max="2" value="${esc(automation.max_luna_calls_per_hour)}" required></label><label>Max URLs/enrichment<input name="max_enrichment_urls_per_attempt" type="number" min="1" max="3" value="${esc(automation.max_enrichment_urls_per_attempt)}" required></label><label>Processing lease (minutes)<input name="processing_lease_minutes" type="number" min="5" max="180" value="${esc(automation.processing_lease_minutes)}" required></label><label>Retry limit<input name="retry_limit" type="number" min="0" max="1" value="${esc(automation.retry_limit)}" required></label><div class="form-actions"><button type="submit">Save automation settings</button></div></form><p class="notice form-message" id="editorial-automation-message" data-form-message hidden></p></section>`;
  const xSourceIds = new Set(sourceRows.filter(row => row.source_type === 'x_account').map(row => row.id));
  const xRuns = runRows.filter(run => xSourceIds.has(run.source_id));
  const xHourAgo = Date.now() - 60 * 60 * 1000;
  const xDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const xVisitsLastHour = xRuns.filter(run => Date.parse(run.started_at || '') >= xHourAgo).length;
  const xVisitsLastDay = xRuns.filter(run => Date.parse(run.started_at || '') >= xDayAgo).length;
  const xActiveSource = sourceRows.find(row => row.id === xBrowser.active_source_id);
  const xLastSuccessSource = sourceRows.find(row => row.id === xBrowser.last_success_source_id);
  const xBrowserMarkup = `<section class="desk-section" id="x-browser-ingestion"><div class="section-head"><div><span class="label">X browser ingestion</span><h2>Dedicated local session</h2></div><span class="stamp st-${esc(xBrowser.status)}">${esc(humanize(xBrowser.status))}</span></div><p class="field-note">Controller-local Playwright only. The persistent profile is dedicated to Anyways; cookies and credentials never enter Supabase or logs. One account and one reusable browser context are visited at a time. Stop on sign-in prompts, blocks, or DOM changes.</p><div class="pipeline-status-grid"><div><span class="label">Polling</span><p class="meta-line">${xBrowser.enabled ? 'enabled' : 'paused'}</p></div><div><span class="label">Session</span><p class="meta-line">${xBrowser.authenticated ? 'authenticated' : 'not authenticated'}</p><p class="field-note">${esc(xBrowser.session_path_display || 'Dedicated profile not initialized')}</p></div><div><span class="label">Browser</span><p class="meta-line">${esc(xBrowser.browser_version || 'Not checked')}</p></div><div><span class="label">Visits last hour</span><p class="meta-line">${xVisitsLastHour} / ${esc(xBrowser.max_visits_per_hour)}</p></div><div><span class="label">Average visits/hour · 24h</span><p class="meta-line">${(xVisitsLastDay / 24).toFixed(1)}</p></div><div><span class="label">Active account</span><p class="meta-line">${esc(xActiveSource?.name || 'None')}</p></div><div><span class="label">Last successful source</span><p class="meta-line">${esc(xLastSuccessSource?.name || 'None')}</p></div><div><span class="label">Next eligible visit</span><p class="meta-line">${xBrowser.next_eligible_visit_at ? esc(dDateTime(xBrowser.next_eligible_visit_at)) : 'Now / not set'}</p></div><div><span class="label">Cooldown / backoff</span><p class="meta-line">${xBrowser.manual_review_required ? 'Manual review required' : xBrowser.backoff_until ? esc(dDateTime(xBrowser.backoff_until)) : `${esc(xBrowser.visits_since_long_break)} / ${esc(xBrowser.long_break_every_visits)} before long break`}</p></div><div><span class="label">Last success</span><p class="meta-line">${xBrowser.last_success_at ? esc(dDateTime(xBrowser.last_success_at)) : '—'}</p></div><div><span class="label">Last post</span><p class="meta-line">${xBrowser.last_success_post_at ? esc(dDateTime(xBrowser.last_success_post_at)) : '—'}</p></div><div><span class="label">Last error</span><p class="meta-line">${esc(xBrowser.last_error || 'None')}</p></div></div><form id="x-browser-form" class="settings-grid"><label class="checkbox-field"><input name="enabled" type="checkbox" ${xBrowser.enabled ? 'checked' : ''}> Enable X browser polling</label><label>Accounts/run<input name="max_accounts_per_run" type="number" min="1" max="1" value="1" required></label><label>Posts/account<input name="max_posts_per_account" type="number" min="1" max="50" value="${esc(xBrowser.max_posts_per_account)}" required></label><label>Page concurrency<input name="page_concurrency" type="number" min="1" max="1" value="1" required></label><label>Reply minimum characters<input name="reply_min_chars" type="number" min="60" max="1000" value="${esc(xBrowser.reply_min_chars)}" required></label><label>Minimum visit gap (seconds)<input name="min_visit_gap_seconds" type="number" min="90" max="1800" value="${esc(xBrowser.min_visit_gap_seconds)}" required></label><label>Maximum visit gap (seconds)<input name="max_visit_gap_seconds" type="number" min="90" max="3600" value="${esc(xBrowser.max_visit_gap_seconds)}" required></label><label>Max visits/hour<input name="max_visits_per_hour" type="number" min="1" max="12" value="${esc(xBrowser.max_visits_per_hour)}" required></label><label>Long break every visits<input name="long_break_every_visits" type="number" min="3" max="5" value="${esc(xBrowser.long_break_every_visits)}" required></label><label>Long break minimum (seconds)<input name="long_break_min_seconds" type="number" min="480" max="3600" value="${esc(xBrowser.long_break_min_seconds)}" required></label><label>Long break maximum (seconds)<input name="long_break_max_seconds" type="number" min="480" max="7200" value="${esc(xBrowser.long_break_max_seconds)}" required></label><div class="form-actions"><button type="submit">Save X browser settings</button><button type="button" class="quiet" id="x-browser-pause">${xBrowser.enabled ? 'Pause X ingestion' : 'Keep X ingestion paused'}</button></div></form><p class="notice form-message" id="x-browser-message" data-form-message hidden></p></section>`;
  let rows = sourceRows.map(source => ({ ...source, ...(ingestionRows.find(item => item.id === source.id) || {}) }));
  const sourceNames = new Map(rows.map(source => [source.id, source.name]));
  const mediaByEvent = new Map();
  mediaAssetRows.forEach(asset => { const list = mediaByEvent.get(asset.source_event_id) || []; list.push(asset); mediaByEvent.set(asset.source_event_id, list); });
  const eventSection = event => (event.source_metadata?.primary_sections || []).join(', ');
  const eventMarkup = event => { const assets = mediaByEvent.get(event.id) || []; const assetMarkup = assets.length ? `<div class="media-asset-grid">${assets.map(asset => { const preview = externalUrl(asset.cached_url || asset.original_url); const derivatives = derivativesByAsset.get(asset.id) || []; const canRetryCache = asset.cache_state === 'failed' || asset.status === 'cache_failed'; return `<article class="media-asset-card">${preview && asset.media_type === 'image' ? `<img src="${esc(preview)}" alt="${esc(asset.alt_text || '')}" loading="lazy">` : ''}<p class="field-note">${esc(asset.attribution_text || 'Attribution pending')} · ${esc(asset.rights_basis)} · ${esc(asset.usage_scope)}${asset.width && asset.height ? ` · ${esc(asset.width)} × ${esc(asset.height)}` : ' · dimensions unknown'}</p><p class="field-note">Cache: <strong>${esc(asset.cache_state || 'pending')}</strong>${asset.error ? ` · ${esc(asset.error)}` : ''}${asset.cache_attempt_count ? ` · ${esc(asset.cache_attempt_count)} attempt${asset.cache_attempt_count === 1 ? '' : 's'}` : ''}</p><p class="field-note">Hero: ${asset.metadata?.hero_eligibility?.eligible ? `eligible · score ${esc(asset.hero_score)}` : esc(asset.metadata?.hero_eligibility?.reason || 'Not evaluated')} · Derivatives: ${derivatives.length ? esc([...new Set(derivatives.map(row => row.status))].join(', ')) : 'not planned'}</p>${canRetryCache ? `<button type="button" class="quiet compact-button" data-media-cache-retry="${esc(asset.id)}">Retry cache</button>` : ''}<form class="media-asset-override" data-media-asset-id="${esc(asset.id)}"><select name="rights_basis"><option value="${esc(asset.rights_basis)}" selected>${esc(humanize(asset.rights_basis))}</option><option value="official_source_media">Official source media</option><option value="official_press_asset">Official press asset</option><option value="editorial_evidence">Editorial evidence</option><option value="platform_embed">Platform embed</option><option value="unknown">Unknown</option></select><select name="usage_scope"><option value="${esc(asset.usage_scope)}" selected>${esc(humanize(asset.usage_scope))}</option><option value="hero_candidate">Hero candidate</option><option value="inline_candidate">Inline candidate</option><option value="evidence_only">Evidence only</option><option value="embed_only">Embed only</option><option value="blocked">Blocked</option></select><button type="submit" class="quiet compact-button">Save media decision</button></form></article>`; }).join('')}</div>` : '';
    const prepareButton = Array.isArray(event.media) && event.media.length && !assets.length ? `<button type="button" class="quiet compact-button" data-media-backfill="${esc(event.id)}">Prepare media records</button>` : '';
    return `<article class="source-registry-card source-event-card"><div class="source-registry-card-head"><div><div class="meta-line"><span class="stamp st-${esc(event.status || 'ingested')}">${esc(humanize(event.status || 'ingested'))}</span><span>${esc(sourceNames.get(event.source_id) || 'Unknown source')}</span><span>${esc(event.source_type || '')}</span></div><h3>${event.canonical_url && externalUrl(event.canonical_url) ? `<a href="${esc(externalUrl(event.canonical_url))}" target="_blank" rel="noreferrer">${esc(event.title || 'Untitled event')}</a>` : esc(event.title || 'Untitled event')}</h3><p class="field-note">Published: ${event.published_at ? esc(dDateTime(event.published_at)) : 'Not dated'} · Discovered: ${event.discovered_at ? esc(dDateTime(event.discovered_at)) : 'Not recorded'} · ${esc(event.author_name || 'Author not recorded')}</p></div><span class="field-note">${esc(event.content_hash || '')}</span></div><p>${esc(event.summary || event.raw_text || 'No summary retained.')}</p><p class="field-note">Duplicate handling: ${event.ingestion_run_id ? 'checked during leased ingestion run' : 'not recorded'} · Media: ${Array.isArray(event.media) ? event.media.length : 0} reference${Array.isArray(event.media) && event.media.length === 1 ? '' : 's'}${event.error ? ` · Error: ${esc(event.error)}` : ''}</p>${assetMarkup}${prepareButton}<details><summary>Raw event details</summary><pre class="packet-data">${esc(JSON.stringify({ raw_payload: event.raw_payload, source_metadata: event.source_metadata, media: event.media }, null, 2))}</pre></details></article>`;
  };
  title('Settings');
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Settings</span></div><h1>Settings</h1><p class="standfirst">Account, workflow defaults, and operational health. Source Ingestion V1 is bounded, reviewed, and separate from scheduled publishing.</p></div>${deskNav(p, 'settings')}<section class="desk-section settings-grid"><div><span class="label">Account</span><h2>${esc(p.name || 'Newsroom member')}</h2><p class="field-note">${esc(humanize(p.role || ''))}</p></div><div><span class="label">Operations</span><h2>Durable newsroom queue</h2><p class="field-note">The browser reads Supabase queue activity. The local controller claims jobs and writes results back to the same records.</p><p class="form-actions"><a class="button quiet" href="/newsroom/analytics">Reader analytics</a><a class="button quiet" href="/newsroom/pipeline">Technical queue</a></p></div></section>${xBrowserMarkup}<section class="desk-section" id="source-monitoring"><div class="section-head"><div><span class="label">Source monitoring</span><h2>Source Graph</h2></div><p class="field-note"><span class="stamp">Bounded V1 ingestion</span> · Reviewed RSS, Atom, JSON Feed, official pages, and verified X handles can be activated independently. X browser polling remains paused unless enabled above.</p></div><form id="source-registry-filters" class="queue-filters"><label>Search<input name="q" type="search" placeholder="name, handle, tag"></label><label>Platform<select name="platform"><option value="">All platforms</option>${sourceRegistryOptionList(PLATFORM_OPTIONS, '')}</select></label><label>Class<select name="primary_class"><option value="">All classes</option>${sourceRegistryOptionList(SOURCE_CLASSES, '')}</select></label><label>Trust<select name="trust_level"><option value="">All trust levels</option>${sourceRegistryOptionList(TRUST_LEVELS, '')}</select></label><label>Ingestion<select name="ingestion_status"><option value="">All states</option>${sourceRegistryOptionList(INGESTION_STATUSES, '')}</select></label><label>Section<input name="section" placeholder="Markets"></label><label>Status<select name="active"><option value="">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label><button type="submit" class="quiet">Filter</button><button type="button" class="quiet" id="source-registry-reset">Reset</button></form><div class="source-registry-toolbar"><div><button type="button" id="source-registry-add">Add source</button><button type="button" class="quiet" id="source-registry-export-json">Export JSON</button><button type="button" class="quiet" id="source-registry-export-csv">Export CSV</button></div><form id="source-registry-import" class="source-registry-import"><label>Import JSON or CSV<input name="file" type="file" accept=".json,.csv,application/json,text/csv" required></label><button type="submit" class="quiet">Validate and import</button></form></div><p class="notice form-message" id="source-registry-message" data-form-message hidden></p><div id="source-registry-list" class="source-registry-list" aria-live="polite"></div></section><div id="source-registry-editor-slot">${sourceRegistryEditorMarkup()}</div><section class="desk-section" id="source-ingestion-runs"><div class="section-head"><div><span class="label">Source monitoring</span><h2>Recent ingestion runs</h2></div><p class="field-note">Leased runs are retained for operational review. Duplicate counts do not create or overwrite events.</p></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Source</th><th>Status</th><th>Started</th><th>Fetched</th><th>Inserted</th><th>Duplicates</th><th>Error</th></tr></thead><tbody>${runRows.map(run => `<tr><td>${esc(sourceNames.get(run.source_id) || 'Unknown source')}</td><td><span class="stamp st-${esc(run.status)}">${esc(humanize(run.status))}</span></td><td>${esc(run.started_at ? dDateTime(run.started_at) : '—')}</td><td>${esc(run.fetched_count ?? 0)}</td><td>${esc(run.inserted_count ?? 0)}</td><td>${esc(run.duplicate_count ?? 0)}</td><td>${esc(run.error_summary || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="empty-row">No ingestion runs recorded.</td></tr>'}</tbody></table></div></section><section class="desk-section" id="source-events"><div class="section-head"><div><span class="label">Source monitoring</span><h2>Source Events</h2></div><p class="field-note">Read-only normalized events. Raw payloads remain available for later evidence extraction and are escaped before display.</p></div><form id="source-event-filters" class="queue-filters"><label>Source<select name="source_id"><option value="">All sources</option>${rows.map(source => `<option value="${esc(source.id)}">${esc(source.name)}</option>`).join('')}</select></label><label>Status<select name="status"><option value="">All statuses</option><option value="ingested">Ingested</option><option value="failed">Failed</option><option value="duplicate">Duplicate</option></select></label><label>Section<input name="section" placeholder="Markets"></label><label>After date<input name="after" type="date"></label><button type="submit" class="quiet">Filter</button><button type="button" class="quiet" id="source-event-reset">Reset</button></form><div id="source-event-list" class="source-registry-list" aria-live="polite"></div></section><section class="desk-section settings-grid"><div><span class="label">Models</span><h2>Luna writing path</h2><p class="field-note">Wired through the existing controller and provider adapter for idea pitches and article work.</p></div><div><span class="label">Editorial scoring</span><h2>Structured review fields</h2><p class="field-note">Confidence, newness, score, ready-now, primary source, and concise rationale are retained on idea pitches when provided.</p></div><div><span class="label">Publishing</span><h2>Existing publish controls</h2><p class="field-note">Publishing remains on the story editor and On Deck. Unpublish is intentionally not exposed here.</p></div><div><span class="label">Media and attribution</span><h2>Existing rights workflow</h2><p class="field-note">Hero media, source URLs, credits, and rights checks remain in the story editor.</p></div></section>${healthMarkup}</div>`;

  const scoringMarkup = '<section class="desk-section" id="editorial-scoring-settings"><div class="section-head"><div><span class="label">Local editorial scoring</span><h2>Review new source events</h2></div><p class="field-note">Structured local triage only. It does not call Luna, generate articles, score stories, or publish. The fallback model is retained for an editor-directed recovery run.</p></div><form id="editorial-scoring-form" class="settings-grid"><label>Local model<input name="model" value="' + esc(scoringSetting.model) + '" maxlength="160" required></label><label>Local prompt version<select name="prompt_version"><option value="discipline_direct_v1" ' + (scoringSetting.prompt_version === 'discipline_direct_v1' ? 'selected' : '') + '>discipline_direct_v1</option><option value="local-editorial-v4" ' + (scoringSetting.prompt_version === 'local-editorial-v4' ? 'selected' : '') + '>local-editorial-v4 (legacy)</option></select></label><label>Fallback model<input name="fallback_model" value="' + esc(scoringSetting.fallback_model || 'qwen3:30b') + '" maxlength="160" required></label><label>Fallback prompt version<select name="fallback_prompt_version"><option value="discipline_direct_v1" ' + (scoringSetting.fallback_prompt_version === 'discipline_direct_v1' ? 'selected' : '') + '>discipline_direct_v1</option><option value="local-editorial-v4" ' + (scoringSetting.fallback_prompt_version === 'local-editorial-v4' ? 'selected' : '') + '>local-editorial-v4 (legacy)</option></select></label><label>Batch size<input name="batch_size" type="number" min="1" max="5" value="' + esc(scoringSetting.batch_size) + '" required></label><label>Minimum score sent forward<input name="minimum_score" type="number" min="0" max="10" step="0.1" value="' + esc(scoringSetting.minimum_score) + '" required></label><label class="checkbox-field"><input name="enabled" type="checkbox" ' + (scoringSetting.enabled ? 'checked' : '') + '> Enable local scoring</label><div class="form-actions"><button type="submit">Save scoring settings</button><a class="button quiet" href="/newsroom/editorial-candidates">Open candidates</a></div></form><p class="notice form-message" id="editorial-scoring-message" data-form-message hidden></p><form id="editorial-scoring-backfill" class="queue-filters"><label>Recent days<input name="days" type="number" min="1" max="90" value="7"></label><label>Queue limit<input name="limit" type="number" min="1" max="100" value="25"></label><button type="submit" class="quiet">Queue controlled backfill</button></form><p class="field-note">Backfill only queues existing events. It never scores automatically and is capped at 100 events per action.</p></section>';
  document.querySelector('.desk-nav')?.insertAdjacentHTML('afterend', automationMarkup);
  document.querySelector('.desk-nav')?.insertAdjacentHTML('afterend', scoringMarkup);
  const automationForm = document.querySelector('#editorial-automation-form');
  const automationMessage = document.querySelector('#editorial-automation-message');
  const automationPayload = enabled => {
    const values = Object.fromEntries(new FormData(automationForm));
    return {
      enabled,
      scoring_enabled: automationForm.elements.scoring_enabled.checked,
      enrichment_enabled: automationForm.elements.enrichment_enabled.checked,
      luna_enabled: automationForm.elements.luna_enabled.checked,
      max_scoring_events_per_hour: Number(values.max_scoring_events_per_hour),
      max_scoring_batch_size: Number(values.max_scoring_batch_size),
      max_candidates_per_run: Number(values.max_candidates_per_run),
      max_luna_calls_per_hour: Number(values.max_luna_calls_per_hour),
      max_enrichment_attempts: 1,
      max_enrichment_urls_per_attempt: Number(values.max_enrichment_urls_per_attempt),
      processing_lease_minutes: Number(values.processing_lease_minutes),
      retry_limit: Number(values.retry_limit)
    };
  };
  automationForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = automationForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await pipelineRequest('/api/newsroom/editorial-automation/settings', automationPayload(automation.enabled));
      automationMessage.textContent = 'Automation settings saved.';
      automationMessage.className = 'notice form-message ok';
      automationMessage.hidden = false;
    } catch (error) {
      automationMessage.textContent = error.message || 'Automation settings could not be saved.';
      automationMessage.className = 'notice form-message';
      automationMessage.hidden = false;
    } finally { button.disabled = false; }
  });
  document.querySelector('#editorial-automation-pause')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await pipelineRequest('/api/newsroom/editorial-automation/settings', automationPayload(!automation.enabled)); location.reload(); }
    catch (error) { event.currentTarget.disabled = false; automationMessage.textContent = error.message || 'Automation state could not be changed.'; automationMessage.className = 'notice form-message'; automationMessage.hidden = false; }
  });
  const xBrowserForm = document.querySelector('#x-browser-form');
  const xBrowserMessage = document.querySelector('#x-browser-message');
  const xBrowserPayload = enabled => {
    const values = Object.fromEntries(new FormData(xBrowserForm));
    return { enabled, max_accounts_per_run: 1, max_posts_per_account: Number(values.max_posts_per_account), page_concurrency: 1, reply_min_chars: Number(values.reply_min_chars), min_visit_gap_seconds: Number(values.min_visit_gap_seconds), max_visit_gap_seconds: Number(values.max_visit_gap_seconds), max_visits_per_hour: Number(values.max_visits_per_hour), long_break_every_visits: Number(values.long_break_every_visits), long_break_min_seconds: Number(values.long_break_min_seconds), long_break_max_seconds: Number(values.long_break_max_seconds) };
  };
  xBrowserForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = xBrowserForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try { await pipelineRequest('/api/newsroom/x-browser/settings', xBrowserPayload(xBrowserForm.elements.enabled.checked)); xBrowserMessage.textContent = 'X browser settings saved. The controller will use the dedicated local profile only when enabled.'; xBrowserMessage.className = 'notice form-message ok'; xBrowserMessage.hidden = false; }
    catch (error) { xBrowserMessage.textContent = error.message || 'X browser settings could not be saved.'; xBrowserMessage.className = 'notice form-message'; xBrowserMessage.hidden = false; }
    finally { button.disabled = false; }
  });
  document.querySelector('#x-browser-pause')?.addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await pipelineRequest('/api/newsroom/x-browser/settings', xBrowserPayload(false)); location.reload(); }
    catch (error) { event.currentTarget.disabled = false; xBrowserMessage.textContent = error.message || 'X browser ingestion could not be paused.'; xBrowserMessage.className = 'notice form-message'; xBrowserMessage.hidden = false; }
  });
  const lunaMarkup = `<section class="desk-section" id="luna-editorial-settings"><div class="section-head"><div><span class="label">Luna editorial decision + writing</span><h2>Targeted handoff</h2></div><p class="field-note">The model receives a bounded evidence packet. Send to Luna is manual and targeted; recurring processing stays off until separately enabled.</p></div><form id="luna-editorial-form" class="settings-grid"><label>Luna model<input name="model" value="${esc(lunaSetting.model)}" maxlength="160" required></label><label>Reasoning<select name="reasoning"><option value="low" ${lunaSetting.reasoning === 'low' ? 'selected' : ''}>Low</option><option value="medium" ${lunaSetting.reasoning === 'medium' ? 'selected' : ''}>Medium</option><option value="high" ${lunaSetting.reasoning === 'high' ? 'selected' : ''}>High</option></select></label><label>Minimum local score / eligibility threshold<input name="minimum_score" type="number" min="0" max="10" step="0.1" value="${esc(lunaSetting.minimum_score)}" required></label><label>Max candidates per run<input name="max_candidates_per_run" type="number" min="1" max="25" value="${esc(lunaSetting.recurring_max_candidates_per_run)}" required></label><label>Max Luna calls per hour<input name="max_calls_per_hour" type="number" min="1" max="60" value="${esc(lunaSetting.recurring_max_calls_per_hour)}" required></label><label>Processing lease (minutes)<input name="processing_lease_minutes" type="number" min="5" max="180" value="${esc(lunaSetting.recurring_processing_lease_minutes)}" required></label><label>Retry limit<input name="retry_limit" type="number" min="0" max="3" value="${esc(lunaSetting.recurring_retry_limit)}" required></label><label>Run interval (minutes)<input name="interval_minutes" type="number" min="5" max="60" value="${esc(lunaSetting.recurring_interval_minutes)}" required></label><label class="checkbox-field"><input name="enabled" type="checkbox" ${lunaSetting.enabled ? 'checked' : ''}> Enable recurring Luna processing</label><label>Max enrichment attempts<input name="enrichment_max_attempts" type="number" min="1" max="3" value="${esc(lunaSetting.enrichment_max_attempts)}" required></label><label>Max URLs per enrichment attempt<input name="enrichment_max_urls_per_attempt" type="number" min="1" max="5" value="${esc(lunaSetting.enrichment_max_urls_per_attempt)}" required></label><label>Max bytes per page<input name="enrichment_max_bytes_per_page" type="number" min="65536" max="524288" value="${esc(lunaSetting.enrichment_max_bytes_per_page)}" required></label><label>Enrichment timeout (ms)<input name="enrichment_timeout_ms" type="number" min="1000" max="30000" value="${esc(lunaSetting.enrichment_timeout_ms)}" required></label><label>Enrichment cooldown (minutes)<input name="enrichment_cooldown_minutes" type="number" min="5" max="1440" value="${esc(lunaSetting.enrichment_cooldown_minutes)}" required></label><label class="checkbox-field"><input name="enrichment_enabled" type="checkbox" ${lunaSetting.enrichment_enabled ? 'checked' : ''}> Enable automatic evidence enrichment (future)</label><div class="form-actions"><button type="submit">Save Luna settings</button><a class="button quiet" href="/newsroom/editorial-candidates">Open candidates</a></div></form><p class="notice form-message" id="luna-editorial-message" data-form-message hidden></p><p class="field-note">Written articles enter On Deck as automated, unpublished fact-check work. Rejects, waits, and needs-attention outcomes remain visible on the candidate record. Manual Enrich Evidence remains targeted even while automatic enrichment is disabled.</p></section>`;
  document.querySelector('.desk-nav')?.insertAdjacentHTML('afterend', lunaMarkup);
  const settingsNav = document.createElement('nav');
  settingsNav.className = 'settings-index';
  settingsNav.setAttribute('aria-label', 'Settings sections');
  settingsNav.innerHTML = [
    ['Overview', 'settings-overview'],
    ['Automation', 'editorial-automation'],
    ['X browser', 'x-browser-ingestion'],
    ['Source Graph', 'source-monitoring'],
    ['Ingestion Runs', 'source-ingestion-runs'],
    ['Source Events', 'source-events'],
    ['Models', 'model-settings'],
    ['Health', 'pipeline-health']
  ].filter(([, id]) => id !== 'pipeline-health' || document.querySelector('#pipeline-health'))
    .map(([label, id]) => '<a href="#' + id + '">' + label + '</a>').join('');
  document.querySelector('.desk-nav')?.insertAdjacentElement('afterend', settingsNav);

  const overviewSection = [...document.querySelectorAll('.desk > section.settings-grid')].find(section => !section.id);
  overviewSection?.insertAdjacentHTML('beforeend', '<div class="settings-overview-status"><span class="label">Current workload</span><p class="meta-line">' + esc(queueWaiting) + ' events waiting · ' + esc(candidatesWaiting) + ' candidates waiting · ' + esc(needsAttention) + ' need attention</p><p class="field-note">Source ingestion is ' + esc(automationStatus(sourceIngestionRunning).toLowerCase()) + '. Editorial automation is ' + esc(automation.enabled ? 'running' : 'paused') + '.</p></div>');
  settingsPanel(overviewSection, { id: 'settings-overview', title: 'Overview', status: humanize(p.role || ''), open: true });
  settingsPanel(document.querySelector('#editorial-automation'), {
    id: 'editorial-automation',
    title: 'Automation',
    status: automation.enabled ? 'Running' : 'Paused'
  });
  settingsPanel(document.querySelector('#x-browser-ingestion'), {
    id: 'x-browser-ingestion',
    title: 'X browser',
    status: xBrowser.enabled ? 'Enabled' : 'Paused'
  });
  settingsPanel(document.querySelector('#source-monitoring'), {
    id: 'source-monitoring',
    title: 'Source Graph',
    status: rows.length + ' sources'
  });
  settingsPanel(document.querySelector('#source-ingestion-runs'), {
    id: 'source-ingestion-runs',
    title: 'Ingestion Runs',
    status: runRows.length + ' retained'
  });
  settingsPanel(document.querySelector('#source-events'), {
    id: 'source-events',
    title: 'Source Events',
    status: eventRows.length + ' retained'
  });
  const modelPanel = document.createElement('details');
  modelPanel.className = 'settings-panel';
  modelPanel.id = 'model-settings';
  modelPanel.innerHTML = '<summary><span>Models</span><small>Luna and local scoring</small></summary><div class="settings-panel-models"></div>';
  const lunaSection = document.querySelector('#luna-editorial-settings');
  const scoringSection = document.querySelector('#editorial-scoring-settings');
  if (lunaSection || scoringSection) {
    (lunaSection || scoringSection).before(modelPanel);
    if (lunaSection) modelPanel.querySelector('.settings-panel-models').append(lunaSection);
    if (scoringSection) modelPanel.querySelector('.settings-panel-models').append(scoringSection);
  }
  const healthPanel = settingsPanel(document.querySelector('#pipeline-health'), {
    id: 'pipeline-health',
    title: 'Health',
    status: '24 hours and 7 days'
  });
  healthPanel?.querySelectorAll('.table-scroll').forEach((tableWrap, index) => {
    const disclosure = document.createElement('details');
    disclosure.className = 'settings-raw-details';
    const nearbyHeading = tableWrap.previousElementSibling?.matches('h3')
      ? tableWrap.previousElementSibling.textContent.trim()
      : tableWrap.closest('.health-columns > div')?.querySelector(':scope > h3')?.textContent.trim();
    disclosure.innerHTML = '<summary>' + esc(nearbyHeading || 'Operational table ' + (index + 1)) + '</summary>';
    tableWrap.before(disclosure);
    disclosure.append(tableWrap);
  });

  const openSettingsHash = () => {
    if (!location.hash) return;
    const target = document.querySelector(location.hash);
    const panel = target?.matches('details.settings-panel') ? target : target?.closest('details.settings-panel');
    if (!panel) return;
    panel.open = true;
    window.requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  };
  settingsNav.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    const panel = document.querySelector(link.getAttribute('href'));
    if (panel?.matches('details.settings-panel')) panel.open = true;
  });
  window.addEventListener('hashchange', openSettingsHash, { once: true });
  openSettingsHash();
  const runBody = document.querySelector('#source-ingestion-runs tbody');
  const runControls = document.createElement('div');
  runControls.className = 'newsroom-paging';
  runBody?.closest('.table-scroll')?.insertAdjacentElement('afterend', runControls);
  let runVisibleCount = NEWSROOM_PAGE_SIZE;
  const runMarkup = run => '<tr>'
    + '<td data-label="Source">' + esc(sourceNames.get(run.source_id) || 'Unknown source') + '</td>'
    + '<td data-label="Status"><span class="stamp st-' + esc(run.status) + '">' + esc(humanize(run.status)) + '</span></td>'
    + '<td data-label="Started">' + esc(run.started_at ? dDateTime(run.started_at) : '—') + '</td>'
    + '<td data-label="Fetched">' + esc(run.fetched_count ?? 0) + '</td>'
    + '<td data-label="Inserted">' + esc(run.inserted_count ?? 0) + '</td>'
    + '<td data-label="Duplicates">' + esc(run.duplicate_count ?? 0) + '</td>'
    + '<td data-label="Error">' + esc(run.error_summary || '—') + '</td>'
    + '</tr>';
  const renderRuns = () => {
    if (!runBody) return;
    const shown = Math.min(runVisibleCount, runRows.length);
    runBody.innerHTML = runRows.slice(0, shown).map(runMarkup).join('')
      || '<tr><td colspan="7" class="empty-row">No ingestion runs recorded.</td></tr>';
    runControls.innerHTML = pagingControls('source-runs-more', shown, runRows.length);
    runControls.querySelector('#source-runs-more')?.addEventListener('click', () => {
      runVisibleCount += NEWSROOM_PAGE_SIZE;
      renderRuns();
    });
  };
  renderRuns();
  const lunaForm = document.querySelector('#luna-editorial-form');
  lunaForm?.addEventListener('submit', async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(lunaForm)); const message = document.querySelector('#luna-editorial-message'); const button = lunaForm.querySelector('button[type="submit"]'); button.disabled = true; try { await pipelineRequest('/api/newsroom/luna-editorial/settings', { model: String(values.model || '').trim(), reasoning: values.reasoning, minimum_score: Number(values.minimum_score), max_candidates_per_run: Number(values.max_candidates_per_run), max_calls_per_hour: Number(values.max_calls_per_hour), processing_lease_minutes: Number(values.processing_lease_minutes), retry_limit: Number(values.retry_limit), interval_minutes: Number(values.interval_minutes), enabled: values.enabled === 'on', enrichment_enabled: values.enrichment_enabled === 'on', enrichment_max_attempts: Number(values.enrichment_max_attempts), enrichment_max_urls_per_attempt: Number(values.enrichment_max_urls_per_attempt), enrichment_max_bytes_per_page: Number(values.enrichment_max_bytes_per_page), enrichment_timeout_ms: Number(values.enrichment_timeout_ms), enrichment_cooldown_minutes: Number(values.enrichment_cooldown_minutes) }); message.textContent = 'Luna settings saved. Recurring processing remains off unless you explicitly enable it.'; message.className = 'notice form-message ok'; message.hidden = false; } catch (error) { message.textContent = error.message || 'Luna settings could not be saved.'; message.className = 'notice form-message'; message.hidden = false; } finally { button.disabled = false; } });
  const list = document.querySelector('#source-registry-list');
  const sourceControls = document.createElement('div');
  sourceControls.className = 'newsroom-paging';
  list?.insertAdjacentElement('afterend', sourceControls);
  const filterForm = document.querySelector('#source-registry-filters');
  const message = document.querySelector('#source-registry-message');
  let sourceVisibleCount = NEWSROOM_PAGE_SIZE;
  const showMessage = (text, kind = 'error') => { message.textContent = text; message.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`; message.setAttribute('role', kind === 'ok' ? 'status' : 'alert'); message.hidden = !text; };
  const renderRows = () => {
    const values = Object.fromEntries(new FormData(filterForm));
    const query = String(values.q || '').toLowerCase().trim();
    const section = String(values.section || '').toLowerCase().trim();
    const filtered = rows.filter(source => {
      const haystack = [source.name, source.handle_or_url, source.public_display_name, source.editorial_title, source.description, ...(source.primary_sections || []), ...(source.topic_tags || []), ...(source.chain_tags || []), ...(source.project_tags || [])].join(' ').toLowerCase();
      return (!query || haystack.includes(query)) && (!values.platform || source.platform === values.platform) && (!values.primary_class || source.primary_class === values.primary_class) && (!values.trust_level || source.trust_level === values.trust_level) && (!values.ingestion_status || (source.ingestion_status || INGESTION_STATUS) === values.ingestion_status) && (!section || (source.primary_sections || []).some(item => item.toLowerCase().includes(section))) && (!values.active || (values.active === 'active' ? source.active : !source.active));
    });
    const shown = Math.min(sourceVisibleCount, filtered.length);
    list.innerHTML = filtered.slice(0, shown).map(sourceRegistryRowMarkup).join('') || '<p class="empty-note">No source records match these filters.</p>';
    sourceControls.innerHTML = pagingControls('source-registry-more', shown, filtered.length);
    sourceControls.querySelector('#source-registry-more')?.addEventListener('click', () => {
      sourceVisibleCount += NEWSROOM_PAGE_SIZE;
      renderRows();
    });
    list.querySelectorAll('[data-source-edit]').forEach(button => button.addEventListener('click', () => {
      const source = rows.find(item => item.id === button.dataset.sourceEdit);
      if (!source) return;
      document.querySelector('#source-registry-editor-slot').innerHTML = sourceRegistryEditorMarkup(source);
      bindEditor();
      document.querySelector('#source-registry-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    list.querySelectorAll('[data-source-toggle]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      const source = rows.find(item => item.id === button.dataset.sourceToggle);
      const { data, error } = await sb.from('source_registry').update({ active: !source.active }).eq('id', source.id).select().single();
      if (error) { button.disabled = false; return showMessage(error.message); }
      rows = rows.map(item => item.id === source.id ? data : item);
      showMessage(`${data.name} is now ${data.active ? 'active in the registry' : 'inactive'}. Ingestion remains ${INGESTION_STATUS.replace('_', ' ')}.`, 'ok');
      renderRows();
    }));
    list.querySelectorAll('[data-ingestion-action]').forEach(button => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const result = await pipelineRequest(`/api/newsroom/source-ingestion/${button.dataset.ingestionAction}/${button.dataset.sourceId}`, {});
        if (result.source) rows = rows.map(item => item.id === result.source.id ? { ...item, ...result.source } : item);
        showMessage(button.dataset.ingestionAction === 'test'
          ? (result.job ? 'X browser test queued for the controller.' : `Source validated. ${result.item_count ?? 0} item${result.item_count === 1 ? '' : 's'} found.`)
          : `Ingestion ${button.dataset.ingestionAction}d.`, 'ok');
        renderRows();
      } catch (error) { button.disabled = false; showMessage(error.message || 'The ingestion action could not be completed.'); }
    }));
  };
  const bindEditor = () => {
    const form = document.querySelector('#source-registry-form');
    if (!form) return;
    form.querySelector('[data-source-cancel]')?.addEventListener('click', () => {
      document.querySelector('#source-registry-editor-slot').innerHTML = sourceRegistryEditorMarkup();
      bindEditor();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      showFormMessage(form, '');
      try {
        const payload = sourceRegistryPayload(Object.fromEntries(new FormData(form)), form.dataset.editId);
        setBusy(form, true, form.dataset.editId ? 'Saving…' : 'Adding…');
        const request = form.dataset.editId
          ? sb.from('source_registry').update(payload).eq('id', form.dataset.editId).select().single()
          : sb.from('source_registry').insert(payload).select().single();
        const { data, error } = await request;
        if (error) throw error;
        rows = form.dataset.editId ? rows.map(item => item.id === data.id ? data : item) : [data, ...rows];
        showMessage(`${data.name} saved. Ingestion remains ${INGESTION_STATUS.replace('_', ' ')}.`, 'ok');
        document.querySelector('#source-registry-editor-slot').innerHTML = sourceRegistryEditorMarkup();
        bindEditor();
        renderRows();
      } catch (error) {
        setBusy(form, false);
        showFormMessage(form, error.message || 'The source could not be saved.');
      }
    });
  };
  const eventList = document.querySelector('#source-event-list');
  const eventControls = document.createElement('div');
  eventControls.className = 'newsroom-paging';
  eventList?.insertAdjacentElement('afterend', eventControls);
  const eventFilterForm = document.querySelector('#source-event-filters');
  let eventVisibleCount = NEWSROOM_PAGE_SIZE;
  const renderEvents = () => {
    if (!eventList || !eventFilterForm) return;
    const values = Object.fromEntries(new FormData(eventFilterForm));
    const sectionQuery = String(values.section || '').toLowerCase().trim();
    const after = values.after ? new Date(`${values.after}T00:00:00Z`).getTime() : 0;
    const filteredEvents = eventRows.filter(event => (!values.source_id || event.source_id === values.source_id)
      && (!values.status || event.status === values.status)
      && (!sectionQuery || eventSection(event).toLowerCase().includes(sectionQuery))
      && (!after || new Date(event.published_at || event.discovered_at || 0).getTime() >= after));
    const shown = Math.min(eventVisibleCount, filteredEvents.length);
    eventList.innerHTML = filteredEvents.slice(0, shown).map(eventMarkup).join('') || '<p class="empty-note">No source events match these filters.</p>';
    eventControls.innerHTML = pagingControls('source-events-more', shown, filteredEvents.length);
    eventControls.querySelector('#source-events-more')?.addEventListener('click', () => {
      eventVisibleCount += NEWSROOM_PAGE_SIZE;
      renderEvents();
    });
  };
  filterForm.addEventListener('submit', event => { event.preventDefault(); sourceVisibleCount = NEWSROOM_PAGE_SIZE; renderRows(); });
  document.querySelector('#source-registry-reset').addEventListener('click', () => { filterForm.reset(); sourceVisibleCount = NEWSROOM_PAGE_SIZE; renderRows(); });
  eventFilterForm?.addEventListener('submit', event => { event.preventDefault(); eventVisibleCount = NEWSROOM_PAGE_SIZE; renderEvents(); });
  document.querySelector('#source-event-reset')?.addEventListener('click', () => { eventFilterForm.reset(); eventVisibleCount = NEWSROOM_PAGE_SIZE; renderEvents(); });
  eventList?.addEventListener('click', async event => { const retry = event.target.closest('[data-media-cache-retry]'); if (retry) { retry.disabled = true; retry.textContent = 'Retrying…'; try { await pipelineRequest('/api/newsroom/media-assets/' + retry.dataset.mediaCacheRetry + '/retry-cache', {}); location.reload(); } catch (error) { retry.disabled = false; retry.textContent = 'Retry cache'; window.alert(error.message || 'Media cache retry failed.'); } return; } const button = event.target.closest('[data-media-backfill]'); if (!button) return; button.disabled = true; button.textContent = 'Preparing…'; try { await pipelineRequest('/api/newsroom/media-assets/backfill', { source_event_ids: [button.dataset.mediaBackfill], limit: 1 }); location.reload(); } catch (error) { button.disabled = false; button.textContent = 'Prepare media records'; window.alert(error.message || 'Media records could not be prepared.'); } });
  eventList?.addEventListener('submit', async event => { const form = event.target.closest('[data-media-asset-id]'); if (!form) return; event.preventDefault(); const values = Object.fromEntries(new FormData(form)); const button = form.querySelector('button'); button.disabled = true; try { await pipelineRequest(`/api/newsroom/media-assets/${form.dataset.mediaAssetId}/override`, { rights_basis: values.rights_basis, usage_scope: values.usage_scope, attribution_text: '', alt_text: '', note: 'Newsroom media decision.' }); location.reload(); } catch (error) { button.disabled = false; window.alert(error.message || 'Media decision could not be saved.'); } });
  document.querySelector('#source-registry-add').addEventListener('click', () => { document.querySelector('#source-registry-editor-slot').innerHTML = sourceRegistryEditorMarkup(); bindEditor(); document.querySelector('#source-registry-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  document.querySelector('#source-registry-export-json').addEventListener('click', () => downloadFile('anyways-source-registry.json', JSON.stringify(rows, null, 2), 'application/json'));
  document.querySelector('#source-registry-export-csv').addEventListener('click', () => downloadFile('anyways-source-registry.csv', exportSourceRegistryCSV(rows), 'text/csv'));
  document.querySelector('#source-registry-import').addEventListener('submit', async event => {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('file');
    if (!(file instanceof File)) return showMessage('Choose a JSON or CSV export first.');
    try {
      const imported = parseSourceRegistryImport(await file.text());
      const duplicates = duplicateSourceKeys([...rows, ...imported]).filter(item => item.duplicateIndex >= rows.length);
      if (duplicates.length) throw new Error(`Import skipped: duplicate source identities already exist or repeat in the file (${duplicates.map(item => item.key).join(', ')}).`);
      const { data, error } = await sb.from('source_registry').insert(imported).select();
      if (error) throw error;
      rows = [...data, ...rows];
      event.currentTarget.reset();
      showMessage(`${data.length} source record${data.length === 1 ? '' : 's'} imported. All imported records remain ${INGESTION_STATUS.replace('_', ' ')}.`, 'ok');
      renderRows();
    } catch (error) { showMessage(error.message || 'The source registry import could not be completed.'); }
  });
  const scoringForm = document.querySelector('#editorial-scoring-form');
  const scoringMessage = document.querySelector('#editorial-scoring-message');
  scoringForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      setBusy(event.currentTarget, true, 'Saving…');
      await pipelineRequest('/api/newsroom/editorial-scoring/settings', { model: String(values.model || '').trim(), prompt_version: String(values.prompt_version || 'discipline_direct_v1'), fallback_model: String(values.fallback_model || 'qwen3:30b').trim(), fallback_prompt_version: String(values.fallback_prompt_version || 'discipline_direct_v1'), batch_size: Number(values.batch_size), minimum_score: Number(values.minimum_score), enabled: event.currentTarget.elements.enabled.checked });
      setBusy(event.currentTarget, false);
      scoringMessage.textContent = 'Scoring settings saved. No events were queued or processed.';
      scoringMessage.className = 'notice form-message ok'; scoringMessage.hidden = false;
    } catch (error) { setBusy(event.currentTarget, false); scoringMessage.textContent = error.message || 'Scoring settings could not be saved.'; scoringMessage.className = 'notice form-message'; scoringMessage.hidden = false; }
  });
  document.querySelector('#editorial-scoring-backfill')?.addEventListener('submit', async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      setBusy(event.currentTarget, true, 'Queueing…');
      const result = await pipelineRequest('/api/newsroom/editorial-scoring/backfill', { days: Number(values.days), limit: Number(values.limit) });
      setBusy(event.currentTarget, false);
      scoringMessage.textContent = (result.queued || 0) + ' existing event' + (result.queued === 1 ? '' : 's') + ' queued. Scoring remains under manual control.';
      scoringMessage.className = 'notice form-message ok'; scoringMessage.hidden = false;
    } catch (error) { setBusy(event.currentTarget, false); scoringMessage.textContent = error.message || 'Backfill could not be queued.'; scoringMessage.className = 'notice form-message'; scoringMessage.hidden = false; }
  });
  bindEditor();
  renderRows();
  renderEvents();
  bindSignOut();
}

function downloadFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function optionalData(request, context) { try { return await dataOf(request, context) || []; } catch (error) { console.warn(`Optional ${context} unavailable`, error); return []; } }
function within(ms, work, message) {
  let timer;
  return Promise.race([
    work,
    new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error(message)), ms); })
  ]).finally(() => window.clearTimeout(timer));
}
async function pipelineRequest(path, payload) {
  const { data } = await within(8000, sb.auth.getSession(), 'Your Newsroom session did not respond. Reload this page and sign in again before commissioning reporting.');
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in to the Newsroom before using pipeline controls.');
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The Newsroom did not receive the reporting request within 15 seconds. Reload the page and try once more.');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || 'The pipeline request could not be completed.');
  return result;
}
async function commissionPitch(candidateId, button, message, researchRequirement = null, researchRequirementReason = null) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Starting reporting…';
  if (message) {
    message.textContent = 'Submitting the reporting job…';
    message.className = 'notice form-message';
    message.hidden = false;
  }
  try {
    const externalId = String(candidateId || '').trim();
    if (!externalId) throw new Error('This pitch is missing its retained ID. Reload the review page and try again.');
    const result = await pipelineRequest('/api/newsroom/pipeline/jobs', { job_type: 'process_candidate', candidate_id: externalId, pipeline_version: 'v1', ...(researchRequirement ? { research_requirement: researchRequirement } : {}), ...(researchRequirementReason ? { research_requirement_reason: researchRequirementReason } : {}) });
    if (!result?.job?.id) throw new Error('The reporting job was accepted without a job ID. Please reload the review queue.');
    if (message) {
      message.textContent = result.duplicate ? 'Reporting is already in progress. Opening its job…' : 'Reporting commissioned. Opening its job…';
      message.className = 'notice form-message ok';
    }
    window.setTimeout(() => { location.href = jobHref(result.job); }, 120);
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    if (message) {
      message.textContent = error.message || 'The reporting job could not be started.';
      message.className = 'notice form-message';
      message.hidden = false;
    } else {
      window.alert(error.message || 'The reporting job could not be started.');
    }
  }
}
function pipelineDuration(job) { const start = job.started_at || job.claimed_at || job.created_at, end = job.finished_at || (ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) ? new Date().toISOString() : null); if (!start || !end) return '—'; const seconds = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function jobTarget(job) {
  const focusId = job.parameters?.focus_id;
  const focus = focusId ? discoveryFocus(focusId) : null;
  if (focus) return `${focus.label} coverage`;
  return job.parameters?.brief || job.parameters?.candidate_id || job.parameters?.run_id || 'All enabled sources';
}
function jobResult(job) { if (job.error) return concisePipelineError(job.error); if (job.result?.result?.status) return humanize(job.result.result.status); if (job.result?.health) return 'Healthy'; return job.status === 'completed' ? 'Completed' : '—'; }
function jobHref(job) { return `/newsroom/pipeline/jobs/${job.id}`; }
function statusOptions(values, selected) { return `<option value="">All</option>${values.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(humanize(value))}</option>`).join('')}`; }
function safeLog(value) { return String(value || '').replace(/(?:SUPABASE_SERVICE_ROLE_KEY|authorization|bearer)\s*[=:]\s*[^\s]+/ig, match => `${match.split(/([=:])/)[0]}=[redacted]`).slice(-12000); }
function requirePipelineEditor(p) { return p && ['admin', 'editor'].includes(p.role); }

async function pipelineControls() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  if (!requirePipelineEditor(p)) { title('Pipeline access'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline</span></div><h1>Editor access required</h1><p class="standfirst">Pipeline controls are available to editors and administrators.</p></div>${deskNav(p, 'pipeline')}</div>`; bindSignOut(); return; }
  const [jobs, candidates, sources, links] = await Promise.all([
    optionalData(sb.from('pipeline_jobs').select('id,job_type,parameters,source,requested_by,priority,priority_rank,queue_position,status,attempt_count,max_attempts,lease_owner,lease_expires_at,cancellation_requested_at,created_at,claimed_at,started_at,finished_at,result,error,summary_log,profiles(name)').order('created_at', { ascending: false }).limit(80), 'pipeline jobs'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,canonical_url,classification,created_at,updated_at').order('updated_at', { ascending: false }).limit(60), 'pipeline candidates'),
    optionalData(sb.from('source_registry').select('id,name,source_type,handle_or_url,primary_sections,chain_tags,topic_tags,ingestion_status,last_checked_at,last_success_at,priority').eq('active', true).eq('review_status', 'ready').in('source_type', ['rss', 'blog', 'official_announcements']).in('ingestion_status', ['ready', 'healthy', 'degraded', 'failed']).order('priority', { ascending: false }).order('name'), 'Web3 discovery sources'),
    optionalData(sb.from('pipeline_story_links').select('candidate_id,story_id'), 'pipeline story links')
  ]);
  const params = new URLSearchParams(location.search); const statusFilter = params.get('status') || '', typeFilter = params.get('type') || '', sourceFilter = params.get('source') || '';
  const visible = jobs.filter(job => (!statusFilter || job.status === statusFilter) && (!typeFilter || job.job_type === typeFilter) && (!sourceFilter || job.source === sourceFilter));
  const counts = Object.fromEntries(PIPELINE_JOB_STATUSES.map(status => [status, jobs.filter(job => job.status === status).length]));
  const latestDiscovery = jobs.find(job => job.job_type === 'discover' && job.status === 'completed'); const latestProcess = jobs.find(job => job.job_type === 'process_candidate' && job.status === 'completed'); const active = jobs.filter(job => ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status)); const queued = jobs.filter(job => job.status === 'queued').sort((a, b) => (b.priority_rank - a.priority_rank) || (a.queue_position - b.queue_position) || (new Date(a.created_at) - new Date(b.created_at))); const linkByCandidate = new Map(links.map(link => [link.candidate_id, link]));
  const queueRow = (job, index) => `<tr draggable="true" data-queue-job="${esc(job.id)}"><td>${index + 1}</td><td class="mono">${esc(job.id.slice(0, 8))}</td><td>${esc(jobTarget(job))}</td><td>${esc(humanize(job.job_type))}</td><td><select data-queue-priority="${esc(job.id)}"><option value="urgent" ${job.priority_rank === 300 ? 'selected' : ''}>Urgent</option><option value="high" ${job.priority_rank === 200 ? 'selected' : ''}>High</option><option value="normal" ${job.priority_rank === 100 ? 'selected' : ''}>Normal</option><option value="low" ${job.priority_rank === 0 ? 'selected' : ''}>Low</option></select></td><td>${esc(dShort(job.created_at))}</td><td>${esc(job.profiles?.name || 'System')}</td><td><button class="quiet compact-button" data-queue-action="next" data-job-id="${esc(job.id)}">Move to next</button> <button class="quiet compact-button" data-queue-action="up" data-job-id="${esc(job.id)}">Up</button> <button class="quiet compact-button" data-queue-action="down" data-job-id="${esc(job.id)}">Down</button> <button class="quiet compact-button" data-queue-action="bottom" data-job-id="${esc(job.id)}">Bottom</button></td></tr>`;
  const commissionForm = '';
  title('Pipeline'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline</span></div><h1>Pipeline control</h1><p class="standfirst">Queue work for the local controller. Review and publishing remain separate editorial decisions.</p></div>${deskNav(p, 'pipeline')}<section class="desk-section"><div class="pipeline-status-grid"><div><span class="label">Controller</span><p class="meta-line">Controller status unavailable</p><p class="field-note">The Newsroom reads durable queue activity only. It does not contact the Mac Studio.</p></div><div><span class="label">Queue</span><p class="meta-line">${counts.queued} queued · ${counts.running} running · ${counts.failed} failed · ${counts.completed} completed</p><p class="field-note">${active.length ? `${active.length} active job${active.length === 1 ? '' : 's'} in the controller queue.` : 'No active jobs.'}</p></div><div><span class="label">Latest work</span><p class="field-note">Discovery: ${latestDiscovery ? `<a href="${jobHref(latestDiscovery)}">${dShort(latestDiscovery.finished_at || latestDiscovery.created_at)}</a>` : 'None recorded'}</p><p class="field-note">Candidate processing: ${latestProcess ? `<a href="${jobHref(latestProcess)}">${dShort(latestProcess.finished_at || latestProcess.created_at)}</a>` : 'None recorded'}</p></div></div></section>${commissionForm}<section class="desk-section"><div class="section-head"><div><span class="label">Running now</span><h2>${active.map(jobTarget).join(' · ') || 'No active job'}</h2></div></div><p class="field-note">Running and claimed jobs cannot be moved.</p></section><section class="desk-section"><div class="section-head"><div><span class="label">Next up</span><h2>Queued work</h2></div></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Order</th><th>Job</th><th>Target</th><th>Type</th><th>Priority</th><th>Created</th><th>Requester</th><th>Controls</th></tr></thead><tbody>${queued.map(queueRow).join('') || '<tr><td colspan="8" class="empty-row">No queued jobs.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Discovery</span><h2>Run Web3 sources</h2><p class="field-note">Only ready, healthy, degraded, or retryable feed sources from the Source Graph are eligible. Staged X accounts remain out of this run.</p></div></div><form id="discovery-job" class="queue-filters">${coverageFocusFieldMarkup()}<label>Priority<select name="priority"><option value="50">Normal</option><option value="75">High</option><option value="25">Low</option></select></label><button type="submit">Run discovery</button><p class="notice form-message" data-form-message hidden></p></form></section><section class="desk-section"><div class="section-head"><div><span class="label">Candidates</span><h2>Retained pipeline candidates</h2></div></div><div class="table-scroll" role="region" aria-label="Pipeline candidates" tabindex="0"><table class="desk-table"><thead><tr><th>Candidate</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${candidates.map(candidate => { const action = candidatePipelineAction(candidate, jobs, linkByCandidate.get(candidate.id)); const button = action?.type === 'process' ? `<button class="quiet compact-button" type="button" data-process-candidate="${esc(action.candidate_id)}">${esc(action.label)}</button>` : action ? `<a class="text-link" href="${esc(action.href)}">${esc(action.label)}</a>` : '—'; return `<tr><td class="title-cell">${candidate.canonical_url ? sourceHref(candidate.canonical_url, candidate.title || 'Untitled candidate') : esc(candidate.title || 'Untitled candidate')}</td><td><span class="stamp st-${esc(candidate.status)}">${esc(humanize(candidate.status))}</span></td><td class="mono">${dShort(candidate.updated_at)}</td><td>${button}</td></tr>`; }).join('') || '<tr><td colspan="4" class="empty-row">Run discovery to retain candidates for processing.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Recent jobs</span><h2>Queue history</h2></div></div><form id="job-filters" class="queue-filters"><label>Status<select name="status">${statusOptions(PIPELINE_JOB_STATUSES, statusFilter)}</select></label><label>Type<select name="type">${statusOptions(['discover', 'process_candidate', 'retry_run', 'sync_candidate', 'health_check'], typeFilter)}</select></label><label>Source<select name="source">${statusOptions([...new Set(jobs.map(job => job.source))].filter(Boolean).sort(), sourceFilter)}</select></label><button class="quiet" type="submit">Filter</button></form><div class="table-scroll" role="region" aria-label="Pipeline jobs" tabindex="0"><table class="desk-table pipeline-jobs"><thead><tr><th>Job</th><th>Type</th><th>Requester</th><th>Target</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Result</th></tr></thead><tbody>${visible.map(job => `<tr><td class="mono"><a href="${jobHref(job)}">${esc(job.id.slice(0, 8))}</a></td><td>${esc(humanize(job.job_type))}</td><td>${esc(job.profiles?.name || 'System')}</td><td>${esc(jobTarget(job))}</td><td><span class="stamp st-${esc(job.status)}">${esc(humanize(job.status))}</span></td><td>${job.attempt_count}/${job.max_attempts}</td><td>${esc(pipelineDuration(job))}</td><td>${esc(jobResult(job))}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">No jobs match these filters.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Sources</span><h2>Eligible Web3 discovery sources</h2></div><p class="field-note">These live Source Graph records are the only sources this control can retrieve.</p></div><div class="table-scroll" role="region" aria-label="Web3 discovery sources" tabindex="0"><table class="desk-table"><thead><tr><th>Source</th><th>Type</th><th>Domain</th><th>Topics</th><th>Last check</th></tr></thead><tbody>${sources.map(source => { let domain = source.handle_or_url; try { domain = new URL(source.handle_or_url).hostname; } catch {} return `<tr><td>${esc(source.name)}</td><td>${esc(humanize(source.source_type))}</td><td>${esc(domain)}</td><td>${esc([...(source.primary_sections || []), ...(source.chain_tags || [])].join(' · '))}</td><td class="mono">${source.last_checked_at ? dShort(source.last_checked_at) : source.last_success_at ? dShort(source.last_success_at) : 'Not yet recorded'}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty-row">No eligible Web3 source is currently ready for discovery.</td></tr>'}</tbody></table></div></section></div>`;
  const pipelineAnchors = {
    'Running now': 'pipeline-running',
    'Next up': 'pipeline-queued',
    Discovery: 'pipeline-discovery',
    Candidates: 'pipeline-candidates',
    'Recent jobs': 'pipeline-history',
    Sources: 'pipeline-sources'
  };
  document.querySelectorAll('.desk > .desk-section').forEach(section => {
    const label = section.querySelector('.section-head .label')?.textContent.trim();
    if (pipelineAnchors[label]) section.id = pipelineAnchors[label];
  });
  const jumpNav = document.createElement('nav');
  jumpNav.className = 'pipeline-jump-nav';
  jumpNav.setAttribute('aria-label', 'Pipeline sections');
  jumpNav.innerHTML = Object.entries(pipelineAnchors).map(([label, id]) => '<a href="#' + id + '">' + label + '</a>').join('');
  document.querySelector('.desk > .desk-section')?.insertAdjacentElement('afterend', jumpNav);
  bindTablePaging(document.querySelector('[aria-label="Pipeline candidates"] table'), 'pipeline-candidates-more');
  bindTablePaging(document.querySelector('.pipeline-jobs'), 'pipeline-history-more');
  document.querySelectorAll('.desk-table').forEach(prepareResponsiveTable);
  const controllerPanel = document.querySelector('.pipeline-status-grid > div');
  if (controllerPanel) {
    controllerPanel.querySelector('.meta-line').textContent = 'Assignments use the durable queue';
    controllerPanel.querySelector('.field-note').textContent = 'The Mac Studio checks this queue. The browser never opens a connection to the machine.';
  }
  const submit = async (form, payload) => { showFormMessage(form, ''); setBusy(form, true, 'Submitting…'); try { const result = await pipelineRequest('/api/newsroom/pipeline/jobs', payload); if (result.duplicate) { showFormMessage(form, 'An active matching job already exists. Opening it now.', 'ok'); setTimeout(() => location.href = jobHref(result.job), 450); } else location.href = jobHref(result.job); } catch (error) { setBusy(form, false); showFormMessage(form, error.message); } };
  bindCoverageFocusDescription(document.querySelector('#discovery-job'));
  document.querySelector('#discovery-job').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; const values = new FormData(form); const focusId = String(values.get('focus_id') || ''); rememberDiscoveryFocus(focusId); try { submit(form, validateNewsroomJobRequest({ job_type: 'discover', focus_id: focusId, priority: values.get('priority') })); } catch (error) { showFormMessage(form, error.message); } };
  document.querySelector('#job-filters').onsubmit = event => { event.preventDefault(); const next = new URLSearchParams(new FormData(event.currentTarget)); location.href = `/newsroom/pipeline${next.toString() ? `?${next}` : ''}`; };
  document.querySelectorAll('[data-process-candidate]').forEach(button => button.addEventListener('click', () => { const form = button.closest('.desk') || document.body; submit(form, { job_type: 'process_candidate', candidate_id: button.dataset.processCandidate, priority: 50 }); }));
  const reorder = async (id, action, priority) => { await pipelineRequest(`/api/newsroom/pipeline/jobs/${id}/reorder`, { action, priority }); location.reload(); };
  document.querySelectorAll('[data-queue-action]').forEach(button => button.addEventListener('click', () => reorder(button.dataset.jobId, button.dataset.queueAction)));
  document.querySelectorAll('[data-queue-priority]').forEach(select => select.addEventListener('change', () => reorder(select.dataset.queuePriority, 'priority', select.value)));
  let dragged = null;
  document.querySelectorAll('[data-queue-job]').forEach(row => { row.addEventListener('dragstart', () => { dragged = row.dataset.queueJob; }); row.addEventListener('dragover', event => event.preventDefault()); row.addEventListener('drop', event => { event.preventDefault(); if (dragged && dragged !== row.dataset.queueJob) reorder(dragged, 'next'); }); });
  bindSignOut(); if (active.length) setTimeout(() => location.reload(), 12000);
}

async function articleAssignment() {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  if (!requirePipelineEditor(p)) return location.href = '/newsroom';
  title('Request AI article');
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>AI article</span></div><h1>Start with the point.</h1><p class="standfirst">Give the desk a topic, the evidence you already have, and the editorial promise. It creates a pitch first. Nothing writes or publishes until you commission that pitch.</p></div>${deskNav(p, 'assignment')}
    <form id="article-assignment" class="desk-form" novalidate>
      <p class="notice form-message" data-form-message hidden></p>
      <section class="editor-section"><div class="section-head"><div><span class="label">Assignment</span><h2>What should Anyways make sense of?</h2></div></div>
        <label>Topic / assignment brief<textarea name="brief" class="textarea-short" required minlength="20" maxlength="3000" placeholder="What is happening, what you suspect matters about it, and what you want the reader to understand."></textarea></label>
        <label>Loose notes <span class="field-note">Optional</span><textarea name="notes" class="textarea-short" maxlength="4000" placeholder="Angle, people to consider, questions to answer, things to avoid, or an idea for the visual."></textarea></label>
      </section>
      <section class="editor-section"><div class="section-head"><div><span class="label">Editorial promise</span><h2>Choose the shape before research starts.</h2></div></div>
        <div class="editor-grid"><div><label>Primary Lens<select name="section_id" required>${NEWSROOM_LENSES.map(lens => `<option value="${esc(lens.id)}">${esc(lens.name)}</option>`).join('')}</select></label><p class="field-note">${esc(SECTION_PROMISES.internet || '')}</p></div><div><label>Section (optional)<select name="story_form" required>${NEWSROOM_SECTIONS.map(section => `<option value="${esc(section.id)}">${esc(section.name)} · ${esc(`${section.minimum}-${section.maximum} words`)}</option>`).join('')}</select></label><p class="field-note">The section sets the reading-time promise. The reporting still has to earn it.</p></div></div>
        <label>Beats <span class="field-note">Optional, comma-separated</span><input name="beats" maxlength="300" placeholder="AI, design, food"></label>
        <label>Topics (optional) <span class="field-note">Comma-separated</span><input name="tags" maxlength="600" placeholder="restaurant culture, automation"></label>
      </section>
      <section class="editor-section"><div class="section-head"><div><span class="label">Starting evidence</span><h2>Links the reporter must begin with.</h2></div></div>
        <label>Source links <span class="field-note">One public URL per line. At least one is required.</span><textarea name="source_urls" class="textarea-short" required placeholder="https://example.com/report\nhttps://example.org/primary-document"></textarea></label>
        <p class="field-note">The initial pitch is checked against this assignment. If it cannot name a real reason the story matters, it will be rejected instead of sending generic news to the writer.</p>
      </section>
      <div class="form-actions"><button type="submit">Create editorial pitch</button><a class="button quiet" href="/newsroom/pitches">Back to Pitches</a></div>
    </form></div>`;
  const form = document.querySelector('#article-assignment');
  form.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    try {
      const payload = validateNewsroomJobRequest({ job_type: 'create_editorial_pitch', ...values });
      showFormMessage(form, '');
      setBusy(form, true, 'Creating pitch…');
      const result = await pipelineRequest('/api/newsroom/pipeline/jobs', payload);
      if (!result?.job?.id) throw new Error('The pitch request was accepted without a job ID. Please check the pipeline queue.');
      location.href = jobHref(result.job);
    } catch (error) {
      setBusy(form, false);
      showFormMessage(form, error.message || 'The article request could not be submitted.');
    }
  };
  bindSignOut();
}

async function pipelineJobDetail(jobId) {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  if (!requirePipelineEditor(p)) return location.href = '/newsroom';
  const job = await dataOf(sb.from('pipeline_jobs').select('id,job_type,parameters,source,requested_by,priority,status,attempt_count,max_attempts,lease_owner,lease_expires_at,cancellation_requested_at,created_at,claimed_at,started_at,finished_at,last_heartbeat_at,result,error,summary_log,profiles(name),pipeline_job_events(id,at,level,event_type,message,metadata)').eq('id', jobId).maybeSingle(), 'pipeline job');
  if (!job) { title('Not found'); app.innerHTML = notFound(); return; }
  if (!job.parameters?.candidate_id && job.result?.result?.candidate_id) job.parameters = { ...job.parameters, candidate_id: job.result.result.candidate_id };
  const candidateId = job.parameters?.candidate_id; const candidate = candidateId ? await optionalData(sb.from('candidate_stories').select('id,external_id,title,status').eq('external_id', candidateId).limit(1), 'related pipeline candidate') : []; const related = candidate[0]; const cancellable = ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) && !job.cancellation_requested_at; const retryable = canRetryNewsroomPipelineJob(job); const events = (job.pipeline_job_events || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at)); const review = pipelineReviewHref(related || {});
  title('Pipeline job'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline job</span></div><h1>${esc(humanize(job.job_type))}</h1><p class="standfirst">${esc(job.id)}</p></div>${deskNav(p, 'pipeline')}<p class="notice form-message" id="job-message" hidden></p><section class="desk-section"><div class="pipeline-status-grid"><div><span class="label">Status</span><p><span class="stamp st-${esc(job.status)}">${esc(humanize(job.status))}</span></p><p class="field-note">${job.cancellation_requested_at ? 'Cancellation requested.' : 'No cancellation requested.'}</p></div><div><span class="label">Execution</span><p class="field-note">Attempts ${job.attempt_count}/${job.max_attempts} · ${esc(pipelineDuration(job))}</p><p class="field-note">Started ${job.started_at ? esc(dLong(job.started_at)) : 'Not claimed yet'}</p></div><div><span class="label">Requester</span><p class="field-note">${esc(job.profiles?.name || 'System')} · ${esc(humanize(job.source))}</p><p class="field-note">Priority ${job.priority}</p></div></div><div class="form-actions">${cancellable ? '<button id="cancel-job" type="button" class="quiet">Cancel job</button>' : ''}${retryable ? '<button id="retry-job" type="button">Retry job</button>' : ''}${related ? `<a class="text-link" href="/newsroom/pipeline">Open candidate</a>` : ''}${review ? `<a class="text-link" href="${esc(review)}">Open review</a>` : ''}</div></section><section class="desk-section"><span class="label">Parameters</span><pre class="packet-data">${esc(JSON.stringify(job.parameters || {}, null, 2))}</pre><p class="field-note">Lease: ${esc(job.lease_owner ? 'Active controller lease' : 'No active lease')} ${job.lease_expires_at ? `until ${dLong(job.lease_expires_at)}` : ''}</p>${job.error ? `<h3>Error</h3><pre class="packet-data">${esc(JSON.stringify(job.error, null, 2))}</pre>` : ''}${job.result ? `<h3>Result</h3><pre class="packet-data">${esc(JSON.stringify(job.result, null, 2))}</pre>` : ''}</section><section class="desk-section"><span class="label">Timeline</span>${events.map(event => `<div class="revision-line"><span>${esc(dShort(event.at))}</span><span class="stamp st-${esc(event.level)}">${esc(humanize(event.event_type))}</span><span>${esc(event.message)}</span></div>`).join('') || '<p class="field-note">No event history retained.</p>'}</section><details class="editor-section"><summary>Concise controller log</summary><pre class="packet-data">${esc(safeLog(job.summary_log) || 'No summary log retained.')}</pre></details></div>`;
  const message = document.querySelector('#job-message'); const action = async (suffix, success) => { try { await pipelineRequest(`/api/newsroom/pipeline/jobs/${job.id}/${suffix}`); message.textContent = success; message.className = 'notice form-message ok'; message.hidden = false; setTimeout(() => location.reload(), 650); } catch (error) { message.textContent = error.message; message.className = 'notice form-message'; message.hidden = false; } };
  const technicalSection = document.querySelectorAll('.desk > .desk-section')[1];
  if (technicalSection) {
    technicalSection.classList.add('pipeline-job-technical');
    const parameterPre = technicalSection.querySelector('pre');
    const lease = parameterPre?.nextElementSibling?.matches('.field-note') ? parameterPre.nextElementSibling : null;
    const errorHeading = [...technicalSection.querySelectorAll('h3')].find(heading => heading.textContent === 'Error');
    const resultHeading = [...technicalSection.querySelectorAll('h3')].find(heading => heading.textContent === 'Result');
    const disclosure = (label, nodes) => {
      const details = document.createElement('details');
      details.className = 'technical-disclosure';
      const summary = document.createElement('summary');
      summary.textContent = label;
      details.append(summary, ...nodes.filter(Boolean));
      return details;
    };
    const parts = [disclosure('Parameters', [parameterPre, lease])];
    if (errorHeading) parts.push(disclosure('Error', [errorHeading.nextElementSibling]));
    if (resultHeading) parts.push(disclosure('Result', [resultHeading.nextElementSibling]));
    technicalSection.replaceChildren(...parts);
  }
  document.querySelector('#cancel-job')?.addEventListener('click', () => action('cancel', 'Cancellation requested.'));
  document.querySelector('#retry-job')?.addEventListener('click', () => action('retry', 'Replacement job submitted.'));
  bindSignOut(); if (ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status)) setTimeout(() => location.reload(), 8000);
}
function sourceHref(url, label) { const safe = externalUrl(url); return safe ? `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${esc(label || safe)}</a>` : esc(label || 'Unavailable source'); }
function queueFilters(items) { const collect = key => [...new Set(items.flatMap(item => { const value = pipelineMetadata(item)[key]; return Array.isArray(value) ? value : [value]; }).filter(Boolean))].sort(); const options = (values, selected, label = value => humanize(value)) => `<option value="">All</option>${values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label(value))}</option>`).join('')}`; const qs = new URLSearchParams(location.search); return { qs, html: `<form class="queue-filters" id="pipeline-filters"><label>Lens<select name="section">${options(collect('section'), qs.get('section'), lensLabel)}</select></label><label>Section<select name="story_form">${options(collect('storyForm'), qs.get('story_form'), sectionLabel)}</select></label><label>Beat<select name="beat">${options(collect('beats'), qs.get('beat'), beatLabel)}</select></label><label>Topic<select name="tag">${options(collect('tags'), qs.get('tag'), topicLabel)}</select></label><label>Status<select name="status">${options(PIPELINE_QUEUE_STATUSES, qs.get('status'), editorStatusLabel)}</select></label><button class="quiet" type="submit">Filter</button></form>` }; }
function batchSummary(batch = {}) {
  const shortfalls = Object.entries(batch.shortfalls || {}).filter(([, count]) => Number(count) > 0).map(([section, count]) => `${count} ${humanize(section)}`);
  const ready = Number(batch.summary?.pitch_ready || 0), rejected = Number(batch.summary?.rejected || 0);
  const focusId = batch.requested_focus_id || batch.summary?.focus_id || 'all';
  const focus = discoveryFocus(focusId);
  const parts = [`${focus?.label || 'All'} coverage`, `target ${batch.target_count}`, `${ready} pitches ready`];
  if (rejected) parts.push(`${rejected} leads rejected`);
  if (shortfalls.length) parts.push(`missing ${shortfalls.join(', ')}`);
  return parts.join(' · ');
}

const DISCOVERY_FOCUS_STORAGE_KEY = 'anyways.discovery-focus';
function lastUsedDiscoveryFocus() {
  try {
    const saved = localStorage.getItem(DISCOVERY_FOCUS_STORAGE_KEY);
    return DISCOVERY_FOCUS_IDS.includes(saved) ? saved : DEFAULT_DISCOVERY_FOCUS_ID;
  } catch {
    return DEFAULT_DISCOVERY_FOCUS_ID;
  }
}
function rememberDiscoveryFocus(focusId) {
  if (!DISCOVERY_FOCUS_IDS.includes(focusId)) return;
  try { localStorage.setItem(DISCOVERY_FOCUS_STORAGE_KEY, focusId); } catch {}
}
function coverageFocusFieldMarkup(selected = lastUsedDiscoveryFocus()) {
  return `<label>Coverage Focus<select name="focus_id" required>${DISCOVERY_FOCUSES.map(focus => `<option value="${esc(focus.id)}" ${focus.id === selected ? 'selected' : ''}>${esc(focus.label)}</option>`).join('')}</select><span class="field-note" data-coverage-focus-description>${esc(discoveryFocus(selected)?.description || '')}</span></label>`;
}

function bindCoverageFocusDescription(form) {
  const select = form?.querySelector('select[name="focus_id"]');
  const description = form?.querySelector('[data-coverage-focus-description]');
  if (!select || !description) return;
  select.addEventListener('change', () => { description.textContent = discoveryFocus(select.value)?.description || ''; });
}
function editorialBatchFormMarkup({ formId = 'run-editorial-batch', targetOptions = ['5', '3', '10'] } = {}) {
  return `<form id="${esc(formId)}" class="queue-filters"><div class="discovery-form-intro"><span class="label">Start discovery</span><p class="field-note">Coverage Focus chooses the broad subject area before source retrieval. Primary Lens remains the editorial question applied after a story is selected.</p></div>${coverageFocusFieldMarkup()}<label>Primary Lens<select name="section_id"><option value="">Any Lens</option>${NEWSROOM_LENSES.map(lens => `<option value="${esc(lens.id)}">${esc(lens.name)}</option>`).join('')}</select></label><label>Story Form<select name="story_form"><option value="">Any Story Form</option>${NEWSROOM_SECTIONS.map(section => `<option value="${esc(section.id)}">${esc(section.name)}</option>`).join('')}</select></label><label>Story count<select name="target_count">${targetOptions.map(value => `<option value="${value}">${value}</option>`).join('')}</select></label><button type="submit">Start discovery</button><p class="notice form-message" data-batch-message hidden></p></form>`;
}
function bindEditorialBatchForm(form) {
  if (!form) return;
  bindCoverageFocusDescription(form);
  form.onsubmit = async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const message = form.querySelector('[data-batch-message]');
    const values = new FormData(form);
    const focusId = String(values.get('focus_id') || '');
    rememberDiscoveryFocus(focusId);
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      await pipelineRequest('/api/newsroom/pipeline/jobs', validateNewsroomJobRequest({ job_type: 'run_editorial_batch', focus_id: focusId, section_id: values.get('section_id'), story_form: values.get('story_form'), target_count: values.get('target_count') }));
      message.textContent = `${discoveryFocus(focusId)?.label || 'Selected'} coverage discovery is queued. The selected focus is saved with this batch.`;
      message.className = 'notice form-message ok';
      message.hidden = false;
      window.setTimeout(() => location.reload(), 1200);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Start discovery';
      message.textContent = error.message || 'Discovery could not be queued.';
      message.hidden = false;
    }
  };
}

function alignReviewSurface({ stageMarkup, observability, sourceCount = 0, claimCount = 0, packetChecksum = '', draftChecksum = '' } = {}) {
  const details = [...document.querySelectorAll('details')];
  const progress = details.find(item => /Pipeline progress/i.test(item.querySelector('summary')?.textContent || ''));
  if (progress) {
    progress.querySelector('summary').textContent = 'Pipeline progress';
    progress.insertAdjacentHTML('afterbegin', `${stageMarkup}<p class="field-note">${esc(observability)}</p><p class="field-note">Evidence packet checksum: <code>${esc(packetChecksum || 'not recorded')}</code> · Draft checksum: <code>${esc(draftChecksum || 'not recorded')}</code></p><p class="field-note">${sourceCount} source${sourceCount === 1 ? '' : 's'} · ${claimCount} claim${claimCount === 1 ? '' : 's'}</p>`);
  }
  const evidence = details.find(item => /Evidence packet/i.test(item.querySelector('summary')?.textContent || ''));
  if (evidence) {
    evidence.querySelector('summary').textContent = 'Evidence packet';
  }
  document.querySelectorAll('label').forEach(label => {
    const text = label.firstChild?.textContent?.trim();
    if (text === 'Primary Lens') label.firstChild.textContent = 'Primary Lens';
    if (text === 'Beats') label.firstChild.textContent = 'Beats';
    if (text === 'Topics (optional)' || text === 'Tags') label.firstChild.textContent = 'Topics (optional)';
  });
  const lensField = document.querySelector('input[name="primary_section"]');
  if (lensField) {
    lensField.dataset.internalLens = lensField.value;
    lensField.value = lensLabel(lensField.value);
    lensField.readOnly = true;
  }
}

function alignNewsroomTaxonomy() {
  if (isPublicRoute) return;
  document.querySelectorAll('th').forEach(cell => {
    if (cell.textContent.trim() === 'Section') cell.textContent = 'Lens';
  });
  document.querySelectorAll('select[name="section_id"] option').forEach(option => {
    const normalizedLabel = canonicalSectionId(option.textContent);
    if (NEWSROOM_LENSES.some(lens => lens.id === option.value || lens.id === normalizedLabel)) option.textContent = lensLabel(NEWSROOM_LENSES.some(lens => lens.id === option.value) ? option.value : option.textContent);
  });
  document.querySelectorAll('select[name="story_form"] option').forEach(option => {
    if (option.value) option.textContent = sectionLabel(option.value);
  });
  document.querySelectorAll('.stamp').forEach(stamp => {
    const label = editorStatusLabel(stamp.textContent.trim());
    if (label) stamp.textContent = label;
  });
  document.querySelectorAll('.phase2-readable .src-meta').forEach(node => {
    node.textContent = node.textContent.split(' · ').filter(part => !/^[a-f0-9]{32,}$/i.test(part) && !/^source:/i.test(part) && !/^job[-_ ]?id:/i.test(part)).join(' · ');
  });
}
async function reviewQueue() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const requestedStatus = new URLSearchParams(location.search).get('status') || '';
  const [submittedStories, candidates, batches] = await Promise.all([
    optionalData(sb.from('stories').select('id,title,status,updated_at,sections!stories_section_id_fkey(name),profiles!stories_author_id_fkey(name)').eq('status', 'review').order('updated_at', { ascending: false }), 'submitted stories'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,created_at,updated_at').in('status', PIPELINE_QUEUE_STATUSES).order('updated_at', { ascending: false }), 'pipeline review queue'),
    optionalData(sb.from('pipeline_batch_runs').select('id,status,target_count,requested_focus_id,shortfalls,summary,requested_at').order('requested_at', { ascending: false }).limit(3), 'editorial batches')
  ]);
  const ids = candidates.map(item => item.id);
  const [drafts, documents, claims, images] = await Promise.all([
    ids.length ? optionalData(sb.from('pipeline_drafts').select('candidate_id').in('candidate_id', ids), 'pipeline drafts') : [],
    ids.length ? optionalData(sb.from('discovered_documents').select('candidate_id').in('candidate_id', ids), 'pipeline documents') : [],
    ids.length ? optionalData(sb.from('pipeline_claims').select('draft_id,status,pipeline_drafts!inner(candidate_id)').in('pipeline_drafts.candidate_id', ids), 'pipeline claims') : [],
    ids.length ? optionalData(sb.from('image_candidates').select('candidate_id,rights_status,warning_flags').in('candidate_id', ids), 'pipeline images') : []
  ]);
  const counts = new Map(ids.map(id => [id, { source_count: 0, unresolved_claim_count: 0, rights_warning_count: 0 }])); documents.forEach(row => counts.get(row.candidate_id).source_count++); claims.filter(row => row.status !== 'supported').forEach(row => counts.get(row.pipeline_drafts?.candidate_id).unresolved_claim_count++); images.filter(row => row.rights_status !== 'approved').forEach(row => counts.get(row.candidate_id).rights_warning_count++);
  const items = candidates.map(item => ({ ...item, ...counts.get(item.id) })); const filters = queueFilters(items); const filtered = filterPipelineQueue(items, Object.fromEntries(filters.qs)); const visible = filters.qs.get('status') ? filtered : filtered.filter(item => ['pitch_ready', 'ready_for_review', 'ai_review_ready', 'revision_requested'].includes(item.status));
  title(requestedStatus === 'pitch_ready' ? 'Pitches' : 'AI Review'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${requestedStatus === 'pitch_ready' ? 'Pitches' : 'Discovery'}</span></div><h1>Find ideas with a point of view</h1><p class="standfirst">Discovery proposes a point of view before it commissions research or writing.</p></div>${deskNav(p, 'review')}
    <section class="desk-section"><div class="section-head"><div><span class="label">Discovery</span><h2>Find ideas with a point of view</h2><p class="field-note">Coverage Focus chooses the broad material to retrieve. Primary Lens remains separate and is applied during screening.</p></div></div>${editorialBatchFormMarkup()}${batches.map(batch => `<p class="field-note"><strong>${esc(editorStatusLabel(batch.status))}</strong> · ${esc(batchSummary(batch))}</p>`).join('') || '<p class="field-note">No discovery runs yet.</p>'}</section>
    <section class="desk-section"><div class="section-head"><div><span class="label">Editorial submissions</span><h2>${submittedStories.length} waiting</h2></div></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Headline</th><th>Writer</th><th>Section</th><th>Submitted</th><th>Next step</th></tr></thead><tbody>${submittedStories.map(story => `<tr><td class="title-cell"><a href="/newsroom/${story.id}">${esc(story.title || 'Untitled story')}</a></td><td>${esc(story.profiles?.name || 'Unknown')}</td><td class="mono">${esc(story.sections?.name || '')}</td><td class="mono">${dShort(story.updated_at)}</td><td><a class="text-link" href="/newsroom/${story.id}">Open review</a></td></tr>`).join('') || '<tr><td colspan="5" class="empty-row">No editorial submissions are waiting.</td></tr>'}</tbody></table></div></section>
      <section class="desk-section"><div class="section-head"><div><span class="label">Pitches and review</span><h2>Editorial pitches and article packages</h2></div></div><p class="field-note">A selected pitch starts source acquisition. An article package appears here only after evidence is frozen and deterministic checks complete.</p><p class="notice form-message" id="queue-message" hidden></p>${filters.html}<div class="table-scroll"><table class="desk-table queue-table"><thead><tr><th>Headline</th><th>Status</th><th>Lens</th><th>Section / beats / topics</th><th>Sources</th><th>Checks</th><th>Photos</th><th>Created</th><th>Actions</th></tr></thead><tbody>${visible.map(item => { const meta = pipelineMetadata(item); const isPitch = item.status === 'pitch_ready'; const checks = meta.reviewWarnings + meta.revisionSuggestions; const requirement = item.classification?.editorial_pitch?.research_requirement || ''; const reason = item.classification?.editorial_pitch?.research_requirement_reason || ''; const actions = isPitch && item.classification?.editorial_pitch?.accepted === true ? `<button type="button" class="compact-button" data-commission-pitch="${esc(item.external_id || item.id)}" data-research-requirement="${esc(requirement)}" data-research-requirement-reason="${esc(reason)}">Commission reporting</button> <button type="button" class="danger-quiet compact-button" data-cleanup-disposable="${esc(item.id)}" data-cleanup-story="">Delete test record</button>` : `<button type="button" class="danger-quiet compact-button" data-cleanup-disposable="${esc(item.id)}" data-cleanup-story="">Delete test record</button>`; return `<tr><td class="title-cell"><a href="/newsroom/review/${esc(item.external_id || item.id)}">${esc(item.title || 'Untitled')}</a></td><td><span class="stamp st-${esc(meta.status)}">${esc(editorStatusLabel(meta.status))}</span></td><td class="mono">${esc(lensLabel(meta.section))}</td><td class="mono">${esc([sectionLabel(meta.storyForm), ...meta.beats.map(beatLabel), ...meta.tags.map(topicLabel)].filter(Boolean).join(' · '))}</td><td>${isPitch ? 'Not started' : meta.sourceCount}</td><td>${isPitch ? 'Not started' : checks ? `<span class="warning-count">${checks} advisory</span>` : 'No warnings'}</td><td>${isPitch ? 'Not started' : meta.rightsWarnings ? `<span class="warning-count">${meta.rightsWarnings} need clearance</span>` : 'Cleared'}</td><td class="mono">${dShort(meta.createdAt)}</td><td>${actions}</td></tr>`; }).join('') || '<tr><td colspan="9" class="empty-row">No editorial packages match these filters.</td></tr>'}</tbody></table></div></section></div>`; document.querySelector('#pipeline-filters').onsubmit = event => { event.preventDefault(); const qs = new URLSearchParams(new FormData(event.currentTarget)); location.href = `/newsroom/review?${qs}`; }; const queueMessage = document.querySelector('#queue-message'); document.querySelectorAll('[data-commission-pitch]').forEach(button => { button.onclick = () => commissionPitch(button.dataset.commissionPitch, button, queueMessage, button.dataset.researchRequirement, button.dataset.researchRequirementReason); }); bindDisposableCleanupActions(); bindSignOut();
  bindTablePaging(document.querySelector('.desk-table:not(.queue-table)'), 'review-submissions-more');
  bindTablePaging(document.querySelector('.queue-table'), 'review-packages-more');
  document.querySelectorAll('.desk-table').forEach(prepareResponsiveTable);
  bindEditorialBatchForm(document.querySelector('#run-editorial-batch'));
}
async function reviewPackage(candidateId) {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const candidate = await dataOf(sb.from('candidate_stories').select('id,external_id,title,status,canonical_url,classification,created_at,updated_at').eq('external_id', candidateId).maybeSingle(), 'pipeline review package'); if (!candidate) { title('Not found'); return app.innerHTML = notFound(); }
  if (candidate.status === 'pitch_ready') {
    const pitch = candidate.classification?.editorial_pitch || {};
    title('Editorial pitch');
    app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Editorial pitch</span></div><h1>${esc(candidate.title || 'Untitled pitch')}</h1><p class="standfirst">${esc(pitch.lens || 'No editorial lens was retained.')}</p></div>${deskNav(p, 'pitches')}<section class="desk-section"><p class="meta-line"><span class="stamp st-pitch_ready">Pitch Selected</span> · Lens: ${esc(lensLabel(pitch.primary_section || candidate.classification?.primary_section || ''))} · Section: ${esc(sectionLabel(pitch.story_form || candidate.classification?.story_form || ''))}</p><div class="editor-grid"><div><section class="editor-section"><h2>Lens answer</h2><p>${esc(pitch.section_answer || 'No governing-question answer was retained.')}</p><h3>What the reader gets</h3><p>${esc(pitch.reader_takeaway || '')}</p><h3>Why now</h3><p>${esc(pitch.why_now || '')}</p><h3>The evidence this needs</h3><ul>${(pitch.evidence_plan || []).map(item => `<li>${esc(item)}</li>`).join('') || '<li>Evidence plan unavailable.</li>'}</ul></section></div><div><section class="editor-section"><h2>Research decision</h2><p class="field-note">Commissioning starts source acquisition. Terra only runs when this decision is Required. Nothing publishes automatically.</p><label>Research requirement<select id="research-requirement"><option value="none" ${pitch.research_requirement === 'none' ? 'selected' : ''}>None</option><option value="required" ${pitch.research_requirement !== 'none' ? 'selected' : ''}>Terra</option></select></label><p class="field-note">Confirm this decision before commissioning. It is stored with the approved pitch and controls whether Terra may run.</p><h3>It must earn at least two reasons to exist</h3><ul>${(pitch.significance_tests || []).map(item => `<li><strong>${esc(item)}</strong>${pitch.significance_rationales?.[item] ? `: ${esc(pitch.significance_rationales[item])}` : ''}</li>`).join('') || '<li>No retained significance rationale.</li>'}</ul><p><a class="text-link" href="${esc(externalUrl(candidate.canonical_url) || '#')}" target="_blank" rel="noreferrer">Open starting lead</a></p><div class="form-actions"><button type="button" id="commission-pitch" data-candidate-external-id="${esc(candidate.external_id)}">Commission reporting</button><button type="button" id="reject-pitch" class="danger-quiet">Reject pitch</button></div><p class="notice form-message" id="pitch-message" hidden></p></section></div></div></section></div>`;
    const message = document.querySelector('#pitch-message');
    document.querySelector('#commission-pitch').onclick = event => commissionPitch(event.currentTarget.dataset.candidateExternalId, event.currentTarget, message, document.querySelector('#research-requirement').value);
    document.querySelector('#reject-pitch').onclick = async event => {
      event.currentTarget.disabled = true;
      const { error } = await sb.rpc('reject_editorial_pitch', { p_candidate_external_id: candidate.external_id });
      if (error) { event.currentTarget.disabled = false; message.textContent = error.message; message.hidden = false; return; }
      location.href = '/newsroom/review';
    };
    bindSignOut();
    return;
  }
  const databaseCandidateId = candidate.id;
  const [drafts, packetRows, documents, images, decisions, linkRows, phase2Rows, solPolishRows] = await Promise.all([
    optionalData(sb.from('pipeline_drafts').select('*').eq('candidate_id', databaseCandidateId).order('created_at', { ascending: false }).order('version', { ascending: false }), 'pipeline drafts'),
    optionalData(sb.from('research_packets').select('*').eq('candidate_id', databaseCandidateId).order('iteration', { ascending: false }), 'research packet'),
    optionalData(sb.from('discovered_documents').select('id,title,url,canonical_url,extraction_status,pipeline_run_id,retention,pipeline_sources(name,source_type)').eq('candidate_id', databaseCandidateId), 'pipeline documents'),
    optionalData(sb.from('image_candidates').select('*').eq('candidate_id', databaseCandidateId), 'image candidates'),
    optionalData(sb.from('pipeline_review_decisions').select('action,note,created_at,profiles(name)').eq('candidate_id', databaseCandidateId).order('created_at', { ascending: false }), 'review decisions'),
    optionalData(sb.from('pipeline_story_links').select('story_id,source_draft_version,created_at').eq('candidate_id', databaseCandidateId), 'pipeline story link'),
    optionalData(sb.from('pipeline_phase2_artifacts').select('pipeline_run_id,stage,pipeline_version,terra_evidence_contract_version,readiness_inventory_sha256,runtime_inventory_sha256,terra_input_packet_sha256,frozen_evidence_packet_sha256,draft_input_sha256,revision_input_sha256,payload,claims,usage,cost,updated_at').eq('candidate_id', databaseCandidateId).order('updated_at', { ascending: false }), 'Phase 2 artifacts'),
    optionalData(sb.from('pipeline_sol_polish_artifacts').select('*').eq('candidate_id', databaseCandidateId).order('created_at', { ascending: false }), 'Sol polish artifacts')
  ]);
  // Legacy projection contract retained: const activeRunId = drafts[0]?.pipeline_run_id || null; const activeDrafts = drafts.filter(draft => !activeRunId || draft.pipeline_run_id === activeRunId);
  const activeRunId = drafts[0]?.pipeline_run_id || phase2Rows[0]?.pipeline_run_id || null; const activeDrafts = drafts.filter(draft => !activeRunId || draft.pipeline_run_id === activeRunId); const activeDocuments = documents.filter(document => !activeRunId || document.pipeline_run_id === activeRunId); const activeImages = images.filter(image => !activeRunId || image.pipeline_run_id === activeRunId); const current = activeDrafts[0] || {}; const draftIds = activeDrafts.map(draft => draft.id); const claims = draftIds.length ? await optionalData(sb.from('pipeline_claims').select('id,claim,status,note,resolved_at,pipeline_claim_sources(document_id,discovered_documents(title,url))').in('draft_id', draftIds), 'claim ledger') : []; const meta = pipelineMetadata(candidate); const earlier = activeDrafts[1]; const bodyDiff = earlier ? lineDiff(earlier.body_markdown, current.body_markdown) : []; const materialization = materializationState(candidate, linkRows[0]); const phase2 = phase2Rows.filter(row => !activeRunId || row.pipeline_run_id === activeRunId); const phase2Review = phase2.find(row => row.stage === 'ai_review') || phase2[0] || null;
  const usedDocumentIds = new Set(claims.flatMap(claim => (claim.pipeline_claim_sources || []).map(link => link.document_id)).filter(Boolean));
  const sourceDetail = doc => { let domain = ''; try { domain = new URL(doc.canonical_url || doc.url).hostname; } catch {} const retention = doc.retention?.reason || 'retained for this candidate'; const publisher = doc.pipeline_sources?.name || domain || 'Unknown publisher'; const type = doc.pipeline_sources?.source_type || 'document'; const usage = usedDocumentIds.has(doc.id) ? 'used in final draft' : 'retained, not cited in final draft'; return `<div class="source-row"><div class="src-title">${sourceHref(doc.canonical_url || doc.url, doc.title || 'Source')}<span class="src-meta">${esc([publisher, type, retention, usage, doc.extraction_status || ''].filter(Boolean).join(' · '))}</span></div></div>`; };
  const clearedImage = image => image.rights_status === 'approved';
  const imageCards = activeImages.map(image => {
    const safeImage = mediaUrl(image.original_url);
    const cleared = clearedImage(image);
    return `<article class="review-image-card${image.selected ? ' is-selected' : ''}">
      ${safeImage ? `<a href="${esc(safeImage)}" target="_blank" rel="noreferrer"><img src="${esc(safeImage)}" alt="${esc(image.caption || 'Pipeline image candidate')}" loading="lazy"></a>` : ''}
      <div><p class="image-card-title">${esc(image.caption || 'Untitled image candidate')}</p><p class="field-note">${esc([image.creator, image.width && image.height ? `${image.width} × ${image.height}` : '', image.license_code || image.license].filter(Boolean).join(' · '))}</p><p><span class="stamp st-${esc(image.rights_status)}">${esc(humanize(image.rights_status))}</span></p><p class="field-note">${esc(image.rights_audit?.detail || 'No deterministic rights audit is available.')}</p>${(image.warning_flags || []).length ? `<p class="warning-count">${esc(image.warning_flags.join(' · '))}</p>` : ''}<button class="${image.selected ? '' : 'quiet'} compact-button" type="button" data-image-id="${esc(image.id)}" ${cleared ? '' : 'disabled'}>${image.selected ? 'Selected hero photo' : cleared ? 'Use as hero photo' : 'Rights clearance required'}</button></div>
    </article>`;
  }).join('');
  const advisoryChecks = [...(candidate.classification?.review_warnings || []).map(message => ({ kind: 'Evidence warning', message })), ...(candidate.classification?.revision_suggestions || []).map(message => ({ kind: 'Revision suggestion', message }))];
  const phase2Packet = phase2Review?.payload?.evidence_packet || phase2.find(row => row.stage === 'evidence_packet')?.payload?.evidence_packet || null;
  const phase2ReviewPayload = phase2Review?.payload?.review || {};
  const phase2Usage = phase2Review?.usage || [];
  const phase2Cost = phase2Review?.cost || null;
  const phase2Credits = phase2Usage.length ? phase2Usage.reduce((total, item) => total + (Number.isFinite(item.credits) ? item.credits : 0), 0) : null;
  const phase2UsdEstimate = phase2Cost && typeof phase2Cost === 'object' ? phase2Cost.estimated_cost_usd ?? null : null;
  const phase2Claims = phase2Review?.claims?.length ? phase2Review.claims : phase2Packet?.claims || [];
  const phase2Blockers = [...new Set([...(phase2Review?.payload?.blockers || []), ...(phase2ReviewPayload.deterministic_review?.blocking_factual_errors || [])].map(item => typeof item === 'string' ? item : item?.reason || JSON.stringify(item)))].filter(Boolean);
  const latestSolPolish = solPolishRows[0] || null;
  const isV1Review = [phase2Review?.pipeline_version, meta.pipelineVersion, candidate.classification?.pipeline_version].includes('v1');
  const phase2Models = [...new Set(phase2Usage.map(item => modelLabel(item.model, item.stage)).filter(Boolean))];
  const phase2CallCount = phase2Review?.payload?.provider_call_count ?? phase2Usage.length;
  const phase2DraftChecksum = phase2Review?.draft_input_sha256 || phase2Review?.payload?.draft_checksum || 'not recorded';
  const phase2PolishChecksum = latestSolPolish?.polish_checksum || 'not recorded';
  const phase2Observability = `Model usage: ${phase2Models.join(', ') || 'not recorded'} · external calls: ${phase2CallCount} · credits: ${phase2Credits ?? 'not recorded'} · USD estimate: ${phase2UsdEstimate ?? 'null'}`;
  const stageIndex = pipelineStageIndex({ candidateStatus: candidate.status, hasSources: activeDocuments.length > 0, hasPacket: Boolean(phase2Packet), hasDraft: Boolean(current.body_markdown), hasReview: Boolean(phase2Review), hasOnDeck: Boolean(materialization.storyId) });
  const stageMarkup = `<ol class="pipeline-stage-flow" aria-label="Editorial workflow">${PIPELINE_STAGE_LABELS.map((label, index) => `<li class="${index < stageIndex ? 'is-complete' : index === stageIndex ? 'is-current' : ''}"><span>${esc(label)}</span></li>`).join('')}</ol>`;
  const packetSourceById = new Map((phase2Packet?.sources || []).map(source => [source.source_id || source.id, source]));
  title('Review package'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>AI Review</span></div><h1>${esc(current.headline || candidate.title || 'Untitled')}</h1><p class="standfirst">${esc(current.dek || '')}</p></div>${deskNav(p, 'review')}<form id="pipeline-review" class="desk-form"><p class="notice form-message" data-form-message hidden></p><div class="editor-grid"><div><section class="editor-section"><h2>Article</h2><label>Headline<input name="headline" value="${esc(current.headline || candidate.title || '')}" required></label><label>Dek<textarea name="dek" class="textarea-short" required>${esc(current.dek || '')}</textarea></label><label>Body (Markdown)<textarea name="body_markdown" required>${esc(current.body_markdown || '')}</textarea></label><label>Primary Lens<input name="primary_section" value="${esc(meta.section)}" required></label><label>Beats<input name="beats" value="${esc(meta.beats.join(', '))}"></label><label>Tags<input name="tags" value="${esc(meta.tags.join(', '))}"></label><div class="form-actions"><button type="submit">Save editorial changes</button></div></section><details class="editor-section" open><summary>Sources</summary>${activeDocuments.map(sourceDetail).join('') || '<p class="field-note">No sources retained.</p>'}${claims.map(claim => `<div class="claim-row"><strong>${esc(claim.claim)}</strong><span class="stamp st-${esc(claim.status)}">${esc(humanize(claim.status))}</span><p>${esc(claim.note || '')}</p><p class="field-note">${(claim.pipeline_claim_sources || []).map(link => sourceHref(link.discovered_documents?.url, link.discovered_documents?.title)).join(' · ') || 'No source mapping'}</p></div>`).join('')}</details><details class="editor-section"><summary>Version diff</summary>${earlier ? `${earlier.headline !== current.headline ? `<pre class="version-diff">- Headline: ${esc(earlier.headline || '')}\n+ Headline: ${esc(current.headline || '')}</pre>` : ''}${earlier.dek !== current.dek ? `<pre class="version-diff">- Dek: ${esc(earlier.dek || '')}\n+ Dek: ${esc(current.dek || '')}</pre>` : ''}${bodyDiff.length ? `<pre class="version-diff">${bodyDiff.map(row => `${row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '} ${esc(row.text)}`).join('\n')}</pre>` : ''}${earlier.headline === current.headline && earlier.dek === current.dek && !bodyDiff.length ? '<p class="field-note">No content changes in this version.</p>' : ''}` : '<p class="field-note">No earlier draft is retained.</p>'}</details></div><div><section class="editor-section"><h2>Review</h2><p class="meta-line">Status: <span class="stamp st-${esc(candidate.status)}">${esc(humanize(candidate.status))}</span></p><p class="field-note">Publishing is unavailable here. Approval does not publish.</p><label>Revision instructions<textarea name="revision_notes" class="textarea-short" placeholder="Required when requesting revision."></textarea></label><div class="buttons review-actions"><button name="action" value="approve" type="button">Approve</button><button name="action" value="reject" type="button" class="danger-quiet">Reject</button><button name="action" value="revision" type="button" class="quiet">Request revision</button><button name="action" value="archive" type="button" class="quiet">Archive</button></div></section><details class="editor-section" open><summary>Pipeline progress</summary><p class="meta-line">Pipeline: ${esc(phase2Review?.pipeline_version || meta.pipelineVersion)} · state ${esc(meta.phase2State || candidate.status)}</p><p class="field-note">Frozen packet checksum: <code>${esc(phase2Review?.packet_checksum || meta.packetChecksum || 'not recorded')}</code></p>${phase2Review ? `<p class="field-note">Review status: ${esc(phase2ReviewPayload.status || 'ready_for_review')} · Cost: ${esc(phase2UsdEstimate ?? 'null')} · ${phase2Usage.length} model stage record${phase2Usage.length === 1 ? '' : 's'}</p><pre class="packet-data">${esc(JSON.stringify({ terra_summary: phase2ReviewPayload.terra_summary || null, deterministic_review: phase2ReviewPayload.deterministic_review || null, revision_findings: phase2ReviewPayload.revision_findings || null, revision_changes: phase2ReviewPayload.revision_changes || null, changes: phase2ReviewPayload.diff || [] }, null, 2))}</pre>` : '<p class="field-note">Phase 2 artifact details are not available yet.</p>'}</details><details class="editor-section"><summary>Advisory checks</summary>${advisoryChecks.map(check => `<div class="claim-row"><strong>${esc(check.kind)}</strong><p>${esc(check.message)}</p></div>`).join('') || '<p class="field-note">No automatic warnings. Editorial review is still required.</p>'}</details><details class="editor-section"><summary>Evidence packet</summary><pre class="packet-data">${esc(JSON.stringify(phase2Packet || packetRows[0]?.packet || {}, null, 2))}</pre><h3>Image candidates</h3>${activeImages.map(image => `<div class="claim-row">${sourceHref(image.original_url, image.caption || 'Image candidate')}<p><span class="stamp st-${esc(image.rights_status)}">${esc(humanize(image.rights_status))}</span> ${esc((image.warning_flags || []).join(', '))}</p></div>`).join('') || '<p class="field-note">No image candidates.</p>'}</details><details class="editor-section"><summary>Audit trail</summary>${decisions.map(decision => `<div class="revision-line"><span>${esc(humanize(decision.action))}</span><span>${esc(decision.profiles?.name || 'Editor')}</span><span>${dShort(decision.created_at)}</span><span>${esc(decision.note || '')}</span></div>`).join('') || '<p class="field-note">No review actions yet.</p>'}</details></div></div></form></div>`;
  const phase2Details = [...document.querySelectorAll('details')].find(item => item.querySelector('summary')?.textContent.trim() === 'Pipeline progress');
  if (phase2Details) {
    phase2Details.insertAdjacentHTML('afterbegin', `<p class="field-note">${esc(phase2Observability)}</p>`);
    const packetSources = (phase2Packet?.sources || []).map(source => `<div class="source-row"><div class="src-title">${sourceHref(source.url || source.canonical_url, source.title || source.source_id)}<span class="src-meta">${esc([source.source_id, source.classification, source.excerpt_characters ? `${source.excerpt_characters} chars` : ''].filter(Boolean).join(' · '))}</span></div><p class="field-note">${esc(source.excerpt || 'No excerpt retained.')}</p></div>`).join('') || '<p class="field-note">No frozen source excerpts are available.</p>';
    const claimsMarkup = phase2Claims.map(claim => `<div class="claim-row"><strong>${esc(claim.claim || claim.text || claim.claim_id)}</strong><span class="stamp st-${esc(claim.status || 'supported')}">${esc(humanize(claim.status || 'supported'))}</span><p class="field-note">${(claim.source_ids || []).map(sourceId => { const source = packetSourceById.get(sourceId) || {}; return sourceHref(source.url || source.canonical_url, `${source.title || sourceId}${source.publisher ? ` · ${source.publisher}` : ''}`); }).join(' · ') || 'No source mappings retained'}</p>${(claim.evidence || []).map(evidence => { const source = packetSourceById.get(evidence.source_id) || {}; return `<p class="field-note">${sourceHref(source.url || source.canonical_url, source.title || evidence.source_id)}: ${esc(evidence.excerpt || '')}</p>`; }).join('')}</div>`).join('') || '<p class="field-note">No claim ledger was retained.</p>';
    const artifactMarkup = phase2.map(row => `<details class="editor-section"><summary>${esc(humanize(row.stage))} artifact</summary><p class="field-note">Updated ${esc(row.updated_at || 'not recorded')} · checksum <code>${esc(row.packet_checksum || phase2Packet?.checksum || 'not recorded')}</code></p><pre class="packet-data">${esc(JSON.stringify(row.payload || {}, null, 2))}</pre></details>`).join('');
    const solMarkup = latestSolPolish ? `<h3>Sol copy polish</h3><p class="field-note">Status: ${esc(latestSolPolish.status)} · original checksum <code>${esc(latestSolPolish.draft_checksum)}</code> · polished checksum <code>${esc(latestSolPolish.polish_checksum)}</code></p><pre class="version-diff">${esc(lineDiff(latestSolPolish.original_body_markdown, latestSolPolish.polished_body_markdown).map(row => `${row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '} ${row.text}`).join('\n'))}</pre><details><summary>Structured changes</summary><pre class="packet-data">${esc(JSON.stringify(latestSolPolish.changes || [], null, 2))}</pre></details><div class="form-actions">${latestSolPolish.status === 'pending' ? '<button type="button" data-sol-action="accept">Accept Sol polish</button><button type="button" class="quiet" data-sol-action="reject">Reject Sol polish</button>' : '<button type="button" class="quiet" data-sol-action="restore">Restore original Draft</button>'}</div>` : '<p class="field-note">No manual Sol polish has been authorized.</p>';
    phase2Details.insertAdjacentHTML('beforeend', `<section class="phase2-readable"><h3>Claims and source support</h3>${claimsMarkup}<h3>Frozen source excerpts</h3>${packetSources}<h3>Blockers and human actions</h3>${phase2Blockers.length ? `<ul>${phase2Blockers.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : '<p class="field-note">No blocking findings were retained.</p>'}${solMarkup}${artifactMarkup}</section>`);
  }
  alignReviewSurface({ stageMarkup, observability: phase2Observability, sourceCount: phase2Packet?.sources?.length || 0, claimCount: phase2Claims.length, packetChecksum: phase2Review?.packet_checksum || meta.packetChecksum, draftChecksum: phase2DraftChecksum });
  document.querySelectorAll('#pipeline-review details').forEach(details => {
    const label = details.querySelector(':scope > summary')?.textContent.trim();
    if (['Pipeline progress', 'Version diff', 'Advisory checks', 'Evidence packet', 'Audit trail', 'Structured changes'].some(title => label?.startsWith(title))) {
      details.open = false;
    }
    if (label?.startsWith('Sources')) details.open = true;
  });
  const form = document.querySelector('#pipeline-review');
  const reviewPanel = document.querySelector('.review-actions')?.closest('.editor-section');
  if (reviewPanel) {
    if (isV1Review) {
      reviewPanel.querySelector('button[value="revision"]')?.remove();
      reviewPanel.querySelector('[name="revision_notes"]')?.closest('label')?.remove();
    }
    const explanation = reviewPanel.querySelector('.field-note');
    if (explanation) explanation.textContent = 'Approve moves this article to On Deck. It will remain private until you publish it now or schedule it.';
    const approveButton = reviewPanel.querySelector('button[value="approve"]');
    if (approveButton) approveButton.textContent = 'Approve for On Deck';
    const rejectButton = reviewPanel.querySelector('button[value="reject"]');
    if (rejectButton) rejectButton.textContent = 'Deny';
    if (candidate.status !== 'research_blocked' && phase2Review) reviewPanel.querySelector('.review-actions')?.insertAdjacentHTML('beforeend', '<button type="button" class="quiet" data-phase2-action="polish_with_sol">Polish with Sol</button>');
    if (candidate.status === 'research_blocked') reviewPanel.querySelectorAll('button[value="approve"], button[value="reject"], button[value="revision"], button[value="archive"]').forEach(button => button.remove());
  }
  document.querySelectorAll('[data-phase2-action]').forEach(button => button.onclick = async () => {
    const action = button.dataset.phase2Action;
    button.disabled = true;
    button.textContent = action === 'research_again' ? 'Starting research…' : 'Starting Sol polish…';
    try {
      const result = await pipelineRequest('/api/newsroom/pipeline/jobs', { job_type: 'polish_candidate', candidate_id: candidate.external_id, pipeline_version: 'v1', authorization: 'polish_with_sol' });
      if (!result?.job?.id) throw new Error('The Phase 2 authorization did not return a job ID.');
      location.href = jobHref(result.job);
    } catch (error) {
      button.disabled = false;
      button.textContent = action === 'research_again' ? 'Research again' : 'Polish with Sol';
      showFormMessage(form, error.message || 'The Phase 2 action could not be started.');
    }
  });
  document.querySelectorAll('[data-sol-action]').forEach(button => button.onclick = async () => {
    if (!latestSolPolish?.id) return;
    const action = button.dataset.solAction;
    button.disabled = true;
    button.textContent = action === 'accept' ? 'Accepting…' : action === 'reject' ? 'Rejecting…' : 'Restoring…';
    try {
      await pipelineRequest(`/api/newsroom/pipeline/sol-polish/${latestSolPolish.id}/${action}`, {});
      location.reload();
    } catch (error) {
      button.disabled = false;
      button.textContent = action === 'accept' ? 'Accept Sol polish' : action === 'reject' ? 'Reject Sol polish' : 'Restore original Draft';
      showFormMessage(form, error.message || 'The Sol polish action could not be recorded.');
    }
  });
  const imageHeading = [...document.querySelectorAll('h3')].find(heading => heading.textContent.trim() === 'Image candidates');
  if (imageHeading) {
    const researchPanel = imageHeading.closest('.editor-section');
    researchPanel?.querySelectorAll(':scope > .claim-row').forEach(row => row.remove());
    imageHeading.insertAdjacentHTML('afterend', imageCards
      ? `<p class="field-note">Choose one rights-cleared photo. The selected photo becomes the hero image when the article is approved.</p><div class="review-image-grid">${imageCards}</div>`
      : '<p class="field-note">No photo candidates were found for this article.</p>');
  }
  form.onsubmit = async event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    values.primary_section = document.querySelector('input[name="primary_section"]')?.dataset.internalLens || values.primary_section;
    const version = (current.version || 0) + 1;
    setBusy(form, true, 'Saving changes…');
    const { error } = await sb.from('pipeline_drafts').insert({ candidate_id: databaseCandidateId, pipeline_run_id: current.pipeline_run_id, version, headline: values.headline, dek: values.dek, body_markdown: values.body_markdown, prior_draft_id: current.id || null });
    if (error) { setBusy(form, false); return showFormMessage(form, error.message); }
    const { error: candidateError } = await sb.from('candidate_stories').update({ title: values.headline, classification: { ...(candidate.classification || {}), primary_section: values.primary_section, recurring_beats: values.beats.split(',').map(x => x.trim()).filter(Boolean), tags: values.tags.split(',').map(x => x.trim()).filter(Boolean) } }).eq('id', databaseCandidateId);
    if (candidateError) { setBusy(form, false); return showFormMessage(form, candidateError.message); }
    await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: 'edit', note: 'Editorial metadata or article updated.' });
    location.reload();
  };
  document.querySelectorAll('[data-image-id]').forEach(button => button.onclick = async () => {
    const imageId = button.dataset.imageId;
    document.querySelectorAll('[data-image-id]').forEach(control => { control.disabled = true; });
    const { error: clearError } = await sb.from('image_candidates').update({ selected: false }).eq('candidate_id', databaseCandidateId);
    const { error: selectError } = clearError ? { error: clearError } : await sb.from('image_candidates').update({ selected: true }).eq('id', imageId);
    if (selectError) {
      document.querySelectorAll('[data-image-id]').forEach(control => { control.disabled = false; });
      return showFormMessage(form, selectError.message);
    }
    await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: 'select_image', note: 'Selected a rights-cleared hero photo.' });
    location.reload();
  });
  document.querySelectorAll('.review-actions button').forEach(button => button.onclick = async () => {
    const action = button.value;
    const notes = form.revision_notes.value.trim();
    if (action === 'revision' && !notes) return showFormMessage(form, 'Revision instructions are required.');
    if (action === 'revision') {
      document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = true; });
      button.textContent = 'Starting revision…';
      try {
        const result = await pipelineRequest('/api/newsroom/pipeline/jobs', { job_type: 'process_candidate', candidate_id: candidate.external_id, authorization: 'run_revision', revision_instructions: notes });
        if (!result?.job?.id) throw new Error('The Phase 2 revision authorization did not return a job ID.');
        await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: 'request_revision', note: notes });
        location.href = jobHref(result.job);
      } catch (error) {
        document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = false; });
        button.textContent = 'Request revision';
        showFormMessage(form, error.message || 'The Phase 2 revision could not be started.');
      }
      return;
    }
    document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = true; });
    button.textContent = action === 'approve' ? 'Moving to On Deck…' : 'Recording decision…';
    if (action === 'approve') {
      const { data, error } = await sb.rpc('approve_pipeline_story', { p_candidate_id: databaseCandidateId });
      const result = Array.isArray(data) ? data[0] : data;
      if (error || !result?.story_id) {
        document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = false; });
        button.textContent = 'Approve for On Deck';
        return showFormMessage(form, error?.message || 'The article could not be moved to On Deck.');
      }
      location.href = `/newsroom/on-deck#story-${result.story_id}`;
      return;
    }
    const next = { reject: 'rejected_by_editor', revision: 'revision_requested', archive: 'archived' }[action];
    const { error } = await sb.from('candidate_stories').update({ status: next }).eq('id', databaseCandidateId);
    if (error) {
      document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = false; });
      return showFormMessage(form, error.message);
    }
    await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: action === 'revision' ? 'request_revision' : action, note: notes || null });
    location.href = '/newsroom/review';
  });
  bindSignOut();
  const reviewActions = document.querySelector('.review-actions');
  if (reviewActions && materialization.action === 'open') {
    const materialize = document.createElement('div');
    materialize.className = 'form-actions';
    materialize.innerHTML = `<a class="text-link" href="/newsroom/${esc(materialization.storyId)}">Open On Deck article</a><p class="field-note">This package is already linked to its editorial article.</p>`;
    reviewActions.before(materialize);
  }
}

function onDeckMetadata(rows) {
  return '<dl class="on-deck-metadata">' + rows.map(row => '<div><dt>' + esc(row.label) + '</dt><dd>' + row.value + '</dd></div>').join('') + '</dl>';
}

async function onDeck(p = null) {
  p = p || await profile();
  if (!p) return location.href = '/newsroom';
  const [stories, candidates, jobs, links, mediaLinks] = await Promise.all([
    optionalData(sb.from('stories').select('id,title,slug,dek,status,scheduled_for,published_at,created_at,updated_at,revision_number,editor_id,article_length,editorial_score,local_editorial_score,luna_decision,origin,promotion_level,hero_media_id,hero_media_state,hero_media_manual_override,sections!stories_section_id_fkey(name),story_beats(beat_id),story_tags(tags(name)),sources(id)').in('status', ['fact_check', 'scheduled']).order('scheduled_for', { ascending: true, nullsFirst: true }).order('updated_at', { ascending: false }), 'on deck stories'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,model,created_at,updated_at,canonical_url').not('status', 'in', '(archived,rejected_by_editor)'), 'on deck candidates'),
    optionalData(sb.from('pipeline_jobs').select('id,job_type,parameters,status,attempt_count,max_attempts,created_at,started_at,finished_at,result,error,pipeline_candidate_id').order('created_at', { ascending: false }).limit(250), 'on deck jobs'),
    optionalData(sb.from('pipeline_story_links').select('candidate_id,story_id'), 'on deck story links'),
    optionalData(sb.from('media_asset_story_links').select('story_id,asset_id,role,selected,usage_scope,selection_method,selection_score,selection_rationale,evidence_relationship,selected_at,overridden_at,overridden_by,media_assets(id,original_url,cached_url,source_page_url,attribution_text,alt_text,rights_basis,status,cache_state,error,width,height,metadata)').order('selected', { ascending: false }), 'on deck media links')
  ]).then(values => [values[0] || [], values[1], values[2], values[3], values[4]]);
  title('On Deck');
  const storyByCandidate = new Map(links.map(link => [link.candidate_id, stories.find(story => story.id === link.story_id)]));
  const mediaByStory = new Map();
  mediaLinks.forEach(link => { const list = mediaByStory.get(link.story_id) || []; list.push(link); mediaByStory.set(link.story_id, list); });
  const work = candidates.map(candidate => ({ candidate, story: storyByCandidate.get(candidate.id) || null, job: jobForCandidate(candidate, jobs) })).map(item => ({ ...item, status: editorialStatusFor(item.candidate, item.story, item.job) })).filter(item => ['processing', 'writing', 'draft', 'needs_attention', 'ready', 'failed', 'commissioned'].includes(item.status));
  const cards = stories.map(story => {
    const scheduled = story.status === 'scheduled';
    const scheduleValue = story.scheduled_for ? localDateTimeValue(story.scheduled_for) : '';
    const tags = (story.story_tags || []).map(item => item.tags?.name).filter(Boolean);
    const storyMedia = mediaByStory.get(story.id) || [];
    const heroLink = storyMedia.find(item => item.selected && item.role === 'hero');
    const alternateLinks = storyMedia.filter(item => !item.selected && item.role === 'inline_candidate');
    const evidenceLinks = storyMedia.filter(item => item.role === 'evidence');
    const mediaSummary = storyMedia.length ? ` · Source media: ${storyMedia.length} linked${heroLink ? ' · hero selected' : ' · Hero needed'}` : ' · Hero needed';
    const mediaRecord = item => {
      const asset = item.media_assets || {};
      const source = asset.source_page_url ? sourceHref(asset.source_page_url, asset.source_page_url) : esc(asset.original_url || item.asset_id);
      return `<div class="on-deck-media-record"><p class="field-note">${source} · ${esc(asset.rights_basis || 'unknown')} · ${esc(item.role || item.usage_scope || 'evidence')} · cache ${esc(asset.cache_state || 'pending')}${asset.width && asset.height ? ` · ${esc(asset.width)} × ${esc(asset.height)}` : ' · dimensions unknown'}</p><p class="field-note">${esc(asset.attribution_text || 'Attribution pending')}${item.selection_rationale ? ` · ${esc(item.selection_rationale)}` : ''}${item.selection_score !== null && item.selection_score !== undefined ? ` · selection score ${esc(item.selection_score)}` : ''}</p><div class="form-actions"><label>Alt text<input type="text" maxlength="500" value="${esc(asset.alt_text || '')}" data-story-media-alt="${esc(item.asset_id)}"></label><label>Attribution<input type="text" maxlength="500" value="${esc(asset.attribution_text || '')}" data-story-media-attribution="${esc(item.asset_id)}"></label><button type="button" class="quiet compact-button" data-story-media-save="${esc(item.asset_id)}">Save media text</button><button type="button" class="danger-quiet compact-button" data-story-media-block="${esc(item.asset_id)}">Block asset</button></div></div>`;
    };
    const mediaControls = story.origin === 'automated' ? `<section class="on-deck-story-media"><p class="field-note"><strong>${heroLink ? 'Selected hero' : 'Hero needed'}</strong>${heroLink ? ` · ${esc(heroLink.selection_method || 'automated')} · ${esc(heroLink.media_assets?.attribution_text || 'Attribution pending')}` : ' · No safe directly relevant hero was selected.'}</p><div class="form-actions"><button type="button" class="quiet compact-button" data-story-hero-action="needed" data-story-id="${esc(story.id)}">${heroLink ? 'Remove hero' : 'Mark Hero needed'}</button>${alternateLinks.length ? `<label>Select alternate eligible media<select data-story-hero-select="${esc(story.id)}"><option value="">Choose an eligible alternate</option>${alternateLinks.map(item => `<option value="${esc(item.asset_id)}">${esc(item.media_assets?.attribution_text || item.asset_id)} · ${esc(item.media_assets?.width || '—')}×${esc(item.media_assets?.height || '—')}</option>`).join('')}</select></label><button type="button" class="quiet compact-button" data-story-hero-select-submit="${esc(story.id)}">Use selected alternate</button>` : ''}</div>${heroLink ? mediaRecord(heroLink) : ''}${alternateLinks.length ? `<details><summary>Alternate eligible media · ${alternateLinks.length}</summary>${alternateLinks.map(mediaRecord).join('')}</details>` : ''}${evidenceLinks.length ? `<details><summary>Evidence-only media · ${evidenceLinks.length}</summary>${evidenceLinks.map(mediaRecord).join('')}</details>` : ''}</section>` : '';
    const metadata = onDeckMetadata([
      { label: 'Status / Section / Length', value: `<span class="stamp st-${esc(story.status)}">${esc(workflowLabel(story.status))}</span> · ${esc(story.sections?.name || 'Section pending')} · ${esc(story.article_length || 'standard')} · score ${esc(story.local_editorial_score ?? story.editorial_score ?? '—')}/10${story.luna_decision ? ` · Luna ${esc(story.luna_decision)}` : ''}` },
      { label: 'Dates / Origin', value: `${scheduled ? `Publishes ${esc(dDateTime(story.scheduled_for))} · ` : ''}Created ${esc(dShort(story.created_at))} · Updated ${esc(dShort(story.updated_at))} · ${esc(story.origin === 'automated' ? 'automated Luna' : story.origin === 'commissioned' ? 'commissioned idea' : 'manual idea')}` },
      { label: 'Sources / Media', value: `Topics: ${esc(tags.join(', ') || 'None')} · ${story.sources?.length || 0} source${story.sources?.length === 1 ? '' : 's'} ${story.sources?.length ? 'retained' : 'missing'} · ${heroLink ? 'Hero selected' : 'Hero needed'}${mediaSummary}` }
    ]);
    return `<article class="on-deck-card" id="story-${esc(story.id)}">
      <div class="on-deck-copy">${metadata}<h2><a href="/newsroom/${esc(story.id)}">${esc(story.title || 'Untitled story')}</a></h2><p>${esc(story.dek || '')}</p>${mediaControls}<p class="form-actions"><a class="button quiet" href="/newsroom/${esc(story.id)}">Edit</a><a class="button quiet" href="/newsroom/${esc(story.id)}#article-preview">Preview</a></p></div>
      <form class="on-deck-actions" data-story-id="${esc(story.id)}"><p class="notice form-message" data-form-message hidden></p><button type="button" data-publish>Publish now</button><div class="schedule-row"><label for="schedule-${esc(story.id)}">Or schedule</label><input id="schedule-${esc(story.id)}" name="scheduled_for" type="datetime-local" value="${esc(scheduleValue)}" min="${esc(localDateTimeValue(Date.now() + 60000))}"><button type="button" class="quiet" data-schedule>${scheduled ? 'Reschedule' : 'Schedule'}</button></div>${scheduled ? '<button type="button" class="quiet compact-button" data-unschedule>Return to On Deck</button>' : ''}<button type="button" class="quiet compact-button" data-archive>Reject/archive</button>${['admin', 'editor'].includes(p.role) ? `<label class="inline-check"><input type="checkbox" data-queue-select data-queue-kind="story" value="${esc(story.id)}"> Select to delete</label><button type="button" class="danger-quiet compact-button" data-delete-queue-item="${esc(story.id)}" data-queue-kind="story">Delete permanently</button>` : ''}</form>
    </article>`;
  }).join('');
  const workCards = work.map(({ candidate, story, job, status }) => {
    const metadata = onDeckMetadata([
      { label: 'Status / Section / Length', value: `<span class="stamp st-${esc(status)}">${esc(editorialStatusLabel(status))}</span> · ${esc(sectionLabel(candidate.classification?.primary_section) || 'Section pending')} · ${esc(lengthDisplay({ candidate, job }) || 'standard')} · score ${esc(candidate.classification?.editorial_score ?? '—')}/10` },
      { label: 'Dates / Origin', value: `Created ${esc(dShort(candidate.created_at))} · Updated ${esc(dShort(candidate.updated_at))} · ${status === 'commissioned' ? 'commissioned idea' : 'automated'}` },
      { label: 'Sources / Media', value: `Source confidence: ${esc(candidate.classification?.confidence ?? 'pending')} · Hero media: ${story?.hero_media_id ? 'selected' : 'pending'}` }
    ]);
    return `<article class="on-deck-card" id="candidate-${esc(candidate.id)}"><div class="on-deck-copy">${metadata}<h2>${story ? `<a href="/newsroom/${esc(story.id)}">${esc(story.title || candidate.title || 'Untitled story')}</a>` : esc(candidate.title || 'Untitled work')}</h2><p>${esc(candidate.classification?.dek || candidate.classification?.editorial_pitch?.lens || '')}</p>${job?.error ? `<p class="field-note">Error: ${esc(concisePipelineError(job.error))}</p>` : ''}</div><div class="on-deck-actions">${story ? `<a class="button quiet" href="/newsroom/${esc(story.id)}">Open</a>` : ''}${storyPrimaryAction({ status, story, job, candidate })}${job?.status === 'failed' && job.id ? `<button type="button" class="quiet compact-button" data-retry-job="${esc(job.id)}">Retry</button>` : ''}${['admin', 'editor'].includes(p.role) ? `<label class="inline-check"><input type="checkbox" data-queue-select data-queue-kind="candidate" value="${esc(candidate.id)}"> Select to delete</label><button type="button" class="danger-quiet compact-button" data-delete-queue-item="${esc(candidate.id)}" data-queue-kind="candidate">Delete permanently</button>` : ''}</div></article>`;
  }).join('');
  const deletionToolbar = ['admin', 'editor'].includes(p.role) ? '<div class="form-actions"><label class="inline-check"><input type="checkbox" data-queue-select-all> Select all</label><span class="field-note" data-queue-selection-count>0 selected</span><button type="button" class="danger-quiet compact-button" data-delete-selected-queue disabled>Delete selected</button></div>' : '';
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div><h1>On Deck</h1><p class="standfirst">Completed articles wait here for editorial review. Processing, needs-attention, and failed work remain visible until they are resolved.</p></div>${deskNav(p, 'on-deck')}<section class="desk-section"><div class="section-head"><div><span class="label">Ready to release</span><h2>${stories.length} article${stories.length === 1 ? '' : 's'}</h2></div><a class="button" href="/newsroom/new">Write an article</a></div>${deletionToolbar}<div class="on-deck-list">${cards || '<p class="empty-note">Nothing is ready to release.</p>'}</div></section><section class="desk-section"><div class="section-head"><div><span class="label">In progress</span><h2>${work.length} item${work.length === 1 ? '' : 's'}</h2></div><p class="field-note">Automated work stays in the same review surface as manual ideas.</p></div><div class="on-deck-list">${workCards || '<p class="empty-note">No processing or attention items.</p>'}</div></section></div>`;
  document.querySelectorAll('[data-delete-queue-item]').forEach(button => {
    const container = button.closest('.on-deck-actions');
    const checkbox = container?.querySelector('[data-queue-select]')?.closest('label');
    if (!container || !checkbox) return;
    const details = document.createElement('details');
    details.className = 'destructive-actions';
    details.innerHTML = '<summary>Permanent deletion</summary><p class="field-note">For records that should never return to the queue.</p>';
    details.append(checkbox, button);
    container.append(details);
  });
  const bulkDelete = document.querySelector('[data-delete-selected-queue]');
  const bulkToolbar = bulkDelete?.closest('.form-actions');
  if (bulkToolbar) {
    const details = document.createElement('details');
    details.className = 'destructive-actions bulk-destructive-actions';
    details.innerHTML = '<summary>Permanent deletion</summary><p class="field-note">Select records, then use the guarded bulk deletion.</p>';
    bulkToolbar.before(details);
    details.append(bulkToolbar);
  }
  bindSignOut();
  const byId = new Map(stories.map(story => [story.id, story]));
  const transition = async (form, status, scheduledFor = null) => {
    const story = byId.get(form.dataset.storyId);
    if (!story) return;
    showFormMessage(form, '');
    form.querySelectorAll('button, input').forEach(control => { control.disabled = true; });
    const patch = { status, scheduled_for: scheduledFor };
    if (status === 'published') patch.published_at = new Date().toISOString();
    const { error } = await sb.rpc('save_story', {
      p_story_id: story.id,
      p_expected_revision: Number(story.revision_number || 1),
      p_patch: patch,
      p_beat_ids: (story.story_beats || []).map(item => item.beat_id),
      p_tags: (story.story_tags || []).map(item => item.tags?.name).filter(Boolean)
    });
    if (error) {
      form.querySelectorAll('button, input').forEach(control => { control.disabled = false; });
      showFormMessage(form, status === 'published'
        ? 'This article is not publish-ready. Open it and confirm the editor, section, metadata, and at least one valid source.'
        : error.message);
      return;
    }
    location.reload();
  };
  document.querySelectorAll('.on-deck-actions').forEach(form => {
    form.querySelector('[data-publish]')?.addEventListener('click', () => transition(form, 'published'));
    form.querySelector('[data-schedule]')?.addEventListener('click', () => {
      const value = form.querySelector('[name="scheduled_for"]')?.value;
      const scheduledFor = value ? new Date(value) : null;
      if (!scheduledFor || Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) return showFormMessage(form, 'Choose a future date and time.');
      transition(form, 'scheduled', scheduledFor.toISOString());
    });
    form.querySelector('[data-unschedule]')?.addEventListener('click', () => transition(form, 'fact_check'));
    form.querySelector('[data-archive]')?.addEventListener('click', () => transition(form, 'hidden'));
  });
  const selectedQueueItems = () => [...document.querySelectorAll('[data-queue-select]:checked')];
  const selectionCount = document.querySelector('[data-queue-selection-count]');
  const deleteSelectedButton = document.querySelector('[data-delete-selected-queue]');
  const selectAll = document.querySelector('[data-queue-select-all]');
  const updateQueueSelection = () => {
    const selected = selectedQueueItems();
    if (selectionCount) selectionCount.textContent = `${selected.length} selected`;
    if (deleteSelectedButton) deleteSelectedButton.disabled = selected.length === 0;
    if (selectAll) { const inputs = document.querySelectorAll('[data-queue-select]'); selectAll.checked = inputs.length > 0 && selected.length === inputs.length; selectAll.indeterminate = selected.length > 0 && selected.length < inputs.length; }
  };
  const deleteQueueItems = async items => {
    if (!items.length) return;
    const storyIds = items.filter(item => item.dataset.queueKind === 'story').map(item => item.value);
    const candidateIds = items.filter(item => item.dataset.queueKind === 'candidate').map(item => item.value);
    const confirmation = window.prompt(`This permanently deletes ${items.length} selected newsroom item${items.length === 1 ? '' : 's'} and any linked unpublished article. Published or scheduled stories are preserved and detached from stale queue records. Type DELETE NEWSROOM ITEMS to continue.`);
    if (confirmation !== 'DELETE NEWSROOM ITEMS') return;
    const { error } = await sb.rpc('delete_newsroom_queue_items', { p_story_ids: storyIds, p_candidate_ids: candidateIds, p_confirmation: confirmation });
    if (error) return window.alert(error.message || 'The selected newsroom items could not be deleted.');
    location.reload();
  };
  document.querySelectorAll('[data-queue-select]').forEach(input => input.addEventListener('change', updateQueueSelection));
  selectAll?.addEventListener('change', () => { document.querySelectorAll('[data-queue-select]').forEach(input => { input.checked = selectAll.checked; }); updateQueueSelection(); });
  deleteSelectedButton?.addEventListener('click', () => deleteQueueItems(selectedQueueItems()));
  document.querySelectorAll('[data-delete-queue-item]').forEach(button => button.addEventListener('click', () => deleteQueueItems([{ value: button.dataset.deleteQueueItem, dataset: { queueKind: button.dataset.queueKind } }])));
  document.querySelectorAll('[data-retry-job]').forEach(button => button.addEventListener('click', async () => { button.disabled = true; try { await pipelineRequest(`/api/newsroom/pipeline/jobs/${button.dataset.retryJob}/retry`, { priority: 50 }); location.reload(); } catch (error) { button.disabled = false; window.alert(error.message || 'The failed generation could not be retried.'); } }));
  document.querySelectorAll('[data-story-hero-action]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await pipelineRequest(`/api/newsroom/media-assets/stories/${button.dataset.storyId}/hero`, { action: button.dataset.storyHeroAction });
      location.reload();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || 'The story hero could not be changed.');
    }
  }));
  document.querySelectorAll('[data-story-hero-select-submit]').forEach(button => button.addEventListener('click', async () => {
    const select = document.querySelector(`[data-story-hero-select="${button.dataset.storyHeroSelectSubmit}"]`);
    if (!select?.value) return window.alert('Choose an eligible alternate first.');
    button.disabled = true;
    try {
      await pipelineRequest(`/api/newsroom/media-assets/stories/${button.dataset.storyHeroSelectSubmit}/hero`, { action: 'select', asset_id: select.value });
      location.reload();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || 'The alternate hero could not be selected.');
    }
  }));
  document.querySelectorAll('[data-story-media-save]').forEach(button => button.addEventListener('click', async () => {
    const card = button.closest('.on-deck-media-record');
    const story = button.closest('[data-story-id]') || button.closest('.on-deck-card');
    const storyId = story?.dataset.storyId || button.closest('.on-deck-card')?.id?.replace(/^story-/, '');
    if (!storyId) return;
    button.disabled = true;
    try {
      await pipelineRequest(`/api/newsroom/media-assets/stories/${storyId}/assets/${button.dataset.storyMediaSave}`, { action: 'edit', alt_text: card.querySelector(`[data-story-media-alt="${button.dataset.storyMediaSave}"]`)?.value || '', attribution_text: card.querySelector(`[data-story-media-attribution="${button.dataset.storyMediaSave}"]`)?.value || '' });
      location.reload();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || 'Media text could not be saved.');
    }
  }));
  document.querySelectorAll('[data-story-media-block]').forEach(button => button.addEventListener('click', async () => {
    const story = button.closest('.on-deck-card');
    const storyId = story?.id?.replace(/^story-/, '');
    if (!storyId || !window.confirm('Block this media asset from the story?')) return;
    button.disabled = true;
    try {
      await pipelineRequest(`/api/newsroom/media-assets/stories/${storyId}/assets/${button.dataset.storyMediaBlock}`, { action: 'block' });
      location.reload();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message || 'The media asset could not be blocked.');
    }
  }));
}

/* ---------- Story editor ---------- */

async function edit(id) {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  const [sections, beats, editors, authors, record, sourceRows, presentationRows, mediaRows, pipelineLinks] = await Promise.all([
    dataOf(sb.from('sections').select('id,name,slug,template').order('name'), 'editor sections'),
    dataOf(sb.from('beats').select('id,name,slug').order('name'), 'editor beats'),
    dataOf(sb.from('profiles').select('id,name,role').in('role', ['admin', 'editor']).order('name'), 'responsible editors'),
    dataOf(sb.from('profiles').select('id,name,role').order('name'), 'story authors'),
    id
      ? dataOf(
        sb.from('stories').select('id,title,slug,dek,summary,body,section_id,author_id,editor_id,status,published_at,scheduled_for,updated_at,reading_time_minutes,article_length,editorial_score,local_editorial_score,luna_decision,origin,promotion_level,hero_media_id,seo_title,seo_description,social_title,social_description,revision_number,story_sections(section_id),story_beats(beat_id),story_tags(tags(name))').eq('id', id).maybeSingle(),
        'story editor'
      )
      : Promise.resolve({
        title: '', slug: '', dek: '', summary: '', body: '', section_id: SECTION_ORDER[0],
        author_id: p.id, editor_id: p.role === 'contributor' ? null : p.id,
        status: 'idea', published_at: null, scheduled_for: null,
        seo_title: '', seo_description: '', revision_number: 1, article_length: 'standard', editorial_score: null, promotion_level: 'none', story_sections: [], story_beats: [], story_tags: []
      }),
    id
      ? dataOf(
        sb.from('sources').select('id,title,publisher,url,source_type,sort_order').eq('story_id', id).order('sort_order'),
        'editor sources'
      )
      : Promise.resolve([]),
    id ? optionalColumn(sb.from('stories').select('presentation').eq('id', id).limit(1)) : Promise.resolve([]),
    id
      ? optionalData(sb.from('media').select('id,public_url,filename,mime_type,alt_text,caption,credit,width,height,source_url,rights_status,rights_note,rights_basis,rights_details,editorial_approved,rights_override_approved_at,provider,source_page_url,original_file_url,creator,license_code,license_url,credit_line,commercial_use_allowed,modification_allowed,verification_method,verification_timestamp,source_metadata,rights_audit,created_at,story_id').eq('story_id', id).order('created_at', { ascending: false }), 'article media')
      : Promise.resolve([]),
    id ? optionalData(sb.from('pipeline_story_links').select('candidate_id').eq('story_id', id).limit(1), 'pipeline story link') : Promise.resolve([])
  ]);
  const s = record;
  if (!s) { title('Not found'); return app.innerHTML = notFound(); }
  const chosen = new Set(s.story_beats?.map(x => x.beat_id));
  const chosenSecondarySections = new Set((s.story_sections || []).map(item => item.section_id));
  const existingTags = (s.story_tags || []).map(x => x.tags?.name).filter(Boolean).join(', ');
  const safeSources = (sourceRows || []).map(source => ({ ...source, safe_url: externalUrl(source.url) }));
  const linkedCandidateId = pipelineLinks[0]?.candidate_id || null;
  const [revisionRows, decisionRows, activityJobs, pipelineSourceRows, pipelineDraftRows, linkedCandidate, phase2Rows, lunaArticleRows] = await Promise.all([
    id ? optionalData(sb.from('revisions').select('id,revision_number,change_note,created_at,profiles(name)').eq('story_id', id).order('created_at', { ascending: false }), 'story revisions') : Promise.resolve([]),
    linkedCandidateId ? optionalData(sb.from('pipeline_review_decisions').select('id,action,note,created_at,profiles(name)').eq('candidate_id', linkedCandidateId).order('created_at', { ascending: false }), 'story review activity') : Promise.resolve([]),
    linkedCandidateId ? optionalData(sb.from('pipeline_jobs').select('id,job_type,parameters,status,error,result,created_at,started_at,finished_at').eq('pipeline_candidate_id', linkedCandidateId).order('created_at', { ascending: false }), 'story writer activity') : Promise.resolve([]),
    linkedCandidateId ? optionalData(sb.from('discovered_documents').select('id,title,url,canonical_url,extraction_status,fetched_at').eq('candidate_id', linkedCandidateId).order('created_at'), 'retained story sources') : Promise.resolve([]),
    linkedCandidateId ? optionalData(sb.from('pipeline_drafts').select('id,version,pipeline_claims(id,claim,status,note,resolved_at)').eq('candidate_id', linkedCandidateId).order('version', { ascending: false }), 'story claim ledger') : Promise.resolve([]),
    linkedCandidateId ? optionalData(sb.from('candidate_stories').select('id,external_id,status,classification').eq('id', linkedCandidateId).maybeSingle(), 'linked pipeline candidate') : Promise.resolve(null),
    linkedCandidateId ? optionalData(sb.from('pipeline_phase2_artifacts').select('pipeline_run_id,stage,payload,updated_at').eq('candidate_id', linkedCandidateId).order('updated_at', { ascending: false }), 'story execution timeline') : Promise.resolve([]),
    id ? optionalData(sb.from('luna_article_attempts').select('id,editorial_candidate_id,decision_attempt_id,evidence_packet_id,job_id,status,outcome,model,prompt_version,headline,dek,body_markdown,word_count,article_length,story_id,created_at,completed_at,luna_claims(id,evidence_id,claim_text,source_url,evidence_span,status,source_event_id)').eq('story_id', id).order('created_at', { ascending: false }).limit(1), 'Luna article evidence') : Promise.resolve([])
  ]);
  const pipelineImages = linkedCandidateId
    ? await optionalData(
      sb.from('image_candidates').select('id,candidate_id,original_url,source_page,creator,caption,license,rights_status,rights_note,rights_basis,rights_details,editorial_approved,rights_override_approved_at,rights_source_url,provider,source_page_url,original_file_url,license_code,license_url,credit_line,commercial_use_allowed,modification_allowed,verification_method,verification_timestamp,source_metadata,rights_audit,warning_flags,width,height,file_type,selected').eq('candidate_id', linkedCandidateId).order('created_at'),
      'article pipeline images'
    )
    : [];
  const validSourceCount = safeSources.filter(source => source.safe_url).length;
  const editorStatuses = statuses.filter(status => !['fact_check', 'scheduled', 'published'].includes(status));
  if (['fact_check', 'scheduled', 'published'].includes(s.status)) editorStatuses.push(s.status);
  if (s.status === 'fact_check') editorStatuses.push('scheduled');
  const availableStatuses = p.role === 'contributor'
    ? ['idea', 'researching', 'draft', 'review']
    : editorStatuses;
  const assignedEditor = (editors || []).find(editor => editor.id === s.editor_id);
  const assignedAuthor = (authors || []).find(author => author.id === s.author_id);
  const editorialStatus = deriveEditorialStatus({ story: s });
  const latestWriterJob = activityJobs[0] || null;
  const pipelineClaims = (pipelineDraftRows || []).flatMap(draft => (draft.pipeline_claims || []).map(claim => ({ ...claim, version: draft.version })));
  const unresolvedPipelineClaims = pipelineClaims.filter(claim => !['resolved', 'supported', 'verified'].includes(String(claim.status || '').toLowerCase()));
  const lunaArticle = lunaArticleRows?.[0] || null;
  const lunaEvidenceMarkup = lunaArticle ? `<details class="editor-section" open><summary>Luna evidence and claims</summary><p class="field-note">Model ${esc(lunaArticle.model || 'unknown')} · ${esc(lunaArticle.article_length || 'standard')} · ${esc(lunaArticle.word_count || '—')} words · outcome ${esc(lunaArticle.outcome || lunaArticle.status || 'unknown')}</p>${(lunaArticle.luna_claims || []).map(claim => `<div class="claim-row"><strong>${esc(claim.claim_text)}</strong><span class="stamp st-${esc(claim.status || 'supported')}">${esc(humanize(claim.status || 'supported'))}</span><p class="field-note">Source: ${sourceHref(claim.source_url, claim.source_url)} · Event ${esc(claim.source_event_id || 'not recorded')}</p><p>${esc(claim.evidence_span)}</p></div>`).join('') || '<p class="field-note">No claim-level evidence retained.</p>'}</details>` : '';
  const featuredImage = (mediaRows || []).find(item => item.id === s.hero_media_id) || (pipelineImages || []).find(item => item.selected);
  const featuredImageLabel = featuredImage?.caption || featuredImage?.alt_text || featuredImage?.creator || featuredImage?.title || 'Selected image';
  const cleanupMarkup = disposableCleanupMarkup({ candidate: linkedCandidate, story: s, profile: p });
  const activityItems = [
    ...(s.created_at ? [{ at: s.created_at, kind: 'Discovery', note: 'Story entered the newsroom record.', actor: 'Newsroom' }] : []),
    ...(revisionRows || []).map(row => ({ at: row.created_at, kind: `Revision ${row.revision_number}`, note: row.change_note || 'Editorial revision saved.', actor: row.profiles?.name || 'Editor' })),
    ...(decisionRows || []).map(row => ({ at: row.created_at, kind: humanize(row.action), note: row.note || 'Pipeline review action recorded.', actor: row.profiles?.name || 'Editor' })),
    ...(activityJobs || []).map(row => ({ at: row.finished_at || row.started_at || row.created_at, kind: humanize(row.job_type), note: row.error?.message || `Writer job ${row.status}.`, actor: 'Controller' })),
    ...(s.published_at ? [{ at: s.published_at, kind: 'Published', note: 'Story was published.', actor: 'Newsroom' }] : [])
  ].filter(item => item.at).sort((a, b) => new Date(b.at) - new Date(a.at));
  const activityMarkup = activityItems.length
    ? activityItems.map(item => `<div class="activity-row"><span class="activity-date">${esc(dDateTime(item.at))}</span><strong>${esc(item.kind)}</strong><span>${esc(item.note)}</span><span class="field-note">${esc(item.actor)}</span></div>`).join('')
    : '<p class="field-note">Discovery, commission, writer, revision, and publication events will appear here.</p>';
  const latestPhase2PayloadByRun = new Map();
  for (const row of phase2Rows || []) if (!latestPhase2PayloadByRun.has(row.pipeline_run_id)) latestPhase2PayloadByRun.set(row.pipeline_run_id, row.payload || {});
  const timelineRows = [...latestPhase2PayloadByRun.values()].flatMap(payload => executionTimeline({ attempts: payload.phase2_attempts || [], events: payload.run_events || [] }));
  const timelineMarkup = timelineRows.length
    ? timelineRows.map(row => `<div class="activity-row execution-event"><span class="activity-date">${esc(row.timestamp ? dDateTime(row.timestamp) : 'Not recorded')}</span><strong>${esc(humanize(row.stage))} · ${esc(row.status)}</strong><span>${esc(row.result || '')}${row.duration_ms === null ? '' : ` · ${Math.round(row.duration_ms)} ms`} · attempt ${row.attempt}</span><details><summary>Diagnostics</summary><pre class="packet-data">${esc(JSON.stringify(row.diagnostics, null, 2))}</pre></details></div>`).join('')
    : '<p class="field-note">No retained execution stages are available for this story.</p>';
  title(`${id ? 'Edit' : 'New'} story`);
  app.innerHTML = `<div class="desk">
  <div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${id ? `Editing · ${esc(s.slug)}` : 'New story'}</span></div><h1>${id ? 'Edit story' : 'New story'}</h1></div>
  ${deskNav(p, id ? '' : 'new')}
  <nav class="story-tab-nav" aria-label="Story editor"><a href="#article" aria-current="page">Article</a><a href="#sources">Media</a>${id ? '<a href="#sources-list">Sources</a>' : ''}<a href="#publish">Publishing</a>${id ? '<a href="#activity">Activity</a>' : ''}<button type="button" class="quiet compact-button" data-open-article-preview>Preview</button></nav>
  <form id="story" class="desk-form" novalidate>
  <p class="notice form-message" data-form-message role="alert" hidden></p>
  <div class="editor-grid">
    <div>
      <section class="editor-section" id="article">
        <h2>Article</h2>
        <label for="story-title">Title</label><input id="story-title" name="title" maxlength="180" value="${esc(s.title)}" placeholder="Title" required>
        <label for="story-dek">Dek</label><textarea id="story-dek" class="textarea-short" name="dek" maxlength="320" placeholder="One clear sentence that earns the click." required>${esc(s.dek)}</textarea>
        <label for="story-summary">Summary</label><textarea id="story-summary" class="textarea-short" name="summary" maxlength="600" placeholder="The brief readers should carry away.">${esc(s.summary)}</textarea>
        <label for="story-section">Primary Section</label><select id="story-section" name="section_id" required>${(sections || []).map(x => `<option value="${x.id}" ${x.id === s.section_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <p class="field-note">${esc(EDITORIAL_CLASSIFICATION_HELP)}</p>
        <p class="field-note" id="section-question">${esc(promises[s.section_id] || '')}</p>
        <fieldset class="topic-fieldset"><legend>Additional sections</legend><div class="topic-checks">${(sections || []).map(section => `<label><input type="checkbox" name="secondary_section" value="${esc(section.id)}" ${chosenSecondarySections.has(section.id) ? 'checked' : ''}> ${esc(section.name)}</label>`).join('')}</div><p class="field-note">These are additional archive placements. The primary section above remains the article’s prominent classification.</p></fieldset>
        <div class="secondary-fields">
          <label for="story-article-length">Article length (internal)<select id="story-article-length" name="article_length">${ARTICLE_LENGTHS.map(length => `<option value="${length.id}" ${length.id === (s.article_length || 'standard') ? 'selected' : ''}>${length.name}</option>`).join('')}</select></label>
          <label for="story-editorial-score">Editorial score (internal)<input id="story-editorial-score" name="editorial_score" type="number" min="0" max="10" step="0.1" value="${s.editorial_score ?? ''}" placeholder="0–10"></label>
          <label for="story-promotion-level">Promotion level (internal)<select id="story-promotion-level" name="promotion_level">${['none', 'latest', 'section', 'homepage', 'lead'].map(level => `<option value="${level}" ${level === (s.promotion_level || 'none') ? 'selected' : ''}>${level}</option>`).join('')}</select></label>
        </div>
        <fieldset class="topic-fieldset"><legend>Beats</legend><div class="topic-checks">${(beats || []).map(t => `<label><input type="checkbox" name="beat" value="${t.id}" ${chosen.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div></fieldset>
        <label for="story-tags">Topics (optional)</label><input id="story-tags" name="tags" maxlength="500" value="${esc(existingTags)}" placeholder="Comma-separated specific tags">
        <div class="section-head"><div><label for="story-body">Body (Markdown)</label></div>${!id ? '<button type="button" class="quiet compact-button" data-apply-section-template>Use section template</button>' : ''}</div><textarea id="story-body" name="body" placeholder="Write the opening, then build the article with clear Markdown headings." required>${esc(s.body)}</textarea>
        ${!id ? '<p class="field-note">Start with the headline, dek, section, beats, and body. The section template gives you a clean writing structure and can be replaced before saving.</p>' : ''}
        <div class="editor-preview-actions">
          <button type="button" class="article-preview-launch" data-open-article-preview>Open Article Preview</button>
          <button type="button" class="quiet article-photo-launch" data-open-photo-library>Add media</button>
        </div>
        <p class="field-note">Preview unsaved changes with the live article renderer. Nothing is published from preview.</p>
      </section>
    </div>
    <div>
      <section class="editor-section">
        <h2>Article details</h2>
        <p class="meta-line">Editorial status: <span class="stamp st-${esc(editorialStatus)}">${esc(workflowLabel(editorialStatus))}</span></p>
        <p class="field-note">${latestWriterJob ? `Writer: ${esc(writerDisplay({ job: latestWriterJob }))}${lengthDisplay({ job: latestWriterJob }) ? ` · ${esc(lengthDisplay({ job: latestWriterJob }))}` : ''}` : 'Writer assignment will appear here when this story is commissioned.'}</p>${linkedCandidate ? researchAgainActionMarkup({ candidate: linkedCandidate, job: latestWriterJob }) : ''}${cleanupMarkup}
        <label for="story-status">Status</label><select id="story-status" name="status">${availableStatuses.map(status => `<option value="${status}" ${status === s.status ? 'selected' : ''}>${esc(status === 'review' ? 'Submit for review' : workflowLabel(status))}</option>`).join('')}</select>
        ${p.role === 'contributor'
          ? `<p class="field-note">Responsible editor: ${esc(assignedEditor?.name || 'Unassigned. An editor will claim the story during review.')}</p>`
          : `<label for="story-editor">Responsible editor</label><select id="story-editor" name="editor_id"><option value="">Unassigned</option>${(editors || []).map(editor => `<option value="${editor.id}" ${editor.id === s.editor_id ? 'selected' : ''}>${esc(editor.name)} · ${esc(humanize(editor.role))}</option>`).join('')}</select>`}
        <p class="field-note">${p.role === 'contributor' ? 'Choose Submit for review when the article is ready for an editor.' : s.status === 'review' ? 'Review the article and sources, then approve it for On Deck or return it for more work.' : 'Publishing happens from On Deck after approval. A responsible editor, complete metadata, and a valid source are required.'}</p>
      </section>
      <details class="editor-section" id="publish" open>
        <summary>Publishing</summary>
        <div class="secondary-fields">
          <label for="story-slug">Slug (stable URL)</label><input id="story-slug" name="slug" maxlength="96" value="${esc(s.slug)}" placeholder="Filled from the title if blank">
          <label for="story-author">Author</label><select id="story-author" name="author_id">${(authors || []).map(author => `<option value="${author.id}" ${author.id === s.author_id ? 'selected' : ''}>${esc(author.name)} · ${esc(humanize(author.role))}</option>`).join('')}</select>
          <label for="story-published-at">Publication date</label><input id="story-published-at" name="published_at" type="datetime-local" value="${s.published_at ? esc(localDateTimeValue(s.published_at)) : ''}">
          <label for="story-scheduled-for">Schedule for</label><input id="story-scheduled-for" name="scheduled_for" type="datetime-local" value="${s.scheduled_for ? esc(localDateTimeValue(s.scheduled_for)) : ''}">
          <label for="story-seo-title">SEO title</label><input id="story-seo-title" name="seo_title" maxlength="180" value="${esc(s.seo_title)}" placeholder="Defaults to the title">
          <label for="story-seo-description">SEO description</label><textarea id="story-seo-description" class="textarea-short" name="seo_description" maxlength="320" placeholder="Defaults to the dek">${esc(s.seo_description)}</textarea>
          <label for="story-social-title">Social preview title</label><input id="story-social-title" name="social_title" maxlength="180" value="${esc(s.social_title || '')}" placeholder="Defaults to the headline">
          <label for="story-social-description">Social preview description</label><textarea id="story-social-description" class="textarea-short" name="social_description" maxlength="320" placeholder="Defaults to the dek">${esc(s.social_description || '')}</textarea>
          <p class="field-note"><strong>Featured image</strong><br>${featuredImage ? `${esc(featuredImageLabel)} · ${esc(humanize(featuredImage.rights_status || 'rights not recorded'))}` : 'No featured image selected. Choose one in Sources.'}</p>
        </div>
      </details>
    </div>
  </div>
  <div class="action-bar">
    <span class="meta-line">${id ? `Revision ${Number(s.revision_number || 1)} · ${esc(workflowLabel(s.status))}.` : 'Create the draft, then add its source on the saved story.'}</span>
    <div class="buttons"><button type="submit">Save edits</button>${s.status === 'published' ? '<button type="button" class="danger-quiet" data-hide-story>Take down</button>' : ''}${p.role !== 'contributor' && s.status === 'review' ? '<button type="submit" name="editor_decision" value="approve">Approve for Ready</button><button type="submit" name="editor_decision" value="return" class="danger-quiet">Deny / return to draft</button>' : ''}${['fact_check', 'scheduled'].includes(s.status) ? `<a class="button quiet" href="/newsroom/on-deck#story-${esc(s.id)}">Open On Deck</a>` : ''}</div>
  </div>
  </form>
  <section class="editor-section photo-editor" id="sources" data-photo-library aria-labelledby="photos-heading">
    <div class="section-head">
      <div><span class="label">Article media</span><h2 id="photos-heading">Images and video</h2></div>
      <p class="field-note">Upload images, GIFs, MP4, or WebM media for this article. Save the story first so uploads remain attached to it.</p>
    </div>
    <p class="notice form-message" data-photo-message role="alert" hidden></p>
    <div class="article-media-attached" data-article-media-attached><h3>Media in this article</h3><div class="attached-media-grid"><p class="field-note">No media has been added to this article yet.</p></div></div>
    <div class="photo-editor-grid">
      <div class="photo-library-picker">
        <label for="editor-photo-select">Article media library</label>
        <select id="editor-photo-select"><option value="">Choose media</option></select>
        <div class="photo-editor-actions">
          <button type="button" data-editor-use-hero>Use as hero</button>
          <button type="button" class="quiet" data-editor-align-hero>Preview and align hero</button>
          <button type="button" class="quiet" data-editor-open-preview>Place in body</button>
        </div>
        <div class="photo-library-preview" data-photo-library-preview><p class="field-note">Choose media to inspect it.</p></div>
      </div>
      <form id="photo-upload-form" class="photo-upload-form">
        <h3>Add media</h3>
        <p class="field-note">Upload one image, animated GIF, MP4, or WebM and record how we have permission to use it.</p>
        <label for="photo-file">Media file</label><input id="photo-file" name="file" type="file" accept="image/avif,image/gif,image/jpeg,image/png,image/webp,video/mp4,video/webm" required>
        <div class="photo-upload-preview" data-photo-upload-preview><p class="field-note">Your media preview will appear here.</p></div>
        <label for="photo-permission-status">Permission status</label><select id="photo-permission-status" name="permission_status" required><option value="">Choose permission status</option>${PHOTO_PERMISSION_OPTIONS.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('')}</select>
        <details class="photo-more-details"><summary>More details <span>(optional)</span></summary>
          <div class="photo-field-grid">
            <label>Caption<input name="caption" maxlength="500"></label>
            <label>Alt text or video label<input name="alt_text" maxlength="320" placeholder="Generated from the filename if blank"></label>
            <label>Photographer or creator<input name="creator" maxlength="240"></label>
            <label>Credit line<input name="credit_line" maxlength="240" placeholder="Auto-filled when available"></label>
            <label>Source URL<input name="source_url" type="url" maxlength="2048" placeholder="https://"></label>
            <label>Permission evidence or documentation<input name="permission_evidence" type="url" maxlength="2048" placeholder="Optional URL"></label>
            <label>License notes<textarea name="license_notes" class="textarea-short" maxlength="600"></textarea></label>
            <label>Internal notes<textarea name="internal_notes" class="textarea-short" maxlength="600"></textarea></label>
          </div>
        </details>
        <p class="photo-upload-progress" data-photo-upload-progress hidden><progress max="100" aria-label="Photo upload progress"></progress><span data-photo-upload-progress-label></span></p>
        <div class="form-actions"><button type="submit">Save media</button></div>
      </form>
      <div class="photo-url-action"><button type="button" class="quiet" data-toggle-photo-url>Add media by URL</button></div>
      <form id="photo-url-form" class="photo-url-form" hidden>
        <h3>Add media by URL</h3>
        <p class="field-note">Use a direct public image, GIF, MP4, or WebM URL. It will be recorded in the same media library.</p>
        <label for="photo-image-url">Media URL</label><input id="photo-image-url" name="image_url" type="url" maxlength="2048" placeholder="https://example.com/media.mp4" required>
        <div class="photo-upload-preview" data-photo-url-preview><p class="field-note">A preview will appear after you enter a URL.</p></div>
        <label for="photo-url-permission-status">Permission status</label><select id="photo-url-permission-status" name="permission_status" required><option value="">Choose permission status</option>${PHOTO_PERMISSION_OPTIONS.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('')}</select>
        <div class="photo-field-grid photo-url-optional-fields">
          <label>Source URL<input name="source_url" type="url" maxlength="2048" placeholder="Optional source page"></label>
          <label>Credit<input name="credit_line" maxlength="240"></label>
          <label>Caption<input name="caption" maxlength="500"></label>
          <label>Alt text<input name="alt_text" maxlength="320" placeholder="Generated from the image URL if blank"></label>
        </div>
        <p class="photo-upload-progress" data-photo-url-progress hidden><span data-photo-url-progress-label></span></p>
        <div class="form-actions"><button type="submit">Save media by URL</button></div>
      </form>
    </div>
  </section>
  <dialog class="photo-details-dialog" data-photo-details-dialog aria-labelledby="photo-details-heading">
    <div class="photo-details-dialog-head"><div><span class="label">Article media</span><h2 id="photo-details-heading">Edit media</h2></div><button type="button" class="quiet compact-button" data-close-photo-details>Close</button></div>
    <form id="photo-details-form" class="photo-details-form">
      <p class="notice form-message" data-photo-details-message role="alert" hidden></p>
      <input type="hidden" name="photo_id">
      <section class="photo-metadata-group"><h3>Media</h3><label>Placement<select name="placement"><option value="library">Library only</option><option value="hero">Hero image</option><option value="body">Article body</option></select></label></section>
      <section class="photo-metadata-group"><h3>Editorial</h3><div class="photo-field-grid"><label>Caption<input name="caption" maxlength="500" required></label><label>Alt text or video label<input name="alt_text" maxlength="320"></label><label>Credit line<input name="credit_line" maxlength="240" placeholder="Auto-filled from creator or rights holder"></label><label class="inline-check"><input name="editorial_approved" type="checkbox" value="true"> Editorial approval: this media serves the story.</label></div></section>
      ${imageRightsFields()}
      <div class="form-actions"><button type="submit">Save media details</button></div>
    </form>
  </dialog>
  <section class="article-preview-workspace public-site" data-article-preview-workspace hidden aria-label="Article Preview">
    <header class="article-preview-toolbar">
      <div><span class="label">Newsroom</span><h2>Article Preview</h2><p>Unsaved editor changes appear here. Approval moves the article to On Deck and never publishes it.</p></div>
      <div class="preview-toolbar-actions">
        <div class="preview-viewport-toggle" role="group" aria-label="Preview viewport">
          <button type="button" data-preview-viewport="desktop" aria-pressed="true">Desktop</button>
          <button type="button" data-preview-viewport="mobile" aria-pressed="false">Mobile</button>
        </div>
        <button type="button" class="quiet" data-close-article-preview>Back to editing</button>
        ${p.role !== 'contributor' && s.status === 'review' ? '<button type="button" data-preview-decision="approve">Approve for On Deck</button><button type="button" class="danger-quiet" data-preview-decision="return">Deny / return</button>' : ''}
      </div>
    </header>
    <div class="article-preview-layout">
      <aside class="article-preview-controls" aria-label="Article visual settings">
        <p class="notice form-message" data-preview-message hidden></p>
        <section data-control-section="opening">
          <h3>Opening composition</h3>
          <label for="preview-composition">Approved composition</label>
          <select id="preview-composition">${ARTICLE_COMPOSITIONS.map(item => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}</select>
          <label for="preview-accent">Accent color</label>
          <select id="preview-accent"><option value="auto">Automatic</option>${ARTICLE_ACCENTS.map(value => `<option value="${value}">${esc(humanize(value))}</option>`).join('')}</select>
        </section>
        <section data-control-section="hero">
          <h3>Hero photo</h3>
          <label for="preview-hero">Photo</label>
          <select id="preview-hero"><option value="">Typographic fallback</option></select>
          <div class="control-row"><button type="button" class="quiet compact-button" data-remove-hero>Remove photo</button></div>
          <label for="preview-hero-crop">Crop</label>
          <select id="preview-hero-crop"><option value="auto">Automatic</option><option value="landscape">Landscape</option><option value="portrait">Portrait</option><option value="square">Square</option></select>
          <label for="preview-hero-fit">Photo treatment</label>
          <select id="preview-hero-fit"><option value="cover">Crop to fill</option><option value="contain">Show whole image</option></select>
          <label for="preview-focal-x">Focal point · horizontal</label><input id="preview-focal-x" type="range" min="0" max="100" value="50">
          <label for="preview-focal-y">Focal point · vertical</label><input id="preview-focal-y" type="range" min="0" max="100" value="50">
          <p class="field-note">Pipeline candidates marked “preview only” can be evaluated here, but block approval until rights are verified.</p>
        </section>
        <section data-control-section="detour">
          <h3>Detour cards</h3>
          <label for="preview-detour-label">Label</label><input id="preview-detour-label" maxlength="80" placeholder="The detour">
          <label for="preview-detour-text">Text</label><textarea id="preview-detour-text" class="textarea-short" maxlength="600" placeholder="A useful turn away from the main line."></textarea>
          <label for="preview-detour-after">Place after</label><select id="preview-detour-after"></select>
          <button type="button" data-add-detour>Add detour</button>
          <div class="detour-list" data-detour-list></div>
          <p class="field-note">Add as many dedicated cards as the story earns. Summary and Dek are never copied into a detour.</p>
        </section>
        <section data-control-section="inline-image">
          <h3>Inline media</h3>
          <label for="preview-inline-embed-url">Paste a YouTube or X video</label><input id="preview-inline-embed-url" type="url" maxlength="2048" placeholder="https://youtube.com/watch?v=… or https://x.com/…/status/…">
          <button type="button" class="quiet" data-add-inline-embed>Add video to story</button>
          <p class="field-note">The video stays hosted by YouTube or X. Anyways saves the source link and embeds the platform player.</p>
          <label for="preview-inline-source">Media</label><select id="preview-inline-source"><option value="">Choose media</option></select>
          <label for="preview-inline-after">Insert after</label><select id="preview-inline-after"></select>
          <label for="preview-inline-layout">Layout</label><select id="preview-inline-layout">${INLINE_IMAGE_LAYOUTS.map(item => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}</select>
          <label for="preview-inline-alt">Alt text</label><input id="preview-inline-alt" maxlength="320">
          <label for="preview-inline-caption">Caption</label><textarea id="preview-inline-caption" class="textarea-short" maxlength="500"></textarea>
          <label for="preview-inline-credit">Credit</label><input id="preview-inline-credit" maxlength="240">
          <label class="inline-check"><input id="preview-inline-frameless" type="checkbox"> Frameless image with accent silhouette</label>
          <p class="field-note">Frameless follows transparent pixels and uses this article’s accent color. Videos always use the rounded frame.</p>
          <button type="button" data-add-inline-image>Add inline media</button>
          <div class="inline-image-list" data-inline-image-list></div>
        </section>
      </aside>
      <main class="article-preview-stage" data-preview-stage data-viewport="desktop">
        <iframe class="article-preview-canvas" data-preview-canvas title="Rendered article preview"></iframe>
      </main>
    </div>
  </section>
  ${id ? `<section class="editor-section source-editor" id="sources-list" aria-labelledby="sources-heading">
    <h2 id="sources-heading">Sources</h2>
    <p class="muted">Sources are part of the story. Save any story edits before adding one.</p>
    <div class="source-list">${safeSources.length ? safeSources.map(source => `<div class="source-row">
      <div class="src-title">${source.safe_url ? `<a href="${esc(source.safe_url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>` : `<span>${esc(source.title)}</span>`}<span class="src-meta">${esc(source.publisher || 'Publisher not set')} · ${esc(humanize(source.source_type))}</span></div>
    </div>`).join('') : emptyNote('No source is on file yet.')}</div>
    ${unresolvedPipelineClaims.length ? `<p class="story-blocker"><strong>Verification warning</strong> ${unresolvedPipelineClaims.length} retained claim${unresolvedPipelineClaims.length === 1 ? ' needs' : 's need'} review before publication.</p>` : ''}
    ${pipelineSourceRows.length ? `<details class="source-packet-details"><summary>Retained research packet (${pipelineSourceRows.length} source${pipelineSourceRows.length === 1 ? '' : 's'})</summary>${pipelineSourceRows.map(source => `<div class="source-row"><div class="src-title">${sourceHref(source.canonical_url || source.url, source.title || 'Retained source')}<span class="src-meta">${esc(humanize(source.extraction_status || 'retained'))} · ${source.fetched_at ? esc(dShort(source.fetched_at)) : 'Date not recorded'}</span></div></div>`).join('')}</details>` : ''}
    ${pipelineClaims.length ? `<details class="source-packet-details"><summary>Claims and citation mapping (${pipelineClaims.length})</summary>${pipelineClaims.map(claim => `<div class="claim-row"><strong>${esc(claim.claim)}</strong><span class="stamp st-${esc(claim.status || 'unresolved')}">${esc(humanize(claim.status || 'unresolved'))}</span>${claim.note ? `<p class="field-note">${esc(claim.note)}</p>` : ''}</div>`).join('')}</details>` : ''}
    ${lunaEvidenceMarkup}
    <form id="source-form" class="add-source">
      <p class="notice form-message" data-form-message role="alert" hidden></p>
      <div class="source-grid">
        <div><label for="source-title">Source title</label><input id="source-title" name="title" maxlength="240" required></div>
        <div><label for="source-publisher">Publisher</label><input id="source-publisher" name="publisher" maxlength="160"></div>
      </div>
      <label for="source-url">Source URL</label><input id="source-url" name="url" type="url" maxlength="2048" inputmode="url" placeholder="https://" required>
      <label for="source-type">Source type</label><select id="source-type" name="source_type">${sourceTypes.map(type => `<option value="${type}">${esc(humanize(type))}</option>`).join('')}</select>
      <p class="field-note source-dirty-note" hidden>Save or reload the story changes before adding a source.</p>
      <div class="form-actions"><button type="submit">Add source</button></div>
    </form>
  </section>` : ''}
  ${id ? `<section class="editor-section" id="activity" aria-labelledby="activity-heading"><div class="section-head"><div><span class="label">Story history</span><h2 id="activity-heading">Activity</h2></div><p class="field-note">Technical execution details stay here with editorial changes and publication events.</p></div><div class="activity-list">${activityMarkup}</div><div class="section-head"><div><span class="label">Execution</span><h3>Stage timeline</h3></div><p class="field-note">Earlier attempts remain visible after a replay. Raw provider details stay inside Diagnostics.</p></div><div class="activity-list stage-timeline">${timelineMarkup}</div></section>` : ''}
  </div>`;
  bindSignOut();
  const wrapEditorPanel = (element, panelId, label) => {
    if (!element) return null;
    const details = document.createElement('details');
    details.className = 'editor-section editor-disclosure';
    details.id = panelId;
    details.innerHTML = '<summary>' + label + '</summary>';
    element.removeAttribute('id');
    element.classList.add('editor-disclosure-body');
    element.before(details);
    details.append(element);
    return details;
  };
  if (id) {
    wrapEditorPanel(document.querySelector('#sources-list'), 'sources-list', 'Sources and citations');
    wrapEditorPanel(document.querySelector('#activity'), 'activity', 'Activity');
  }
  const publishingPanel = document.querySelector('#publish');
  if (publishingPanel) publishingPanel.open = ['scheduled', 'published'].includes(s.status) || location.hash === '#publish';
  document.querySelectorAll('details').forEach(details => {
    if (details.querySelector(':scope > summary')?.textContent.trim() === 'Luna evidence and claims') details.open = false;
  });
  if (linkedCandidate) bindResearchAgainActions([{ candidate: linkedCandidate, job: latestWriterJob }]);
  bindDisposableCleanupActions();
  const storyForm = document.querySelector('#story');
  const sourceForm = document.querySelector('#source-form');
  const bodyInput = document.getElementById('story-body');
  const titleInput = document.getElementById('story-title'), slugInput = document.getElementById('story-slug');
  const sectionSelect = document.getElementById('story-section'), sectionQuestion = document.getElementById('section-question');
  const previewWorkspace = document.querySelector('[data-article-preview-workspace]');
  const previewCanvas = document.querySelector('[data-preview-canvas]');
  const previewStage = document.querySelector('[data-preview-stage]');
  const previewMessage = document.querySelector('[data-preview-message]');
  const mediaLibrary = [
    ...(mediaRows || []).map(item => ({
      id: `media:${item.id}`,
      mediaId: item.id,
      public_url: item.public_url,
      mime_type: item.mime_type,
      media_type: storyMediaType(item),
      alt_text: item.alt_text,
      caption: item.caption,
      credit: item.credit,
      width: item.width,
      height: item.height,
      source_url: item.source_page_url || item.source_url,
      provider: item.provider,
      source_page_url: item.source_page_url,
      original_file_url: item.original_file_url || item.public_url,
      creator: item.creator,
      license_code: item.license_code,
      license_url: item.license_url,
      credit_line: item.credit_line,
      commercial_use_allowed: item.commercial_use_allowed,
      modification_allowed: item.modification_allowed,
      verification_method: item.verification_method,
      verification_timestamp: item.verification_timestamp,
      source_metadata: item.source_metadata,
      rights_audit: item.rights_audit,
      rights_status: item.rights_status || 'metadata_incomplete',
      rights_note: item.rights_note || '',
      rights_basis: item.rights_basis,
      rights_details: item.rights_details,
      editorial_approved: item.editorial_approved === true,
      rights_override_approved_at: item.rights_override_approved_at,
      previewOnly: !imageIsPublishable(item),
      label: item.caption || item.alt_text || `Media ${item.id.slice(0, 8)}`
    })),
    ...(pipelineImages || []).map(item => ({
      id: `pipeline:${item.id}`,
      candidateImageId: item.id,
      original_url: item.original_url,
      mime_type: item.file_type || '',
      media_type: 'image',
      alt_text: item.caption || '',
      caption: item.caption || '',
      credit: item.creator || '',
      width: item.width,
      height: item.height,
      rights_status: item.rights_status,
      rights_note: item.rights_note || '',
      source_url: item.source_page_url || item.rights_source_url || item.source_page || item.original_url || '',
      provider: item.provider,
      source_page_url: item.source_page_url || item.source_page,
      original_file_url: item.original_file_url || item.original_url,
      creator: item.creator,
      license_code: item.license_code || item.license,
      license_url: item.license_url,
      credit_line: item.credit_line,
      commercial_use_allowed: item.commercial_use_allowed,
      modification_allowed: item.modification_allowed,
      verification_method: item.verification_method,
      verification_timestamp: item.verification_timestamp,
      source_metadata: item.source_metadata,
      rights_audit: item.rights_audit,
      rights_basis: item.rights_basis,
      rights_details: item.rights_details,
      editorial_approved: item.editorial_approved === true,
      rights_override_approved_at: item.rights_override_approved_at,
      warning_flags: item.warning_flags || [],
      previewOnly: !imageIsPublishable(item),
      label: item.caption || item.creator || `Pipeline candidate ${item.id.slice(0, 8)}`
    }))
  ];
  const mediaById = new Map(mediaLibrary.map(item => [item.id, item]));
  let presentationDraft = normalizePresentation(presentationRows[0]?.presentation || {});
  const inlineUsesMedia = (inlineItem, libraryItem) => inlineItem.id === libraryItem.id
    || inlineItem.sourceId === libraryItem.id
    || Boolean(libraryItem.mediaId && inlineItem.mediaId === libraryItem.mediaId);
  if (!presentationDraft.hero && s.hero_media_id && mediaById.has(`media:${s.hero_media_id}`)) {
    presentationDraft.hero = { ...mediaById.get(`media:${s.hero_media_id}`), crop: 'auto', focalX: 50, focalY: 50 };
  }
  let dirty = false;
  let detourDraft = { label: '', text: '', afterBlock: 0 };
  let slugWasEdited = Boolean(s.slug);

  const setDirty = () => {
    dirty = true;
    if (sourceForm) {
      sourceForm.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
      sourceForm.querySelector('.source-dirty-note').hidden = false;
    }
  };

  storyForm.addEventListener('input', setDirty);
  storyForm.addEventListener('change', setDirty);
  const syncSecondarySections = () => {
    document.querySelectorAll('input[name="secondary_section"]').forEach(input => {
      const isPrimary = input.value === sectionSelect?.value;
      if (isPrimary) input.checked = false;
      input.disabled = isPrimary;
    });
  };
  sectionSelect?.addEventListener('change', () => {
    sectionQuestion.textContent = promises[sectionSelect.value] || '';
    syncSecondarySections();
  });
  syncSecondarySections();
  document.querySelector('[data-apply-section-template]')?.addEventListener('click', () => {
    const selectedSection = (sections || []).find(item => item.id === sectionSelect?.value);
    const template = String(selectedSection?.template || '').trim();
    if (!template) return showFormMessage(storyForm, 'This section does not have a writing template yet.');
    if (bodyInput.value.trim() && !window.confirm('Replace the current body with this section template?')) return;
    bodyInput.value = template;
    bodyInput.dispatchEvent(new Event('input', { bubbles: true }));
    bodyInput.focus();
  });
  slugInput?.addEventListener('input', () => { slugWasEdited = true; });
  titleInput?.addEventListener('input', () => {
    if (!slugWasEdited && slugInput) slugInput.value = slugify(titleInput.value);
  });
  window.addEventListener('beforeunload', event => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const blockOptions = () => {
    const blocks = String(bodyInput?.value || '').split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('- ') && !/^\d+\. /.test(line));
    return blocks.map((line, index) => {
      const label = line.replace(/^#{1,3}\s+|^>\s+/, '').slice(0, 72);
      return `<option value="${index}">Block ${index + 1}: ${esc(label)}</option>`;
    }).join('') || '<option value="0">Opening paragraph</option>';
  };
  const currentPreviewStory = () => {
    const selectedSection = (sections || []).find(item => item.id === sectionSelect?.value);
    const selectedBeats = [...storyForm.querySelectorAll('input[name="beat"]:checked')].map(control => {
      const beat = (beats || []).find(item => item.id === control.value);
      return beat ? { beats: { name: beat.name, slug: beat.slug } } : null;
    }).filter(Boolean);
    const selectedTags = String(document.getElementById('story-tags')?.value || '').split(',').map(value => value.trim()).filter(Boolean);
    return {
      ...s,
      id: s.id || 'preview-story',
      title: titleInput?.value || 'Untitled story',
      slug: slugInput?.value || slugify(titleInput?.value) || 'preview-story',
      dek: document.getElementById('story-dek')?.value || '',
      summary: document.getElementById('story-summary')?.value || '',
      body: bodyInput?.value || '',
      section_id: sectionSelect?.value || '',
      sections: selectedSection ? { name: selectedSection.name, slug: selectedSection.slug } : null,
      story_beats: selectedBeats,
      story_tags: selectedTags.map(name => ({ tags: { name, slug: slugify(name) } })),
      profiles: { name: (editors || []).find(editor => editor.id === (s.author_id || p.id))?.name || p.name },
      reading_time_minutes: Math.max(1, Math.ceil(String(bodyInput?.value || '').split(/\s+/).filter(Boolean).length / 220)),
      updated_at: s.updated_at || new Date().toISOString(),
      presentation: presentationDraft
    };
  };
  // Saving is core editor behavior. Bind it before the optional photo and preview
  // workspace is initialized, so an enhancement failure cannot leave an otherwise
  // valid article editor with an inert Save button.
  storyForm.onsubmit = saveStory;
  const updateInlineList = () => {
    const list = document.querySelector('[data-inline-image-list]');
    if (!list) return;
    list.innerHTML = presentationDraft.inlineImages.length
      ? presentationDraft.inlineImages.map((item, index) => `<div class="inline-image-item"><span>${esc(item.caption || item.alt_text || item.label || `Media ${index + 1}`)} · ${item.embed_provider ? `${esc(humanize(item.embed_provider))} embed` : esc(humanize(item.layout || 'wide'))}${item.treatment === 'frameless' && !isVideoItem(item) ? ' · Frameless' : ''}</span><button type="button" class="quiet compact-button" data-remove-inline="${index}">Remove</button></div>`).join('')
      : '<p class="field-note">No inline media placed.</p>';
    list.querySelectorAll('[data-remove-inline]').forEach(button => {
      button.onclick = () => {
        presentationDraft.inlineImages.splice(Number(button.dataset.removeInline), 1);
        setDirty();
        renderPreview();
      };
    });
  };
  const updateDetourList = () => {
    const list = document.querySelector('[data-detour-list]');
    if (!list) return;
    list.innerHTML = presentationDraft.detours.length
      ? presentationDraft.detours.map((item, index) => `<div class="detour-item"><div><strong>${esc(item.label || 'The detour')}</strong><span class="field-note"> · after block ${Number(item.afterBlock) + 1}</span></div><p>${esc(item.text || '')}</p><button type="button" class="quiet compact-button" data-remove-detour="${index}">Remove</button></div>`).join('')
      : '<p class="field-note">No detour cards added.</p>';
    list.querySelectorAll('[data-remove-detour]').forEach(button => {
      button.onclick = () => {
        presentationDraft.detours.splice(Number(button.dataset.removeDetour), 1);
        presentationDraft.detour = presentationDraft.detours[0] || { visible: false, label: 'The detour', text: '', afterBlock: 1 };
        setDirty();
        renderPreview();
      };
    });
  };
  const syncPreviewControls = () => {
    document.getElementById('preview-composition').value = presentationDraft.composition;
    document.getElementById('preview-accent').value = presentationDraft.accent;
    document.getElementById('preview-detour-label').value = detourDraft.label;
    document.getElementById('preview-detour-text').value = detourDraft.text;
    const options = blockOptions();
    document.getElementById('preview-detour-after').innerHTML = options;
    document.getElementById('preview-inline-after').innerHTML = options;
    document.getElementById('preview-detour-after').value = String(detourDraft.afterBlock);
    const hero = presentationDraft.hero;
    document.getElementById('preview-hero').value = hero?.id || '';
    document.getElementById('preview-hero-crop').value = hero?.crop || 'auto';
    document.getElementById('preview-hero-fit').value = hero?.fit === 'contain' ? 'contain' : 'cover';
    document.getElementById('preview-focal-x').value = String(hero?.focalX ?? 50);
    document.getElementById('preview-focal-y').value = String(hero?.focalY ?? 50);
    updateDetourList();
    updateInlineList();
  };
  const renderPreview = () => {
    if (!previewCanvas) return;
    const previousScroll = previewCanvas.contentWindow?.scrollY || 0;
    const story = currentPreviewStory();
    const numbers = new Map([[story.id, 1]]);
    const articleHtml = renderArticle({
      story,
      sources: safeSources.filter(source => source.safe_url),
      catalog: [story],
      numbers,
      accent: ARTICLE_ACCENTS[hash(story.id || story.slug) % ARTICLE_ACCENTS.length],
      presentation: presentationDraft,
      interactive: true
    });
    previewCanvas.onload = () => {
      const previewDocument = previewCanvas.contentDocument;
      previewCanvas.contentWindow?.scrollTo(0, previousScroll);
      previewDocument?.querySelectorAll('[data-preview-control]').forEach(control => {
        const openControl = () => {
          const section = document.querySelector(`[data-control-section="${control.dataset.previewControl}"]`);
          section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          section?.classList.add('is-active');
          setTimeout(() => section?.classList.remove('is-active'), 900);
        };
        control.onclick = openControl;
        control.onkeydown = event => {
          if (['Enter', ' '].includes(event.key)) {
            event.preventDefault();
            openControl();
          }
        };
      });
    };
    previewCanvas.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/design/design.css"><link rel="stylesheet" href="/design/public.css"></head><body class="public-site route-story"><main id="app">${articleHtml}</main></body></html>`;
    syncPreviewControls();
  };
  const showPreviewMessage = (message, kind = 'error') => {
    if (!previewMessage) return;
    previewMessage.textContent = message;
    previewMessage.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`;
    previewMessage.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
    previewMessage.hidden = !message;
  };
  const openPreview = () => {
    renderPreview();
    previewWorkspace.hidden = false;
    document.body.classList.add('article-preview-open');
    previewWorkspace.querySelector('[data-close-article-preview]')?.focus();
  };
  const closePreview = () => {
    previewWorkspace.hidden = true;
    document.body.classList.remove('article-preview-open');
    document.querySelector('[data-open-article-preview]')?.focus();
  };

  const heroSelect = document.getElementById('preview-hero');
  const inlineSelect = document.getElementById('preview-inline-source');
  const editorPhotoSelect = document.getElementById('editor-photo-select');
  const photoUploadForm = document.getElementById('photo-upload-form');
  const photoFileInput = document.getElementById('photo-file');
  const photoUploadPreview = document.querySelector('[data-photo-upload-preview]');
  const photoMessage = document.querySelector('[data-photo-message]');
  const photoLibraryPreview = document.querySelector('[data-photo-library-preview]');
  const photoDetailsDialog = document.querySelector('[data-photo-details-dialog]');
  const photoDetailsForm = document.getElementById('photo-details-form');
  const photoDetailsMessage = document.querySelector('[data-photo-details-message]');
  let photoDetailsTrigger = null;
  photoDetailsDialog?.addEventListener('close', () => photoDetailsTrigger?.focus?.());
  const photoUrlForm = document.getElementById('photo-url-form');
  const photoUrlInput = document.getElementById('photo-image-url');
  const photoUrlPreview = document.querySelector('[data-photo-url-preview]');
  const photoUploadProgress = document.querySelector('[data-photo-upload-progress]');
  const photoUploadProgressLabel = document.querySelector('[data-photo-upload-progress-label]');
  const photoUrlProgress = document.querySelector('[data-photo-url-progress]');
  const photoUrlProgressLabel = document.querySelector('[data-photo-url-progress-label]');
  const mediaOptions = mediaLibrary.map(item => `<option value="${esc(item.id)}">${esc(item.label)}${isVideoItem(item) ? ' · video' : ''}${item.previewOnly ? ` · preview only (${esc(humanize(item.rights_status))})` : ''}</option>`).join('');
  const heroMediaOptions = mediaLibrary.filter(item => !isVideoItem(item)).map(item => `<option value="${esc(item.id)}">${esc(item.label)}${item.previewOnly ? ` · preview only (${esc(humanize(item.rights_status))})` : ''}</option>`).join('');
  heroSelect.insertAdjacentHTML('beforeend', heroMediaOptions);
  inlineSelect.insertAdjacentHTML('beforeend', mediaOptions);
  editorPhotoSelect.insertAdjacentHTML('beforeend', mediaOptions);
  const showPhotoMessage = (message, kind = 'error') => {
    photoMessage.textContent = message;
    photoMessage.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`;
    photoMessage.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
    photoMessage.hidden = !message;
  };
  const setPhotoProgress = (element, labelElement, message = '', visible = true) => {
    if (!element || !labelElement) return;
    labelElement.textContent = message;
    element.hidden = !visible || !message;
  };
  const showPhotoDetailsMessage = (message, kind = 'error') => {
    photoDetailsMessage.textContent = message;
    photoDetailsMessage.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`;
    photoDetailsMessage.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
    photoDetailsMessage.hidden = !message;
  };
  const setPhotoField = (name, value) => photoDetailsForm.querySelectorAll(`[name="${name}"]`).forEach(field => {
    if (field.type === 'checkbox') field.checked = value === true;
    else field.value = value || '';
  });
  const syncRightsWorkflow = form => {
    const basis = form.querySelector('[data-rights-basis]')?.value || 'not_verified';
    form.querySelectorAll('[data-rights-when]').forEach(group => {
      const active = group.dataset.rightsWhen === basis;
      group.hidden = !active;
      group.querySelectorAll('input, textarea, select').forEach(field => { field.disabled = !active; });
    });
    const warning = form.querySelector('[data-rights-not-verified]');
    if (warning) warning.hidden = basis !== 'not_verified';
    // These statuses require fields deliberately tucked into Advanced rights
    // details. Reveal the section when it is needed, while keeping it closed
    // by default for ordinary staff-owned work.
    const advanced = form.querySelector('.advanced-rights-details');
    if (advanced && ['licensed', 'creative_commons', 'not_verified'].includes(basis)) advanced.open = true;
  };
  const bindRightsWorkflow = form => {
    if (!form) return;
    const basis = form.querySelector('[data-rights-basis]');
    const credit = form.querySelector('[name="credit_line"]');
    const updateCredit = () => {
      if (!credit || credit.dataset.manual === 'true' || credit.value.trim()) return;
      const workflow = imageRightsRecord(new FormData(form));
      credit.value = suggestedCreditLine(workflow);
    };
    basis?.addEventListener('change', () => { syncRightsWorkflow(form); updateCredit(); });
    form.querySelectorAll('[name="creator"], [name="rights_holder"]').forEach(field => field.addEventListener('input', updateCredit));
    credit?.addEventListener('input', () => { credit.dataset.manual = credit.value.trim() ? 'true' : ''; });
    syncRightsWorkflow(form);
  };
  bindRightsWorkflow(photoDetailsForm);
  const openPhotoDetails = id => {
    photoDetailsTrigger = document.activeElement;
    const item = mediaById.get(id);
    if (!item) return;
    const workflow = normalizeImageRightsWorkflow(item);
    setPhotoField('photo_id', item.id);
    setPhotoField('caption', item.caption || item.label || '');
    setPhotoField('alt_text', item.alt_text || '');
    setPhotoField('credit_line', item.credit_line || item.credit || '');
    photoDetailsForm.querySelector('[name="credit_line"]').dataset.manual = item.credit_line || item.credit ? 'true' : '';
    setPhotoField('rights_basis', workflow.rights_basis);
    setPhotoField('editorial_approved', workflow.editorial_approved);
    setPhotoField('provider', item.provider || 'internal_library');
    setPhotoField('source_page_url', item.source_page_url || item.source_url || '');
    setPhotoField('creator', item.creator || '');
    setPhotoField('license_code', item.license_code || '');
    setPhotoField('license_url', item.license_url || '');
    setPhotoField('rights_holder', workflow.rights_holder);
    setPhotoField('permission_contact', workflow.permission_contact);
    setPhotoField('permission_date', workflow.permission_date);
    setPhotoField('usage_restrictions', workflow.usage_restrictions);
    setPhotoField('expiration_date', workflow.expiration_date);
    setPhotoField('proof_url', workflow.proof_url);
    setPhotoField('public_domain_basis', workflow.public_domain_basis);
    setPhotoField('required_attribution', workflow.required_attribution);
    setPhotoField('internal_rights_notes', workflow.internal_rights_notes);
    setPhotoField('original_file_url', item.original_file_url || item.original_url || '');
    setPhotoField('verification_method', item.verification_method || '');
    setPhotoField('verification_timestamp', item.verification_timestamp ? new Date(item.verification_timestamp).toISOString().slice(0, 16) : '');
    setPhotoField('source_metadata', item.source_metadata ? JSON.stringify(item.source_metadata) : '');
    setPhotoField('commercial_use_allowed', item.commercial_use_allowed === true);
    setPhotoField('modification_allowed', item.modification_allowed === true);
    const currentPlacement = presentationDraft.hero?.id === item.id ? 'hero' : presentationDraft.inlineImages.some(image => inlineUsesMedia(image, item)) ? 'body' : 'library';
    const heroPlacement = photoDetailsForm.querySelector('[name="placement"] option[value="hero"]');
    if (heroPlacement) heroPlacement.disabled = isVideoItem(item);
    setPhotoField('placement', currentPlacement);
    syncRightsWorkflow(photoDetailsForm);
    showPhotoDetailsMessage('');
    photoDetailsDialog.showModal();
    window.requestAnimationFrame(() => photoDetailsDialog.querySelector('[data-close-photo-details]')?.focus());
  };
  const mediaOption = item => `<option value="${esc(item.id)}">${esc(item.label)}${isVideoItem(item) ? ' · video' : ''}${item.previewOnly ? ` · preview only (${esc(humanize(item.rights_status))})` : ''}</option>`;
  const renderAttachedMedia = () => {
    const target = document.querySelector('[data-article-media-attached] .attached-media-grid');
    if (!target) return;
    const items = mediaLibrary;
    target.innerHTML = items.length ? items.map(item => {
      const url = mediaUrl(item.public_url || item.original_url);
      const hero = presentationDraft.hero?.id === item.id ? '<span class="stamp st-published">Hero</span>' : '';
      const inline = presentationDraft.inlineImages.some(image => inlineUsesMedia(image, item)) ? '<span class="stamp st-review">In body</span>' : '';
      const rights = item.previewOnly ? '<span class="stamp st-review">Rights review required</span>' : '<span class="stamp st-published">Rights cleared</span>';
      const preview = url ? (isVideoItem(item)
        ? `<video src="${esc(url)}" controls playsinline preload="metadata" aria-label="${esc(item.alt_text || item.label || 'Article video')}"></video>`
        : `<img src="${esc(url)}" alt="${esc(item.alt_text || '')}">`) : '';
      const heroButton = isVideoItem(item) ? '' : `<button type="button" class="quiet compact-button" data-photo-use-hero="${esc(item.id)}">${presentationDraft.hero?.id === item.id ? 'Current hero' : 'Use as hero'}</button>`;
      return `<figure class="attached-media-card">${preview}<figcaption><strong>${esc(item.label)}</strong><span>${hero}${inline}${rights}</span>${heroButton}<button type="button" class="quiet compact-button" data-edit-photo="${esc(item.id)}">Edit media</button></figcaption></figure>`;
    }).join('') : '<p class="field-note">No media has been added to this article yet.</p>';
    target.querySelectorAll('[data-photo-use-hero]').forEach(button => button.onclick = () => {
      const source = mediaById.get(button.dataset.photoUseHero);
      if (!source) return;
      presentationDraft.hero = { ...source, crop: 'auto', focalX: 50, focalY: 50 };
      heroSelect.value = source.id;
      setDirty();
      renderAttachedMedia();
      showPhotoMessage(source.previewOnly ? 'Hero selected for preview. Verify rights before publishing.' : 'Hero replaced. Open Preview and align it before saving.', source.previewOnly ? 'error' : 'ok');
    });
    target.querySelectorAll('[data-edit-photo]').forEach(button => button.onclick = () => openPhotoDetails(button.dataset.editPhoto));
  };
  document.querySelector('[data-close-photo-details]').onclick = () => photoDetailsDialog.close();
  photoDetailsForm.onsubmit = async event => {
    event.preventDefault();
    const formData = new FormData(photoDetailsForm);
    const values = Object.fromEntries(formData);
    const existing = mediaById.get(values.photo_id);
    if (!existing) return showPhotoDetailsMessage('That media item is no longer attached to this article. Reload and try again.');
    if (!String(values.caption || '').trim()) return showPhotoDetailsMessage('Give this media item a label or caption.');
    if (values.placement === 'hero' && isVideoItem(existing)) return showPhotoDetailsMessage('Videos can be placed in the article body but cannot be used as the hero.');
    const rightsRecord = imageRightsRecord(formData, { originalFileUrl: existing.original_file_url || existing.original_url || existing.public_url, existingRecord: existing });
    const decision = validateImageRights(rightsRecord);
    const isPipelineImage = Boolean(existing.candidateImageId);
    const rightsPayload = imageRightsPayload(rightsRecord, decision);
    setBusy(photoDetailsForm, true, 'Saving media…');
    const { data: savedRecord, error } = isPipelineImage
      ? await sb.from('image_candidates').update({ caption: String(values.caption).trim(), ...rightsPayload }).eq('id', existing.candidateImageId).select('id,caption,rights_status,rights_note,rights_basis,rights_details,editorial_approved,rights_override_approved_at,provider,source_page_url,original_file_url,creator,license_code,license_url,credit_line,commercial_use_allowed,modification_allowed,verification_method,verification_timestamp,source_metadata,rights_audit').single()
      : await sb.from('media').update({ caption: String(values.caption).trim(), alt_text: String(values.alt_text || '').trim() || existing.alt_text, credit: rightsPayload.credit_line || null, source_url: rightsPayload.source_page_url, ...rightsPayload }).eq('id', existing.mediaId).select('id,public_url,alt_text,caption,credit,width,height,source_url,rights_status,provider,source_page_url,original_file_url,creator,license_code,license_url,credit_line,commercial_use_allowed,modification_allowed,verification_method,verification_timestamp,source_metadata,rights_audit,rights_basis,rights_details,editorial_approved,rights_override_approved_at,rights_note').single();
    setBusy(photoDetailsForm, false);
    if (error || !savedRecord) return showPhotoDetailsMessage(error?.message || 'The media details could not be saved.');
    const saved = isPipelineImage
      ? { ...existing, ...savedRecord, caption: savedRecord.caption, label: savedRecord.caption || existing.alt_text || existing.label, source_url: savedRecord.source_page_url || existing.source_url, previewOnly: !imageIsPublishable({ ...existing, ...savedRecord }) }
      : { ...existing, ...savedRecord, source_url: savedRecord.source_page_url || savedRecord.source_url || existing.source_url, previewOnly: !imageIsPublishable({ ...existing, ...savedRecord }), label: savedRecord.caption || savedRecord.alt_text || existing.label };
    mediaLibrary.splice(mediaLibrary.findIndex(item => item.id === saved.id), 1, saved);
    mediaById.set(saved.id, saved);
    if (presentationDraft.hero?.id === saved.id) presentationDraft.hero = { ...presentationDraft.hero, ...saved, crop: presentationDraft.hero.crop || 'auto', focalX: presentationDraft.hero.focalX ?? 50, focalY: presentationDraft.hero.focalY ?? 50 };
    presentationDraft.inlineImages = presentationDraft.inlineImages.map(image => image.id === saved.id || image.sourceId === saved.id ? { ...image, ...saved } : image);
    if (values.placement === 'hero') {
      presentationDraft.hero = { ...saved, crop: presentationDraft.hero?.crop || 'auto', focalX: presentationDraft.hero?.focalX ?? 50, focalY: presentationDraft.hero?.focalY ?? 50 };
      heroSelect.value = saved.id;
    } else if (values.placement === 'body' && !presentationDraft.inlineImages.some(image => inlineUsesMedia(image, saved))) {
      presentationDraft.inlineImages.push({ ...saved, afterBlock: 0, layout: 'wide', treatment: 'framed' });
    } else if (values.placement === 'library') {
      if (presentationDraft.hero?.id === saved.id) presentationDraft.hero = null;
      presentationDraft.inlineImages = presentationDraft.inlineImages.filter(image => !inlineUsesMedia(image, saved));
    }
    setDirty();
    renderAttachedMedia();
    photoDetailsDialog.close();
    showPhotoMessage('Media details saved. Save the article to retain its placement.', 'ok');
  };
  const addToMediaLibrary = item => {
    mediaLibrary.unshift(item);
    mediaById.set(item.id, item);
    const option = mediaOption(item);
    if (!isVideoItem(item)) heroSelect.insertAdjacentHTML('beforeend', option);
    inlineSelect.insertAdjacentHTML('beforeend', option);
    editorPhotoSelect.insertAdjacentHTML('beforeend', option);
    renderAttachedMedia();
  };
  renderAttachedMedia();
  const selectedEditorPhoto = () => mediaById.get(editorPhotoSelect.value);
  const renderPhotoLibraryPreview = () => {
    const item = selectedEditorPhoto();
    if (!item) {
      photoLibraryPreview.innerHTML = '<p class="field-note">Choose media to inspect it.</p>';
      return;
    }
    const url = mediaUrl(item.public_url || item.original_url);
    const preview = url ? (isVideoItem(item)
      ? `<video src="${esc(url)}" controls playsinline preload="metadata" aria-label="${esc(item.alt_text || item.label || 'Article video')}"></video>`
      : `<img src="${esc(url)}" alt="${esc(item.alt_text || '')}">`) : '';
    photoLibraryPreview.innerHTML = `${preview}
      <p><strong>${esc(item.label)}</strong></p>
      <p class="field-note">${esc(item.caption || item.alt_text || 'No caption')}${item.credit ? ` · ${esc(item.credit)}` : ''}</p>
      <span class="stamp ${item.previewOnly ? 'st-review' : 'st-published'}">${item.previewOnly ? 'Preview only' : 'Rights cleared'}</span>`;
  };
  editorPhotoSelect.onchange = renderPhotoLibraryPreview;
  document.querySelector('[data-open-photo-library]')?.addEventListener('click', () => {
    document.querySelector('[data-photo-library]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('photo-file')?.focus();
  });
  document.querySelector('[data-editor-use-hero]')?.addEventListener('click', () => {
    const source = selectedEditorPhoto();
    if (!source) return showPhotoMessage('Choose a photo before using it as the hero.');
    if (isVideoItem(source)) return showPhotoMessage('Videos can be placed in the body but cannot be used as the hero.');
    presentationDraft.hero = { ...source, crop: 'auto', focalX: 50, focalY: 50 };
    heroSelect.value = source.id;
    setDirty();
    showPhotoMessage(source.previewOnly ? 'Hero selected for preview only. Record valid rights before approval.' : 'Hero photo selected. Save the article to keep it.', source.previewOnly ? 'error' : 'ok');
  });
  document.querySelector('[data-editor-align-hero]')?.addEventListener('click', () => {
    const source = selectedEditorPhoto();
    if (!source) return showPhotoMessage('Choose a photo before aligning the hero.');
    if (isVideoItem(source)) return showPhotoMessage('Videos use the body frame and do not have hero alignment controls.');
    presentationDraft.hero = { ...source, crop: presentationDraft.hero?.crop || 'auto', focalX: presentationDraft.hero?.focalX ?? 50, focalY: presentationDraft.hero?.focalY ?? 50 };
    heroSelect.value = source.id;
    setDirty();
    openPreview();
    document.querySelector('[data-control-section="hero"]')?.scrollIntoView({ block: 'start' });
  });
  document.querySelector('[data-editor-open-preview]')?.addEventListener('click', () => {
    const source = selectedEditorPhoto();
    if (!source) return showPhotoMessage('Choose a photo before opening placement controls.');
    inlineSelect.value = source.id;
    syncInlineTreatmentControl();
    openPreview();
    document.querySelector('[data-control-section="inline-image"]')?.scrollIntoView({ block: 'start' });
  });
  const framelessControl = document.getElementById('preview-inline-frameless');
  const syncInlineTreatmentControl = () => {
    const source = mediaById.get(inlineSelect.value);
    framelessControl.disabled = !source || isVideoItem(source);
    if (framelessControl.disabled) framelessControl.checked = false;
  };
  inlineSelect.addEventListener('change', syncInlineTreatmentControl);
  syncInlineTreatmentControl();
  let stagedPhotoUrl = '';
  const clearStagedPhotoUrl = () => {
    if (stagedPhotoUrl) URL.revokeObjectURL(stagedPhotoUrl);
    stagedPhotoUrl = '';
  };
  const renderPhotoUploadPreview = () => {
    clearStagedPhotoUrl();
    const file = photoFileInput.files?.[0];
    if (!file) {
      photoUploadPreview.innerHTML = '<p class="field-note">Your media preview will appear here.</p>';
      return;
    }
    const validationError = validateStoryMedia({ file });
    if (validationError) showPhotoMessage(validationError);
    stagedPhotoUrl = URL.createObjectURL(file);
    const preview = storyMediaType(file) === 'video'
      ? `<video src="${esc(stagedPhotoUrl)}" controls playsinline muted preload="metadata"></video>`
      : `<img src="${esc(stagedPhotoUrl)}" alt="">`;
    photoUploadPreview.innerHTML = `${preview}<p class="field-note">${esc(file.name)} · ${esc((file.size / 1024 / 1024).toFixed(1))} MB</p>`;
  };
  photoFileInput.onchange = renderPhotoUploadPreview;
  photoUrlInput.oninput = () => {
    const value = photoUrlInput.value.trim();
    if (!value || validateImageUrl(value)) {
      photoUrlPreview.innerHTML = '<p class="field-note">A preview will appear after you enter a valid URL.</p>';
      return;
    }
    const mimeType = externalMediaMimeType(value);
    const preview = storyMediaType(mimeType) === 'video'
      ? `<video src="${esc(value)}" controls playsinline muted preload="metadata"></video>`
      : `<img src="${esc(value)}" alt="">`;
    photoUrlPreview.innerHTML = `${preview}<p class="field-note">${esc(value)}</p>`;
  };
  document.querySelector('[data-toggle-photo-url]')?.addEventListener('click', event => {
    photoUrlForm.hidden = !photoUrlForm.hidden;
    event.currentTarget.textContent = photoUrlForm.hidden ? 'Add media by URL' : 'Hide media URL form';
    if (!photoUrlForm.hidden) photoUrlInput.focus();
  });
  const mediaFields = 'id,public_url,filename,mime_type,alt_text,caption,credit,width,height,source_url,rights_status,rights_note,rights_basis,rights_details,editorial_approved,rights_override_approved_at,provider,source_page_url,original_file_url,creator,license_code,license_url,credit_line,commercial_use_allowed,modification_allowed,verification_method,verification_timestamp,source_metadata,rights_audit';
  const mediaItem = (savedMedia, fallbackLabel) => ({
    id: `media:${savedMedia.id}`,
    mediaId: savedMedia.id,
    public_url: savedMedia.public_url,
    mime_type: savedMedia.mime_type,
    media_type: storyMediaType(savedMedia),
    alt_text: savedMedia.alt_text,
    caption: savedMedia.caption,
    credit: savedMedia.credit,
    width: savedMedia.width,
    height: savedMedia.height,
    source_url: savedMedia.source_page_url || savedMedia.source_url,
    provider: savedMedia.provider,
    source_page_url: savedMedia.source_page_url,
    original_file_url: savedMedia.original_file_url,
    creator: savedMedia.creator,
    license_code: savedMedia.license_code,
    license_url: savedMedia.license_url,
    credit_line: savedMedia.credit_line,
    commercial_use_allowed: savedMedia.commercial_use_allowed,
    modification_allowed: savedMedia.modification_allowed,
    verification_method: savedMedia.verification_method,
    verification_timestamp: savedMedia.verification_timestamp,
    source_metadata: savedMedia.source_metadata,
    rights_audit: savedMedia.rights_audit,
    rights_basis: savedMedia.rights_basis,
    rights_details: savedMedia.rights_details,
    editorial_approved: savedMedia.editorial_approved === true,
    rights_override_approved_at: savedMedia.rights_override_approved_at,
    rights_status: savedMedia.rights_status,
    previewOnly: !imageIsPublishable(savedMedia),
    label: savedMedia.caption || savedMedia.alt_text || fallbackLabel
  });
  const validPermissionStatus = value => PHOTO_PERMISSION_OPTIONS.some(item => item.value === value);
  const saveMediaRecord = async ({ values, publicUrl, filename, mimeType, storagePath, dimensions }) => {
    const rightsRecord = imageRightsRecord(values, { originalFileUrl: publicUrl, defaultProvider: 'internal_library' });
    const rightsPayload = imageRightsPayload(rightsRecord, validateImageRights(rightsRecord));
    const altText = String(values.get('alt_text') || '').trim() || defaultImageAlt(filename, s.title);
    const controller = new AbortController();
    const request = sb.from('media').insert({
      storage_path: storagePath,
      public_url: publicUrl,
      filename,
      mime_type: mimeType,
      width: dimensions?.width || null,
      height: dimensions?.height || null,
      alt_text: altText,
      caption: String(values.get('caption') || '').trim() || null,
      credit: rightsPayload.credit_line || null,
      source_url: rightsPayload.source_page_url,
      story_id: id,
      ...rightsPayload,
      uploaded_by: p.id
    }).select(mediaFields).single().abortSignal(controller.signal);
    return withPhotoTimeout(request, PHOTO_RECORD_TIMEOUT_MS, 'The media record did not respond within 20 seconds. Nothing was attached. Try again.', { onTimeout: () => controller.abort() });
  };
  photoUploadForm.onsubmit = async event => {
    event.preventDefault();
    showPhotoMessage('');
    if (!id) return showPhotoMessage('Save the story before adding media so it stays attached to this article.');
    const values = new FormData(photoUploadForm);
    const file = photoFileInput.files?.[0];
    const fileError = validateStoryMedia({ file });
    if (fileError) return showPhotoMessage(fileError);
    if (!validPermissionStatus(values.get('permission_status'))) return showPhotoMessage('Choose a permission status before saving the media.');
    try {
    setBusy(photoUploadForm, true, 'Saving media…');
    setPhotoProgress(photoUploadProgress, photoUploadProgressLabel, `Uploading ${storyMediaType(file) === 'video' ? 'video' : 'image'}…`);
    const storagePath = storyMediaPath(p.id, file, randomId());
    const uploadRequest = sb.storage.from(STORY_MEDIA_BUCKET).upload(storagePath, file, { cacheControl: '31536000', contentType: file.type, upsert: false });
    let uploadResult;
    try {
      uploadResult = await withPhotoTimeout(uploadRequest, PHOTO_UPLOAD_TIMEOUT_MS, 'The media upload did not finish within 45 seconds. Check your connection and try again.');
    } catch (error) {
      // Storage uploads do not expose an abort signal. If a timed-out request
      // eventually succeeds, remove the late object instead of leaving it orphaned.
      void uploadRequest.then(result => {
        if (!result?.error) return withPhotoTimeout(sb.storage.from(STORY_MEDIA_BUCKET).remove([storagePath]), PHOTO_CLEANUP_TIMEOUT_MS, 'Late upload cleanup timed out.');
      }).catch(cleanupError => console.warn('Late photo upload cleanup failed', cleanupError));
      throw error;
    }
    const { error: uploadError } = uploadResult;
    if (uploadError) {
      setBusy(photoUploadForm, false);
      setPhotoProgress(photoUploadProgress, photoUploadProgressLabel, '', false);
      return showPhotoMessage(`${file.name} could not be uploaded. ${uploadError.message || 'Check the file and try again.'}`);
    }
    const { data: publicData } = sb.storage.from(STORY_MEDIA_BUCKET).getPublicUrl(storagePath);
    const publicUrl = mediaUrl(publicData?.publicUrl);
    setPhotoProgress(photoUploadProgress, photoUploadProgressLabel, 'Saving media record…');
    const inspectUrl = URL.createObjectURL(file);
    const dimensions = storyMediaType(file) === 'video'
      ? await inspectVideoSource(inspectUrl, { revoke: true })
      : await inspectPhotoSource(inspectUrl, { revoke: true });
    const { data: savedMedia, error: mediaError } = await saveMediaRecord({ values, publicUrl, filename: file.name, mimeType: file.type, storagePath, dimensions });
    if (mediaError || !savedMedia) {
      setBusy(photoUploadForm, false);
      setPhotoProgress(photoUploadProgress, photoUploadProgressLabel, '', false);
      void withPhotoTimeout(sb.storage.from(STORY_MEDIA_BUCKET).remove([storagePath]), PHOTO_CLEANUP_TIMEOUT_MS, 'Media cleanup timed out.')
        .catch(cleanupError => console.warn('Media cleanup failed', cleanupError));
      return showPhotoMessage(`${file.name} uploaded, but its media record could not be saved. ${mediaError?.message || 'Try again.'}`);
    }
    addToMediaLibrary(mediaItem(savedMedia, file.name));
    renderAttachedMedia();
    photoUploadForm.reset();
    clearStagedPhotoUrl();
    renderPhotoUploadPreview();
    setBusy(photoUploadForm, false);
    setPhotoProgress(photoUploadProgress, photoUploadProgressLabel, '', false);
    showPhotoMessage('Media saved and attached to this story.', 'ok');
    } catch (error) {
      setBusy(photoUploadForm, false);
      setPhotoProgress(photoUploadProgress, photoUploadProgressLabel, '', false);
      showPhotoMessage(error?.message || 'The media could not be saved. Check the file and try again.');
    }
  };
  photoUrlForm.onsubmit = async event => {
    event.preventDefault();
    showPhotoMessage('');
    if (!id) return showPhotoMessage('Save the story before adding media so it stays attached to this article.');
    const values = new FormData(photoUrlForm);
    const imageUrl = String(values.get('image_url') || '').trim();
    const mimeType = externalMediaMimeType(imageUrl);
    const urlError = validateImageUrl(imageUrl);
    if (urlError) return showPhotoMessage(urlError);
    if (!validPermissionStatus(values.get('permission_status'))) return showPhotoMessage('Choose a permission status before saving the media.');
    try {
    setBusy(photoUrlForm, true, 'Saving media…');
    setPhotoProgress(photoUrlProgress, photoUrlProgressLabel, 'Checking media URL…');
    const dimensions = storyMediaType(mimeType) === 'video' ? await inspectVideoSource(imageUrl) : await inspectPhotoSource(imageUrl);
    if (dimensions.timedOut) {
      setBusy(photoUrlForm, false);
      setPhotoProgress(photoUrlProgress, photoUrlProgressLabel, '', false);
      return showPhotoMessage('That media URL did not respond within 12 seconds. Use a direct public media URL or upload the file instead.');
    }
    if (!dimensions.width || !dimensions.height) {
      setBusy(photoUrlForm, false);
      setPhotoProgress(photoUrlProgress, photoUrlProgressLabel, '', false);
      return showPhotoMessage('That URL did not return loadable media. Check the URL and try again.');
    }
    const { data: savedMedia, error: mediaError } = await saveMediaRecord({
      values,
      publicUrl: imageUrl,
      filename: externalImageFilename(imageUrl),
      mimeType,
      storagePath: 'external/' + randomId(),
      dimensions
    });
    if (mediaError || !savedMedia) {
      setBusy(photoUrlForm, false);
      setPhotoProgress(photoUrlProgress, photoUrlProgressLabel, '', false);
      return showPhotoMessage(`The media reference could not be saved. ${mediaError?.message || 'Try again.'}`);
    }
    addToMediaLibrary(mediaItem(savedMedia, externalImageFilename(imageUrl)));
    renderAttachedMedia();
    photoUrlForm.reset();
    photoUrlPreview.innerHTML = '<p class="field-note">A preview will appear after you enter a URL.</p>';
    photoUrlForm.hidden = true;
    document.querySelector('[data-toggle-photo-url]').textContent = 'Add media by URL';
    setBusy(photoUrlForm, false);
    setPhotoProgress(photoUrlProgress, photoUrlProgressLabel, '', false);
    showPhotoMessage('Media saved and attached to this story.', 'ok');
    } catch (error) {
      setBusy(photoUrlForm, false);
      setPhotoProgress(photoUrlProgress, photoUrlProgressLabel, '', false);
      showPhotoMessage(error?.message || 'The media reference could not be saved. Check the URL and try again.');
    }
  };
  document.querySelectorAll('[data-open-article-preview]').forEach(button => button.addEventListener('click', openPreview));
  document.querySelector('[data-close-article-preview]')?.addEventListener('click', closePreview);
  document.querySelectorAll('[data-preview-viewport]').forEach(button => {
    button.onclick = () => {
      previewStage.dataset.viewport = button.dataset.previewViewport;
      document.querySelectorAll('[data-preview-viewport]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    };
  });
  document.getElementById('preview-composition').onchange = event => { presentationDraft.composition = event.target.value; setDirty(); renderPreview(); };
  document.getElementById('preview-accent').onchange = event => { presentationDraft.accent = event.target.value; setDirty(); renderPreview(); };
  heroSelect.onchange = event => {
    presentationDraft.hero = event.target.value ? { ...mediaById.get(event.target.value), crop: 'auto', focalX: 50, focalY: 50 } : null;
    setDirty();
    renderPreview();
  };
  document.querySelector('[data-remove-hero]').onclick = () => { presentationDraft.hero = null; heroSelect.value = ''; setDirty(); renderPreview(); };
  for (const id of ['preview-hero-crop', 'preview-hero-fit', 'preview-focal-x', 'preview-focal-y']) {
    document.getElementById(id).oninput = () => {
      if (!presentationDraft.hero) return;
      presentationDraft.hero.crop = document.getElementById('preview-hero-crop').value;
      presentationDraft.hero.fit = document.getElementById('preview-hero-fit').value === 'contain' ? 'contain' : 'cover';
      presentationDraft.hero.focalX = Number(document.getElementById('preview-focal-x').value);
      presentationDraft.hero.focalY = Number(document.getElementById('preview-focal-y').value);
      setDirty();
      renderPreview();
    };
  }
  document.getElementById('preview-detour-label').oninput = event => { detourDraft.label = event.target.value; };
  document.getElementById('preview-detour-text').oninput = event => { detourDraft.text = event.target.value; };
  document.getElementById('preview-detour-after').onchange = event => { detourDraft.afterBlock = Number(event.target.value); };
  document.querySelector('[data-add-detour]').onclick = () => {
    const text = detourDraft.text.trim();
    if (!text) return showPreviewMessage('Add detour text before saving the card.');
    presentationDraft.detours.push({
      id: `detour-${randomId()}`,
      visible: true,
      label: detourDraft.label.trim() || 'The detour',
      text,
      afterBlock: Number(detourDraft.afterBlock) || 0
    });
    presentationDraft.detour = presentationDraft.detours[0];
    detourDraft = { label: '', text: '', afterBlock: 0 };
    showPreviewMessage('');
    setDirty();
    renderPreview();
  };
  document.querySelector('[data-add-inline-embed]').onclick = () => {
    const embedInput = document.getElementById('preview-inline-embed-url');
    const embed = parseStoryEmbed(embedInput.value);
    if (!embed) return showPreviewMessage('Paste a valid YouTube video URL or X post URL.');
    presentationDraft.inlineImages.push({
      id: `embed:${randomId()}`,
      media_type: 'embed',
      embed_provider: embed.provider,
      embed_url: embed.embedUrl,
      source_url: embed.sourceUrl,
      label: `${embed.provider === 'youtube' ? 'YouTube' : 'X'} video`,
      alt_text: `${embed.provider === 'youtube' ? 'YouTube' : 'X'} video`,
      afterBlock: Number(document.getElementById('preview-inline-after').value || 0),
      layout: 'wide',
      treatment: 'framed',
      caption: document.getElementById('preview-inline-caption').value.trim(),
      credit: document.getElementById('preview-inline-credit').value.trim()
    });
    embedInput.value = '';
    showPreviewMessage('Video added to the story. Save the article to keep it.');
    setDirty();
    renderPreview();
  };
  document.querySelector('[data-add-inline-image]').onclick = () => {
    const source = mediaById.get(inlineSelect.value);
    if (!source) return showPreviewMessage('Choose media before adding it.');
    presentationDraft.inlineImages.push({
      ...source,
      id: `${source.id}:${Date.now()}`,
      sourceId: source.id,
      afterBlock: Number(document.getElementById('preview-inline-after').value || 0),
      layout: document.getElementById('preview-inline-layout').value,
      treatment: !isVideoItem(source) && framelessControl.checked ? 'frameless' : 'framed',
      alt_text: document.getElementById('preview-inline-alt').value.trim() || source.alt_text || '',
      caption: document.getElementById('preview-inline-caption').value.trim() || source.caption || '',
      credit: document.getElementById('preview-inline-credit').value.trim() || source.credit || ''
    });
    showPreviewMessage('');
    setDirty();
    renderPreview();
  };
  storyForm.addEventListener('input', () => { if (!previewWorkspace.hidden) renderPreview(); });
  storyForm.addEventListener('change', () => { if (!previewWorkspace.hidden) renderPreview(); });
  document.querySelectorAll('[data-preview-decision]').forEach(button => {
    button.onclick = () => {
      const submitButton = storyForm.querySelector(`[name="editor_decision"][value="${button.dataset.previewDecision}"]`);
      if (!submitButton) return;
      closePreview();
      submitButton.click();
    };
  });

  async function saveStory(e) {
    e.preventDefault();
    const form = e.currentTarget;
    showFormMessage(form, '');
    const f = new FormData(form), beatIds = f.getAll('beat').map(String), tags = String(f.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean), payload = Object.fromEntries(f);
    const secondarySectionIds = [...new Set(f.getAll('secondary_section').map(String))].filter(sectionId => sectionId !== payload.section_id);
    const editorDecision = e.submitter?.name === 'editor_decision' ? e.submitter.value : '';
    const nextStatus = editorDecision === 'approve' ? 'fact_check' : editorDecision === 'return' ? 'draft' : String(payload.status || 'idea');
    if (!availableStatuses.includes(nextStatus) && !(['admin', 'editor'].includes(p.role) && ['fact_check', 'draft'].includes(nextStatus))) {
      showFormMessage(form, 'That workflow change is not available for this account.');
      return;
    }
    payload.status = nextStatus;
    payload.title = String(payload.title || '').trim();
    payload.dek = String(payload.dek || '').trim();
    payload.summary = String(payload.summary || '').trim();
    payload.body = String(payload.body || '').trim();
    payload.slug = slugify(payload.slug || payload.title);
    payload.seo_title = String(payload.seo_title || '').trim() || payload.title;
    payload.seo_description = String(payload.seo_description || '').trim() || payload.dek;
    payload.author_id = payload.author_id || s.author_id || p.id;
    payload.editor_id = p.role === 'contributor' ? (s.editor_id || null) : (payload.editor_id || null);
    const editorialScore = String(payload.editorial_score || '').trim();
    if (editorialScore && (!Number.isFinite(Number(editorialScore)) || Number(editorialScore) < 0 || Number(editorialScore) > 10)) {
      showFormMessage(form, 'Editorial score must be a number from 0 to 10, or left blank.');
      return;
    }
    payload.editorial_score = editorialScore ? Number(editorialScore) : null;
    payload.reading_time_minutes = Math.max(1, Math.ceil(payload.body.split(/\s+/).filter(Boolean).length / 220));
    payload.presentation = presentationForSave(presentationDraft);
    const publishedDate = payload.published_at ? new Date(payload.published_at) : null;
    const scheduledDate = payload.scheduled_for ? new Date(payload.scheduled_for) : null;
    payload.published_at = publishedDate && !Number.isNaN(publishedDate.getTime()) ? publishedDate.toISOString() : (s.published_at || null);
    payload.scheduled_for = scheduledDate && !Number.isNaN(scheduledDate.getTime()) ? scheduledDate.toISOString() : null;
    if (nextStatus === 'scheduled' && (!scheduledDate || Number.isNaN(scheduledDate.getTime()) || scheduledDate <= new Date())) {
      showFormMessage(form, 'Choose a future date and time before scheduling this story.');
      return;
    }
    if (nextStatus === 'published') payload.published_at = s.published_at || payload.published_at || new Date().toISOString();
    if (nextStatus === 'fact_check') payload.scheduled_for = null;
    delete payload.beat;
    delete payload.tags;
    delete payload.secondary_section;
    let approvalSourceCount = validSourceCount;
    if (editorDecision === 'approve' && !approvalSourceCount) {
      const { data: restoredSourceCount, error: restoreSourceError } = await sb.rpc('restore_pipeline_sources', { p_story_id: id });
      if (restoreSourceError) {
        setBusy(form, false);
        showFormMessage(form, 'The discovered sources could not be restored. Try again or return to the pipeline review package.');
        return;
      }
      approvalSourceCount = Number(restoredSourceCount || 0);
    }
    if (['fact_check', 'published'].includes(nextStatus) && (!approvalSourceCount || !payload.editor_id || !payload.section_id || !payload.title || !payload.dek || !payload.body)) {
      showFormMessage(form, 'Before approval, assign an editor, complete the title, dek, body, and primary lens, and add a valid source.');
      return;
    }
    setBusy(form, true, 'Saving…');
    const expectedRevision = Number(s.revision_number || 1);
    const { data: savedResult, error: saveError } = id
      ? await sb.rpc('save_story', {
        p_story_id: id,
        p_expected_revision: expectedRevision,
        p_patch: payload,
        p_beat_ids: beatIds,
        p_tags: tags,
        p_section_ids: secondarySectionIds
      })
      : await sb.from('stories').insert(payload).select('id').single();
    const saved = Array.isArray(savedResult) ? savedResult[0] : savedResult;
    if (saveError || !saved) {
      setBusy(form, false);
      showFormMessage(form, !saveError ? 'This story changed in another session. Reload this editor, then save your edits again.' : saveStoryFailureMessage(saveError));
      return;
    }
    if (!id) {
      const { error: classificationError } = await sb.rpc('save_story', { p_story_id: saved.id, p_expected_revision: 1, p_patch: {}, p_beat_ids: beatIds, p_tags: tags, p_section_ids: secondarySectionIds });
      if (classificationError) { setBusy(form, false); showFormMessage(form, 'The draft was saved, but its classification was not added. Open it from the newsroom and try again.'); return; }
    }
    dirty = false;
    if (editorDecision === 'approve') location.href = `/newsroom/stories?status=ready#candidate-${saved.id}`;
    else if (editorDecision === 'return') location.href = '/newsroom/stories';
    else if (nextStatus === 'fact_check') location.href = `/newsroom/on-deck#story-${saved.id}`;
    else location.href = '/newsroom/' + saved.id;
  }
  document.querySelector('[data-hide-story]')?.addEventListener('click', () => {
    if (!confirm('Take this post down now? It will remain available to edit or restore in the newsroom.')) return;
    document.querySelector('#story-status').value = 'hidden';
    storyForm.requestSubmit();
  });

  if (sourceForm) {
    sourceForm.onsubmit = async e => {
      e.preventDefault();
      const form = e.currentTarget;
      showFormMessage(form, '');
      const values = Object.fromEntries(new FormData(form));
      const url = externalUrl(values.url);
      if (!url) {
        showFormMessage(form, 'Use a complete http:// or https:// source URL without embedded credentials.');
        return;
      }
      setBusy(form, true, 'Adding…');
      const { error } = await sb.from('sources').insert({
        story_id: id,
        title: String(values.title || '').trim(),
        publisher: String(values.publisher || '').trim() || null,
        url,
        normalized_url: url,
        source_type: values.source_type,
        accessed_at: new Date().toISOString(),
        sort_order: safeSources.length + 1,
        created_by: p.id
      });
      if (error) {
        setBusy(form, false);
        showFormMessage(form, 'The source could not be added. Check whether that URL is already on this story.');
        return;
      }
      location.reload();
    };
  }
}

/* ---------- Router ---------- */

async function route() {
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  if (pathname === '/') return home();
  if (pathname === '/latest') return latest();
  if (pathname === '/topics') return topics();
  if (/^\/topics\/[^/]+$/.test(pathname)) return topic(pathname.split('/')[2]);
  if (/^\/sections\/[^/]+$/.test(pathname)) return section(pathname.split('/')[2]);
  if (/^\/stories\/[^/]+$/.test(pathname)) return showStory(pathname.split('/')[2]);
  if (pathname === '/search') return search();
  if (pathname === '/newsroom') return newsroom();
  if (pathname === '/newsroom/pitches') return pitchesInbox();
  if (pathname === '/newsroom/stories') return storiesInbox();
  if (pathname === '/newsroom/published') return publishedStories();
  if (pathname === '/newsroom/homepage') return homepageRankingNewsroom();
  if (pathname === '/newsroom/ideas') return ideas();
  if (pathname === '/newsroom/editorial-candidates') return editorialCandidates();
  if (pathname === '/newsroom/settings') return newsroomSettings();
  if (pathname === '/newsroom/analytics') return analyticsDashboard();
  if (pathname === '/newsroom/assignment') return articleAssignment();
  if (pathname === '/newsroom/on-deck') return onDeck();
  if (pathname === '/newsroom/review') return reviewQueue();
  if (/^\/newsroom\/review\/[0-9a-f-]+$/i.test(pathname)) return reviewPackage(pathname.split('/')[3]);
  if (pathname === '/newsroom/pipeline') return pipelineControls();
  if (/^\/newsroom\/pipeline\/jobs\/[0-9a-f-]{36}$/i.test(pathname)) {
    return pipelineJobDetail(pathname.split('/')[4]);
  }
  if (pathname === '/newsroom/new') return edit();
  if (/^\/newsroom\/[0-9a-f-]{36}$/i.test(pathname)) return edit(pathname.split('/')[2]);
  title('Not found');
  app.innerHTML = notFound();
}

chrome();
route().then(() => alignNewsroomTaxonomy()).catch(error => {
  console.error('Anyways route failed', error);
  title('Temporarily unavailable');
  app.innerHTML = unavailable();
  document.querySelector('.retry-button')?.addEventListener('click', () => location.reload());
});
