import { createClient } from '@supabase/supabase-js';
import { BEAT_ORDER, EDITORIAL_CLASSIFICATION_HELP, SECTION_ORDER, SECTION_PROMISES, STORY_FORMS } from './editorial.mjs';
import { PIPELINE_QUEUE_STATUSES, filterPipelineQueue, lineDiff, pipelineMetadata } from './newsroom-pipeline.mjs';
import { materializationState } from './pipeline/materialization.mjs';
import { ACTIVE_PIPELINE_JOB_STATUSES, PIPELINE_JOB_STATUSES, candidatePipelineAction, concisePipelineError, pipelineReviewHref, validateNewsroomJobRequest } from './newsroom-pipeline-controls.mjs';
import { ARTICLE_ACCENTS, ARTICLE_COMPOSITIONS, INLINE_IMAGE_LAYOUTS, normalizePresentation, renderArticle } from './article-renderer.mjs';
import { MEDIA_RIGHTS_DECISIONS, STORY_MEDIA_BUCKET, presentationForSave, storyMediaPath, validateStoryImage, validateStoryImageBatch } from './newsroom-media.mjs';

/* Anyways · public edition view layer.
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

/* First-party reader signals. This deliberately avoids IP addresses, user
   agents, full referrer URLs, and all Newsroom routes. */
function analyticsSessionId() {
  try {
    const existing = sessionStorage.getItem('anyways.analytics.session');
    if (existing) return existing;
    const created = crypto.randomUUID();
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

function installAnalytics() {
  if (!isPublicRoute || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  const sessionId = analyticsSessionId();
  if (!sessionId) return;
  const path = location.pathname;
  const referrerHost = analyticsReferrerHost();
  const send = (eventType, eventValue = null, detail = '') => {
    const payload = JSON.stringify({ event_type: eventType, session_id: sessionId, path, referrer_host: referrerHost, event_value: eventValue, detail });
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

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const humanize = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
const workflowLabel = s => s === 'fact_check' ? 'On deck' : s === 'hidden' ? 'Hidden' : humanize(s);
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

function mediaUrl(value) {
  const raw = String(value || '');
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return externalUrl(raw);
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
  region.hidden = !message;
}

const dLong = d => new Date(d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const dShort = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const dDateTime = d => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
const localDateTimeValue = d => {
  const date = new Date(d);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

/* Every published story carries an edition number: № 014. */
const no = n => n ? `№ ${String(n).padStart(3, '0')}` : '';
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
  'seo_title', 'seo_description', 'featured', 'homepage_priority',
  'sections(name,slug)', 'story_beats(beats(name,slug))', 'story_tags(tags(name,slug))',
  'profiles!stories_author_id_fkey(name,slug)'
].join(',');

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

/* Signature 1: Riso Folio. */
function folio(n, size = '') {
  if (!n) return '';
  return `<span class="riso-folio${size ? ` riso-folio--${size}` : ''}" aria-label="Story number ${n}">№ ${String(n).padStart(3, '0')}</span>`;
}

/* Signature 2: Knockout Window. Real story media uses the same notched frame
   as the type-only fallback, so photography is optional rather than invented. */
function knockoutWindow(s, n, opts = {}) {
  // The live story and the edition cover must resolve the same editorial hero.
  // presentation.hero carries the selected crop and can exist without the
  // legacy hero_media_id pointer; retain that pointer as a fallback.
  const candidate = s.presentation?.hero || s.hero_media;
  const imageUrl = candidate ? mediaUrl(candidate.public_url || candidate.url || candidate.original_url) : '';
  const media = candidate && imageUrl ? candidate : null;
  const className = opts.className ? ` ${opts.className}` : '';
  const label = esc(opts.label || s.sections?.name || 'Anyways');
  const caption = media && (media.caption || media.credit)
    ? `<figcaption><span>${esc(media.caption || media.alt_text || '')}</span>${media.credit ? `<span>${esc(media.credit)}</span>` : ''}</figcaption>`
    : '';
  const content = media
    ? `<img src="${esc(imageUrl)}" alt="${esc(media.alt_text || '')}" loading="${opts.eager ? 'eager' : 'lazy'}" decoding="async">`
    : `<div class="window-type" aria-hidden="true">
        <span class="window-kicker">${label}</span>
        <span class="window-glyph">${esc((s.title || 'A').trim().charAt(0).toUpperCase())}</span>
        <span class="window-dots">…</span>
        <span class="window-number">${n ? String(n).padStart(3, '0') : 'ANY'}</span>
      </div>`;
  return `<figure class="knockout-window${media ? ' has-media' : ' is-type'}${className}">
    <span class="window-registration" aria-hidden="true"></span>
    <div class="window-cut">${content}</div>
    ${caption}
  </figure>`;
}

/* Signature 3: The Detour. Articles receive exactly one; edition and index
   pages reuse the same recognizable editorial interruption. */
function detour(s, n, opts = {}) {
  const label = esc(opts.label || 'The detour');
  const text = esc(opts.text || s.summary || s.dek || '');
  const linkedTitle = opts.href ? `<a class="detour-link" href="${esc(opts.href)}">${esc(opts.linkTitle || s.title)} →</a>` : '';
  return `<aside class="detour${opts.className ? ` ${opts.className}` : ''}">
    <span class="detour-label">${label}</span>
    <p>${text}</p>
    <div class="detour-foot">${folio(n, 'small')}${linkedTitle}</div>
    <span class="detour-dots" aria-hidden="true">…</span>
  </aside>`;
}

/* Functional article marginalia, kept deliberately quieter than the three
   signature devices. */
function articleRail(s, sources, nums, pool) {
  const notes = [];
  const beats = (s.story_beats || []).map(x => x.beats).filter(Boolean);
  const tags = (s.story_tags || []).map(x => x.tags).filter(Boolean);
  if (beats.length) notes.push(`<div><span class="rail-label">Beats</span><p>${beats.map(t => `<a href="/topics/${esc(t.slug)}">${esc(t.name)}</a>`).join(' / ')}</p></div>`);
  if (tags.length) notes.push(`<div><span class="rail-label">Tags</span><p>${tags.map(t => esc(t.name)).join(' / ')}</p></div>`);
  if (sources.length) notes.push(`<div><span class="rail-label">The record</span><p>${sources.length} source${sources.length === 1 ? '' : 's'} on file, beginning with ${esc(sources[0].publisher || sources[0].title)}.</p></div>`);
  const arc = pool.filter(x => x.id !== s.id);
  if (arc.length) {
    const pick = arc[hash(s.id || s.slug) % arc.length];
    notes.push(`<div><span class="rail-label">From the archive</span><p>${folio(nums.get(pick.id), 'tiny')} <a href="/stories/${esc(pick.slug)}">${esc(pick.title)}</a></p></div>`);
  }
  return notes.length ? `<aside class="article-rail" aria-label="Story notes">${notes.join('')}</aside>` : '';
}

/* Body composition: readable text plus one guaranteed Detour. */
function composeBody(s, html, nums) {
  const blocks = html.split(/(?=<h2|<h3|<p>|<blockquote>|<ul>|<ol>|<hr>)/).filter(Boolean);
  if (!blocks.length) return detour(s, nums.get(s.id), { className: 'detour--article' });
  const out = [];
  const breakAt = Math.min(blocks.length - 1, Math.max(0, Math.round((blocks.length - 1) * 0.45)));
  for (let i = 0; i < blocks.length; i++) {
    out.push(blocks[i]);
    if (i === breakAt) out.push(detour(s, nums.get(s.id), { className: 'detour--article' }));
  }
  return out.join('');
}

function presentationBody(s) {
  return String(s.body || '').trim();
}

/* Markdown: groups consecutive list items, same syntax as the local application. */
function inline(s) { return s.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>'); }
function markdown(text) {
  const lines = String(text || '').split('\n'); let html = '', list = null;
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of lines) {
    if (line.startsWith('### ')) { close(); html += `<h3>${inline(esc(line.slice(4)))}</h3>`; }
    else if (line.startsWith('## ')) { close(); html += `<h2>${inline(esc(line.slice(3)))}</h2>`; }
    else if (line.startsWith('> ')) { close(); html += `<blockquote>${inline(esc(line.slice(2)))}</blockquote>`; }
    else if (/^\d+\. /.test(line)) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(esc(line.replace(/^\d+\. /, '')))}</li>`; }
    else if (line.startsWith('- ')) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(esc(line.slice(2)))}</li>`; }
    else if (line === '---') { close(); html += '<hr>'; }
    else if (line) { close(); html += `<p>${inline(esc(line))}</p>`; }
    else close();
  }
  close(); return html;
}

/* ---------- Data (same records and permissions, with existing media hydrated) ---------- */

async function session() {
  const { data, error } = await sb.auth.getUser();
  if (error) return null;
  return data.user;
}
async function profile() {
  const u = await session();
  if (!u) return null;
  return dataOf(sb.from('profiles').select('id,name,slug,role').eq('id', u.id).maybeSingle(), 'profile');
}
async function hydrateMedia(stories) {
  const ids = [...new Set(stories.map(s => s.hero_media_id).filter(Boolean))];
  if (!ids.length) return stories;
  const data = await dataOf(
    sb.from('media').select('id,public_url,alt_text,caption,credit').in('id', ids),
    'story media'
  ) || [];
  const byId = new Map(data.map(m => [m.id, m]));
  return stories.map(s => ({ ...s, hero_media: byId.get(s.hero_media_id) || null }));
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

/* ---------- Chrome: the nameplate and the colophon ---------- */

async function chrome() {
  const dateEl = document.querySelector('#dateline-date'), countEl = document.querySelector('#dateline-count'), yearEl = document.querySelector('#colophon-year');
  if (dateEl) dateEl.textContent = dLong(new Date());
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  try {
    const sections = await allSections();
    const nav = document.querySelector('#index-nav');
    if (nav) {
      const current = location.pathname.startsWith('/sections/') ? location.pathname.split('/')[2] : null;
      const links = sections.map(s => `<a class="section-link" href="/sections/${esc(s.slug)}" ${current === s.slug ? 'aria-current="page"' : ''}>${esc(s.name)}</a>`).join('');
      nav.insertAdjacentHTML('afterbegin', `<span class="section-links">${links}</span>`);
    }
    const colophonSections = document.querySelector('#colophon-sections');
    if (colophonSections) colophonSections.innerHTML = sections.map(s => `<li><a href="/sections/${esc(s.slug)}">${esc(s.name)}</a></li>`).join('');
  } catch { /* navigation degrades to the desk links */ }
  const deskCurrent = location.pathname === '/topics' || location.pathname.startsWith('/topics/') ? 'topics'
    : location.pathname === '/search' ? 'search'
    : location.pathname.startsWith('/newsroom') ? 'newsroom' : null;
  if (deskCurrent) document.querySelector(`#index-nav [data-current="${deskCurrent}"]`)?.setAttribute('aria-current', 'page');
  try {
    const { count, error } = await sb.from('stories').select('id', { count: 'exact', head: true }).eq('status', 'published').lte('published_at', new Date().toISOString());
    if (error) throw error;
    if (countEl && count != null) countEl.textContent = `${count} stories on file · Cover only what matters`;
  } catch { /* keep the dateline promise line */ }
}

/* ---------- Shared story references: one record, several editorial roles ---------- */

function entry(s, nums, opts = {}) {
  const n = nums.get(s.id), author = s.profiles?.name;
  const stamp = opts.status ? `<span class="stamp st-${s.status}">${esc(s.status.replace('_', ' '))}</span>` : '';
  const date = s.published_at && isPublished(s) ? dShort(s.published_at) : (opts.status ? '' : esc(s.status));
  const href = opts.href || `/stories/${esc(s.slug)}`;
  const variantName = opts.variant || opts.thumb || 'ledger';
  const variant = ` entry--${variantName}`;
  const scope = opts.acc ? ` a-${opts.acc}` : '';
  const window = opts.window
    ? `<a class="entry-window" href="${href}" tabindex="-1" aria-hidden="true">${knockoutWindow(s, n, { className: `window--${opts.window}` })}</a>`
    : '';
  const level = opts.level || 3;
  return `<article class="entry${variant}${scope}">
  <div class="entry-folio">${folio(n, opts.folioSize || 'small')}</div>
  <div class="entry-body">
    <h${level}><a href="${href}">${esc(s.title)}</a></h${level}>
    <p class="dek">${esc(s.dek)}</p>
    <div class="meta-line">
      ${stamp}
      <span class="section-tag"><a href="/sections/${esc(s.sections?.slug || '')}">${esc(s.sections?.name || '')}</a></span>
      ${author ? `<span>By ${esc(author)}</span>` : ''}
      ${date ? `<span>${date}</span>` : ''}
      <span>${s.reading_time_minutes} min</span>
    </div>
  </div>
  ${window}
</article>`;
}

/* Table of contents line with dot leaders. */
function tocLine(s, nums) {
  return `<li><div class="toc-line"><span class="t"><a href="/stories/${esc(s.slug)}">${esc(s.title)}</a></span><span class="dots" aria-hidden="true"></span><span class="numeral">${s.published_at ? dShort(s.published_at) : ''}</span></div></li>`;
}

const emptyNote = t => `<p class="empty-note">${t}</p>`;
const notFound = () => {
  document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,follow');
  return `<div class="not-found"><div class="endmark" aria-hidden="true">…</div><h1>This page is not in the edition.</h1><p class="meta-line"><a class="text-link" href="/">Return to the front page</a></p></div>`;
};
const unavailable = () => {
  document.querySelector('meta[name="robots"]')?.setAttribute('content', 'noindex,nofollow');
  return `<div class="not-found error-state" role="alert"><div class="endmark" aria-hidden="true">…</div><h1>The edition is temporarily unavailable.</h1><p>Nothing was lost. Check your connection and try the page again.</p><button class="retry-button" type="button">Try again</button></div>`;
};

function title(t, description = '') {
  document.title = t ? `${t} | Anyways` : 'Anyways';
  if (description) document.querySelector('meta[name="description"]')?.setAttribute('content', description);
}

/* ---------- Homepage: an edition, not a feed ---------- */

async function home() {
  const stories = await published(), nums = numerals(stories), sections = await allSections(), acc = accents(stories);
  const lead = stories[0];
  title();
  if (!lead) {
    app.innerHTML = detour({ title: 'The first edition', dek: 'The desk is setting its first edition.' }, null, { label: 'Soon / Anyways' });
    return;
  }
  const briefing = stories.filter(s => s.id !== lead.id).slice(0, 4);
  const rest = stories.filter(s => s.id !== lead.id && !briefing.some(b => b.id === s.id));
  const pick = rest.length ? rest[Math.floor(rest.length / 2)] : null;
  const featured = new Set([lead.id, ...briefing.map(s => s.id), ...(pick ? [pick.id] : [])]);
  const modes = ['ledger', 'split', 'scatter'];
  const sectionGroups = sections.map(sec => {
    const xs = stories.filter(s => s.section_id === sec.id && !featured.has(s.id)).slice(0, 4);
    xs.forEach(s => featured.add(s.id));
    return xs.length ? { sec, xs } : null;
  }).filter(Boolean);
  const sectionRows = sectionGroups.map(({ sec, xs }, sectionIndex) => {
    const mode = modes[sectionIndex % modes.length];
    const variants = mode === 'ledger' ? ['ledger', 'ledger', 'ledger', 'ledger']
      : mode === 'split' ? ['poster', 'compact', 'compact', 'strip']
      : ['tall', 'offset', 'compact', 'strip'];
    return `<section class="section-module section-module--${mode} a-${acc.get(xs[0].id)}">
      <header class="section-module-head">
        <span class="section-count">${String(sectionIndex + 1).padStart(2, '0')} / ${String(sectionGroups.length).padStart(2, '0')}</span>
        <h2 class="section-name"><a href="/sections/${esc(sec.slug)}">${esc(sec.name)}</a></h2>
        <p class="section-promise">${esc(promises[sec.id] || '')}</p>
        <a class="all-link" href="/sections/${esc(sec.slug)}">All ${esc(sec.name.replace(/\.\.\./, '…'))} →</a>
      </header>
      <div class="section-stories">${xs.map((s, i) => entry(s, nums, {
        acc: acc.get(s.id),
        variant: variants[i % variants.length],
        window: (mode === 'split' && i === 0) || (mode === 'scatter' && i < 2) ? (i ? 'square' : 'wide') : '',
        folioSize: i === 0 && mode !== 'ledger' ? 'medium' : 'tiny'
      })).join('')}</div>
    </section>`;
  }).join('');
  app.innerHTML = `
    <section class="edition-lead a-${acc.get(lead.id)}">
      <div class="lead-layout">
        <header class="lead-copy">
          <div class="lead-kicker"><span>Front of edition</span><a href="/sections/${esc(lead.sections?.slug || '')}">${esc(lead.sections?.name || '')}</a></div>
          ${folio(nums.get(lead.id), 'hero')}
          <h1><a href="/stories/${esc(lead.slug)}">${esc(lead.title)}</a></h1>
          <p class="standfirst">${esc(lead.dek)}</p>
          <div class="byline">${lead.profiles?.name ? `<span>By ${esc(lead.profiles.name)}</span>` : ''}<span>${dLong(lead.published_at)}</span><span>${lead.reading_time_minutes} min read</span></div>
        </header>
        <a class="lead-window" href="/stories/${esc(lead.slug)}" tabindex="-1" aria-hidden="true">${knockoutWindow(lead, nums.get(lead.id), { className: 'window--hero', label: 'Cover / Anyways', eager: true })}</a>
      </div>
    </section>
    ${briefing.length ? `<section class="movement">
      <div class="movement-head"><div><span class="label">The briefing</span><h2>Four ways in.</h2></div><span class="meta-line faint">Mixed scale / one edition / no autopilot</span></div>
      <div class="briefing-grid">${briefing.map((s, i) => entry(s, nums, {
        acc: acc.get(s.id),
        variant: ['splash', 'tall', 'offset', 'strip'][i],
        window: ['wide', 'portrait', 'square', ''][i],
        folioSize: i < 2 ? 'medium' : 'small'
      })).join('')}</div>
    </section>` : ''}
    ${pick ? detour(pick, nums.get(pick.id), {
      className: `detour--home a-${acc.get(pick.id)}`,
      label: 'A left turn / From the archive',
      text: pick.dek,
      href: `/stories/${pick.slug}`,
      linkTitle: pick.title
    }) : ''}
    ${sectionRows ? `<section class="sections-index">${sectionRows}</section>` : ''}
    <section class="closer">
      <span class="closer-label">End of front</span>
      <p>That’s the edition.<br>The archive stays open.</p>
      <div class="desk-links"><a class="all-link" href="/topics">Browse beats</a><a class="all-link" href="/search">Search the archive</a></div>
    </section>`;
}

/* ---------- Story: one of four reusable compositions ---------- */

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
  s.presentation = presentationRows[0]?.presentation || null;
  const sourceRows = await dataOf(
    sb.from('sources').select('id,title,publisher,url,source_type,published_at,sort_order').eq('story_id', s.id).order('sort_order'),
    'story sources'
  ) || [];
  const sources = sourceRows.map(source => ({ ...source, safe_url: externalUrl(source.url) })).filter(source => source.safe_url);
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
    related,
    catalog: all,
    numbers: nums,
    accent: acc.get(s.id) || 'brick',
    relatedHtml: related.length
      ? `<div class="next-grid">${related.map((x, i) => entry(x, nums, { acc: acc.get(x.id), variant: i ? 'compact' : 'offset', window: i ? '' : 'square' })).join('')}</div>`
      : ''
  });
}

/* ---------- Sections: the promise ---------- */

async function section(slug) {
  const sec = await dataOf(sb.from('sections').select('id,name,slug').eq('slug', slug).maybeSingle(), 'section');
  if (!sec) { title('Not found'); return app.innerHTML = notFound(); }
  const beatFilter = new URLSearchParams(location.search).get('beat') || '';
  const catalog = await published(), xs = catalog.filter(s => s.section_id === sec.id);
  const nums = numerals(catalog), acc = accents(catalog);
  const filtered = beatFilter ? xs.filter(s => (s.story_beats || []).some(x => x.beats?.slug === beatFilter)) : xs;
  const beats = await dataOf(sb.from('beats').select('id,name,slug').order('name'), 'beats') || [];
  const lead = filtered[0], remaining = filtered.slice(1);
  const mode = ['ledger', 'split', 'scatter'][hash(sec.slug) % 3];
  title(sec.name);
  app.innerHTML = `<div class="section-page section-page--${mode}">
    <header class="section-mast">
      <div class="section-mast-meta"><span>Section</span><span>${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}</span></div>
      <h1>${esc(sec.name)}</h1>
      ${lead ? detour({ title: sec.name, dek: promises[sec.id] || '' }, null, {
        className: `detour--section a-${acc.get(lead.id)}`,
        label: 'Section field note',
        text: promises[sec.id] || ''
      }) : `<p class="standfirst">${esc(promises[sec.id] || '')}</p>`}
    </header>
    <form method="get" class="filter-bar"><label class="label" for="section-beat">Beat</label><select id="section-beat" name="beat"><option value="">All beats</option>${beats.map(t => `<option value="${esc(t.slug)}" ${beatFilter === t.slug ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button type="submit">Filter →</button></form>
    ${lead ? `<article class="section-lead a-${acc.get(lead.id)}">
      <div class="section-lead-copy">
        ${folio(nums.get(lead.id), 'hero')}
        <h2><a href="/stories/${esc(lead.slug)}">${esc(lead.title)}</a></h2>
        <p>${esc(lead.dek)}</p>
        <div class="meta-line"><span>${dShort(lead.published_at)}</span><span>${lead.reading_time_minutes} min</span></div>
      </div>
      <a class="section-lead-window" href="/stories/${esc(lead.slug)}" tabindex="-1" aria-hidden="true">${knockoutWindow(lead, nums.get(lead.id), { className: 'window--section', label: sec.name })}</a>
    </article>
    ${remaining.length ? `<div class="section-results section-results--${mode}">${remaining.map((s, i) => entry(s, nums, {
      acc: acc.get(s.id),
      level: 2,
      variant: mode === 'ledger' ? 'ledger' : ['offset', 'compact', 'strip', 'tall'][i % 4],
      window: mode === 'scatter' && i % 3 === 0 ? 'square' : (mode === 'split' && i === 0 ? 'wide' : ''),
      folioSize: i === 0 ? 'medium' : 'small'
    })).join('')}</div>` : ''}` : detour({ title: sec.name, dek: 'Nothing filed here yet.' }, null, {
      className: 'detour--empty a-cobalt',
      label: 'The open slot',
      text: 'Nothing filed here yet. The archive below is always open.'
    })}
  </div>`;
}

/* ---------- Beats ---------- */

async function topics() {
  const ts = await dataOf(sb.from('beats').select('id,name,slug').order('name'), 'beats') || [];
  const stories = await published(), nums = numerals(stories);
  title('Beats');
  app.innerHTML = `<div class="page-head">
      <div class="kicker"><span>The archive, by recurring subject</span></div>
      <h1>Beats</h1>
      <p class="standfirst">Subjects that recur across the six editorial sections.</p>
    </div>
    <ul class="toc topic-index">${ts.map(t => {
      const n = stories.filter(s => (s.story_beats || []).some(x => x.beats?.slug === t.slug)).length;
      return n ? `<li><div class="toc-line"><span class="t"><a href="/topics/${esc(t.slug)}">${esc(t.name)}</a></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n} ${n === 1 ? 'story' : 'stories'}</span></div></li>` : '';
    }).join('')}</ul>`;
}

async function topic(slug) {
  const t = await dataOf(sb.from('beats').select('id,name,slug').eq('slug', slug).maybeSingle(), 'beat');
  if (!t) { title('Not found'); return app.innerHTML = notFound(); }
  const catalog = await published();
  const ss = catalog.filter(s => (s.story_beats || []).some(x => x.beats?.slug === t.slug));
  const nums = numerals(catalog), acc = accents(catalog);
  const sectionFilter = new URLSearchParams(location.search).get('section') || '';
  const filtered = sectionFilter ? ss.filter(s => s.section_id === sectionFilter) : ss;
  const sections = await allSections();
  title(t.name);
  app.innerHTML = `<div class="page-head">
      <div class="kicker"><span>Beat</span><span class="sep">·</span><span class="numeral">${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}</span></div>
      <h1>${esc(t.name)}</h1>
    </div>
    <form method="get" class="filter-bar"><label class="label" for="topic-section">Section</label><select id="topic-section" name="section"><option value="">All sections</option>${sections.map(s => `<option value="${esc(s.id)}" ${sectionFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><button type="submit">Filter →</button></form>
    ${filtered.length ? `<div class="topic-results">${filtered.map((s, i) => entry(s, nums, {
      acc: acc.get(s.id),
      level: 2,
      variant: ['offset', 'ledger', 'strip'][i % 3],
      window: i % 4 === 0 ? 'square' : ''
    })).join('')}</div>` : emptyNote('No published stories match this filter.')}`;
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
      if (sectionFilter && story.section_id !== sectionFilter) return false;
      const haystack = [
        story.title, story.dek, story.summary, story.body, story.profiles?.name,
        ...(story.story_beats || []).map(item => item.beats?.name), ...(story.story_tags || []).map(item => item.tags?.name)
      ].filter(Boolean).join(' ').toLocaleLowerCase('en-US');
      return haystack.includes(needle);
    });
  }
  const nums = numerals(catalog), acc = accents(catalog), sections = await allSections();
  title('Search');
  const results = q ? (ss.length
    ? `<div class="results-line"><span>${ss.length} result${ss.length === 1 ? '' : 's'}</span><strong>“${esc(q)}”</strong></div>
      <div class="search-results">${ss.map((s, i) => entry(s, nums, {
        acc: acc.get(s.id),
        level: 2,
        variant: ['offset', 'strip', 'tall', 'ledger'][i % 4],
        window: i % 3 === 0 ? (i % 2 ? 'portrait' : 'square') : '',
        folioSize: i % 3 === 0 ? 'medium' : 'small'
      })).join('')}</div>`
    : detour({ title: 'No result', dek: `Nothing filed under “${q}” yet.` }, null, {
      className: 'detour--empty a-magenta',
      label: 'No match / Keep looking',
      text: `Nothing filed under “${q}” yet.`
    }) ) : detour({ title: 'The archive', dek: 'Every story is numbered, sourced, and still on file.' }, null, {
      className: 'detour--search a-yellow',
      label: 'Search note / The whole archive',
      text: 'Try a person, a topic, a company, a feeling, or the thing everyone keeps talking around.'
    });
  app.innerHTML = `<div class="search-page">
    <div class="search-head">
      <span class="search-index">The archive / ${catalog.length} stories</span>
      <h1>Ask the desk.</h1>
      <p class="standfirst">Every story is numbered, sourced, and still on file.</p>
    </div>
    <form id="search" method="get" class="search-block">
      <div class="search-form"><label class="sr-only" for="archive-query">Search the archive</label><input id="archive-query" name="q" type="search" maxlength="120" value="${esc(q)}" placeholder="Search stories, people, beats, tags"><button type="submit">Search →</button></div>
      <div class="search-filter"><label class="label" for="archive-section">In</label><select id="archive-section" name="section"><option value="">All sections</option>${sections.map(s => `<option value="${esc(s.id)}" ${sectionFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
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
  const editorCreate = ['admin', 'editor'].includes(p?.role)
    ? `<a href="/newsroom/pipeline#request-article">AI article</a><a href="/newsroom/pipeline" ${current === 'pipeline' ? 'aria-current="page"' : ''}>Pipeline</a>`
    : '';
  const create = p?.role ? `<details class="desk-create-menu"><summary>Create +</summary><div><a href="/newsroom/new" ${current === 'new' ? 'aria-current="page"' : ''}>New post</a>${editorCreate}</div></details>` : '';
  return `<nav class="desk-nav" aria-label="Newsroom">
    <a href="/newsroom" ${current === 'overview' ? 'aria-current="page"' : ''}>Posts</a>
    <a href="/newsroom/review" ${current === 'review' ? 'aria-current="page"' : ''}>AI Review</a>
    ${['admin', 'editor'].includes(p?.role) ? `<a href="/newsroom/analytics" ${current === 'analytics' ? 'aria-current="page"' : ''}>Analytics</a>` : ''}
    ${create}
    <span class="who">${esc(p?.name || '')} · ${esc(humanize(p?.role || ''))} · <button class="quiet compact-button" id="signout" type="button">Sign out</button></span>
  </nav>`;
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
    document.querySelector('#login').onsubmit = async e => {
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
  const ss = await dataOf(
    sb.from('stories').select('id,title,status,updated_at,section_id,sections(name)').order('updated_at', { ascending: false }),
    'newsroom stories'
  ) || [];
  const pipelineRows = await optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,created_at,updated_at'), 'pipeline review queue');
  title('Newsroom');
  const hour = new Date().getHours(), greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const board = statuses.map(st => {
    const n = ss.filter(s => s.status === st).length;
    return n ? `<li><div class="toc-line"><span class="t"><span class="stamp st-${st}">${esc(workflowLabel(st))}</span></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n}</span></div></li>` : '';
  }).join('');
  app.innerHTML = `<div class="desk">
    <div class="page-head">
      <div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div>
      <h1>${greeting}, ${esc((p?.name || '').split(' ')[0])}.</h1>
      <p class="standfirst">Find any post, edit it, take it down, or open the next story.</p>
    </div>
    ${deskNav(p, 'overview')}
    ${pipelineRows.length ? `<div class="desk-section"><span class="label">AI Review</span><p class="field-note">${pipelineRows.filter(item => item.status === 'ready_for_review').length} proposal${pipelineRows.filter(item => item.status === 'ready_for_review').length === 1 ? '' : 's'} awaiting editorial judgment. <a class="text-link" href="/newsroom/review">Open AI Review</a></p></div>` : ''}
    <section class="desk-section"><span class="label">Open by link</span><form id="open-story-link" class="queue-filters"><label>Anyways story URL or /stories/slug<input name="story_link" type="text" required placeholder="https://…/stories/example"></label><button type="submit">Open post</button><p class="notice form-message" data-form-message hidden></p></form></section>
    <div class="desk-section"><span class="label">Post states</span><ul class="toc desk-index">${board || '<li class="meta-line empty-row">No stories yet.</li>'}</ul></div>
    <div class="desk-section"><span class="label">Stories</span>${ss.length ? `<div class="table-scroll" role="region" aria-label="Newsroom stories" tabindex="0"><table class="desk-table">
      <thead><tr><th>Title</th><th>Status</th><th>Section</th><th>Updated</th></tr></thead>
      <tbody>${ss.map(s => `<tr><td class="title-cell"><a href="/newsroom/${s.id}">${esc(s.title || 'Untitled story')}</a></td><td><span class="stamp st-${s.status}">${esc(workflowLabel(s.status))}</span></td><td class="mono">${esc(s.sections?.name || '')}</td><td class="mono">${dShort(s.updated_at)}</td></tr>`).join('')}</tbody>
    </table></div>` : emptyNote('No stories yet. Start a draft when the next idea is ready.')}</div>
  </div>`;
  document.querySelector('#open-story-link').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget; const raw = String(new FormData(form).get('story_link') || '').trim(); let slug = '';
    try { const parsed = new URL(raw, location.origin); slug = parsed.pathname.match(/^\/stories\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/)?.[1] || ''; } catch {}
    if (!slug) return showFormMessage(form, 'Use an Anyways story URL or /stories/slug.');
    const story = await dataOf(sb.from('stories').select('id').eq('slug', slug).maybeSingle(), 'story link lookup');
    if (!story) return showFormMessage(form, 'No newsroom post matches that link.');
    location.href = `/newsroom/${story.id}`;
  };
  bindSignOut();
}

async function optionalData(request, context) { try { return await dataOf(request, context) || []; } catch (error) { console.warn(`Optional ${context} unavailable`, error); return []; } }
async function pipelineRequest(path, payload) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Sign in to the Newsroom before using pipeline controls.');
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: payload === undefined ? undefined : JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result?.error?.message || 'The pipeline request could not be completed.');
  return result;
}
function pipelineDuration(job) { const start = job.started_at || job.claimed_at || job.created_at, end = job.finished_at || (ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) ? new Date().toISOString() : null); if (!start || !end) return '—'; const seconds = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }
function jobTarget(job) { return job.parameters?.brief || job.parameters?.candidate_id || job.parameters?.run_id || 'All enabled sources'; }
function jobResult(job) { if (job.error) return concisePipelineError(job.error); if (job.result?.result?.status) return humanize(job.result.result.status); if (job.result?.health) return 'Healthy'; return job.status === 'completed' ? 'Completed' : '—'; }
function jobHref(job) { return `/newsroom/pipeline/jobs/${job.id}`; }
function statusOptions(values, selected) { return `<option value="">All</option>${values.map(value => `<option value="${esc(value)}" ${selected === value ? 'selected' : ''}>${esc(humanize(value))}</option>`).join('')}`; }
function safeLog(value) { return String(value || '').replace(/(?:SUPABASE_SERVICE_ROLE_KEY|authorization|bearer)\s*[=:]\s*[^\s]+/ig, match => `${match.split(/([=:])/)[0]}=[redacted]`).slice(-12000); }
function requirePipelineEditor(p) { return p && ['admin', 'editor'].includes(p.role); }

async function pipelineControls() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  if (!requirePipelineEditor(p)) { title('Pipeline access'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline</span></div><h1>Editor access required</h1><p class="standfirst">Pipeline controls are available to editors and administrators.</p></div>${deskNav(p)}</div>`; bindSignOut(); return; }
  const [jobs, candidates, sources, links] = await Promise.all([
    optionalData(sb.from('pipeline_jobs').select('id,job_type,parameters,source,requested_by,priority,priority_rank,queue_position,status,attempt_count,max_attempts,lease_owner,lease_expires_at,cancellation_requested_at,created_at,claimed_at,started_at,finished_at,result,error,summary_log,profiles(name)').order('created_at', { ascending: false }).limit(80), 'pipeline jobs'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,canonical_url,created_at,updated_at').order('updated_at', { ascending: false }).limit(60), 'pipeline candidates'),
    optionalData(sb.from('pipeline_sources').select('external_id,name,source_type,locator,enabled,default_section,default_beats,last_checked_at,last_successful_check_at,failure_count').order('priority', { ascending: false }), 'pipeline sources'),
    optionalData(sb.from('pipeline_story_links').select('candidate_id,story_id'), 'pipeline story links')
  ]);
  const params = new URLSearchParams(location.search); const statusFilter = params.get('status') || '', typeFilter = params.get('type') || '', sourceFilter = params.get('source') || '';
  const visible = jobs.filter(job => (!statusFilter || job.status === statusFilter) && (!typeFilter || job.job_type === typeFilter) && (!sourceFilter || job.source === sourceFilter));
  const counts = Object.fromEntries(PIPELINE_JOB_STATUSES.map(status => [status, jobs.filter(job => job.status === status).length]));
  const latestDiscovery = jobs.find(job => job.job_type === 'discover' && job.status === 'completed'); const latestProcess = jobs.find(job => job.job_type === 'process_candidate' && job.status === 'completed'); const active = jobs.filter(job => ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status)); const queued = jobs.filter(job => job.status === 'queued').sort((a, b) => (b.priority_rank - a.priority_rank) || (a.queue_position - b.queue_position) || (new Date(a.created_at) - new Date(b.created_at))); const linkByCandidate = new Map(links.map(link => [link.candidate_id, link]));
  const queueRow = (job, index) => `<tr draggable="true" data-queue-job="${esc(job.id)}"><td>${index + 1}</td><td class="mono">${esc(job.id.slice(0, 8))}</td><td>${esc(jobTarget(job))}</td><td>${esc(humanize(job.job_type))}</td><td><select data-queue-priority="${esc(job.id)}"><option value="urgent" ${job.priority_rank === 300 ? 'selected' : ''}>Urgent</option><option value="high" ${job.priority_rank === 200 ? 'selected' : ''}>High</option><option value="normal" ${job.priority_rank === 100 ? 'selected' : ''}>Normal</option><option value="low" ${job.priority_rank === 0 ? 'selected' : ''}>Low</option></select></td><td>${esc(dShort(job.created_at))}</td><td>${esc(job.profiles?.name || 'System')}</td><td><button class="quiet compact-button" data-queue-action="next" data-job-id="${esc(job.id)}">Move to next</button> <button class="quiet compact-button" data-queue-action="up" data-job-id="${esc(job.id)}">Up</button> <button class="quiet compact-button" data-queue-action="down" data-job-id="${esc(job.id)}">Down</button> <button class="quiet compact-button" data-queue-action="bottom" data-job-id="${esc(job.id)}">Bottom</button></td></tr>`;
  const commissionForm = `<section class="desk-section commission-panel" id="request-article"><div class="section-head"><div><span class="label">Assignment desk</span><h2>Request an article</h2><p class="field-note">Choose the article form, give the writer a focused topic, loose notes, and source links. The finished package goes to editorial review. It cannot publish itself.</p></div></div><form id="commission-job" class="commission-form"><label class="commission-brief">What should the article explain?<textarea name="brief" maxlength="3000" required placeholder="Write a focused assignment. Include the question to answer, the angle, and what should make the piece useful."></textarea></label><div class="commission-taxonomy"><label>Primary section<select name="section_id" required><option value="">Choose a section</option>${SECTION_ORDER.map(section => `<option value="${esc(section)}">${esc(`${humanize(section)} — ${SECTION_PROMISES[section]}`)}</option>`).join('')}</select></label><label>Article form<select name="story_form" required><option value="">Choose a form</option>${STORY_FORMS.map(form => `<option value="${esc(form.id)}">${esc(form.name)} · ${form.minimum}–${form.maximum} words</option>`).join('')}</select></label><label>Tags<input name="tags" maxlength="500" placeholder="narrow topic, person, company"></label></div><fieldset class="topic-fieldset"><legend>Recurring beats</legend><div class="topic-checks">${BEAT_ORDER.map(beat => `<label><input type="checkbox" name="beats" value="${esc(beat)}"> ${esc(humanize(beat))}</label>`).join('')}</div></fieldset><div class="commission-evidence"><label>Source links<textarea name="source_urls" required maxlength="5000" placeholder="One public link per line. Add the reporting, documents, posts, or references the writer should use."></textarea></label><label>Supporting notes<textarea name="notes" maxlength="4000" placeholder="Facts you already know, people or claims to examine, constraints, or anything the links do not explain."></textarea></label></div><div class="commission-submit"><label>Priority<select name="priority"><option value="50">Normal</option><option value="75">High</option><option value="25">Low</option></select></label><button type="submit">Send assignment to writer</button><p class="notice form-message" data-form-message hidden></p></div></form></section>`;
  title('Pipeline'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline</span></div><h1>Pipeline control</h1><p class="standfirst">Queue work for the local controller. Review and publishing remain separate editorial decisions.</p></div>${deskNav(p, 'pipeline')}<section class="desk-section"><div class="pipeline-status-grid"><div><span class="label">Controller</span><p class="meta-line">Controller status unavailable</p><p class="field-note">The Newsroom reads durable queue activity only. It does not contact the Mac Studio.</p></div><div><span class="label">Queue</span><p class="meta-line">${counts.queued} queued · ${counts.running} running · ${counts.failed} failed · ${counts.completed} completed</p><p class="field-note">${active.length ? `${active.length} active job${active.length === 1 ? '' : 's'} in the controller queue.` : 'No active jobs.'}</p></div><div><span class="label">Latest work</span><p class="field-note">Discovery: ${latestDiscovery ? `<a href="${jobHref(latestDiscovery)}">${dShort(latestDiscovery.finished_at || latestDiscovery.created_at)}</a>` : 'None recorded'}</p><p class="field-note">Candidate processing: ${latestProcess ? `<a href="${jobHref(latestProcess)}">${dShort(latestProcess.finished_at || latestProcess.created_at)}</a>` : 'None recorded'}</p></div></div></section>${commissionForm}<section class="desk-section"><div class="section-head"><div><span class="label">Running now</span><h2>${active.map(jobTarget).join(' · ') || 'No active job'}</h2></div></div><p class="field-note">Running and claimed jobs cannot be moved.</p></section><section class="desk-section"><div class="section-head"><div><span class="label">Next up</span><h2>Queued work</h2></div></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Order</th><th>Job</th><th>Target</th><th>Type</th><th>Priority</th><th>Created</th><th>Requester</th><th>Controls</th></tr></thead><tbody>${queued.map(queueRow).join('') || '<tr><td colspan="8" class="empty-row">No queued jobs.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Discovery</span><h2>Run enabled sources</h2></div></div><form id="discovery-job" class="queue-filters"><label>Priority<select name="priority"><option value="50">Normal</option><option value="75">High</option><option value="25">Low</option></select></label><button type="submit">Run discovery</button><p class="notice form-message" data-form-message hidden></p></form></section><section class="desk-section"><div class="section-head"><div><span class="label">Candidates</span><h2>Retained pipeline candidates</h2></div></div><div class="table-scroll" role="region" aria-label="Pipeline candidates" tabindex="0"><table class="desk-table"><thead><tr><th>Candidate</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${candidates.map(candidate => { const action = candidatePipelineAction(candidate, jobs, linkByCandidate.get(candidate.id)); const button = action?.type === 'process' ? `<button class="quiet compact-button" type="button" data-process-candidate="${esc(action.candidate_id)}">${esc(action.label)}</button>` : action ? `<a class="text-link" href="${esc(action.href)}">${esc(action.label)}</a>` : '—'; return `<tr><td class="title-cell">${candidate.canonical_url ? sourceHref(candidate.canonical_url, candidate.title || 'Untitled candidate') : esc(candidate.title || 'Untitled candidate')}</td><td><span class="stamp st-${esc(candidate.status)}">${esc(humanize(candidate.status))}</span></td><td class="mono">${dShort(candidate.updated_at)}</td><td>${button}</td></tr>`; }).join('') || '<tr><td colspan="4" class="empty-row">Run discovery to retain candidates for processing.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Recent jobs</span><h2>Queue history</h2></div></div><form id="job-filters" class="queue-filters"><label>Status<select name="status">${statusOptions(PIPELINE_JOB_STATUSES, statusFilter)}</select></label><label>Type<select name="type">${statusOptions(['discover', 'process_candidate', 'retry_run', 'sync_candidate', 'health_check'], typeFilter)}</select></label><label>Source<select name="source">${statusOptions([...new Set(jobs.map(job => job.source))].filter(Boolean).sort(), sourceFilter)}</select></label><button class="quiet" type="submit">Filter</button></form><div class="table-scroll" role="region" aria-label="Pipeline jobs" tabindex="0"><table class="desk-table pipeline-jobs"><thead><tr><th>Job</th><th>Type</th><th>Requester</th><th>Target</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Result</th></tr></thead><tbody>${visible.map(job => `<tr><td class="mono"><a href="${jobHref(job)}">${esc(job.id.slice(0, 8))}</a></td><td>${esc(humanize(job.job_type))}</td><td>${esc(job.profiles?.name || 'System')}</td><td>${esc(jobTarget(job))}</td><td><span class="stamp st-${esc(job.status)}">${esc(humanize(job.status))}</span></td><td>${job.attempt_count}/${job.max_attempts}</td><td>${esc(pipelineDuration(job))}</td><td>${esc(jobResult(job))}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">No jobs match these filters.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Sources</span><h2>Enabled discovery sources</h2></div></div><div class="table-scroll" role="region" aria-label="Discovery sources" tabindex="0"><table class="desk-table"><thead><tr><th>Source</th><th>Type</th><th>Domain</th><th>Section / beats</th><th>Last check</th></tr></thead><tbody>${sources.filter(source => source.enabled).map(source => { let domain = source.locator; try { domain = new URL(source.locator).hostname; } catch {} return `<tr><td>${esc(source.name)}</td><td>${esc(humanize(source.source_type))}</td><td>${esc(domain)}</td><td>${esc([source.default_section, ...(source.default_beats || [])].filter(Boolean).join(' · '))}</td><td class="mono">${source.last_checked_at ? dShort(source.last_checked_at) : 'Not yet recorded'}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty-row">Source snapshot will appear after the next controller discovery.</td></tr>'}</tbody></table></div></section></div>`;
  const controllerPanel = document.querySelector('.pipeline-status-grid > div');
  if (controllerPanel) {
    controllerPanel.querySelector('.meta-line').textContent = 'Assignments use the durable queue';
    controllerPanel.querySelector('.field-note').textContent = 'The Mac Studio checks this queue. The browser never opens a connection to the machine.';
  }
  const typeSelect = document.querySelector('#job-filters select[name="type"]');
  if (typeSelect && !typeSelect.querySelector('option[value="commission_article"]')) {
    typeSelect.insertAdjacentHTML('beforeend', `<option value="commission_article" ${typeFilter === 'commission_article' ? 'selected' : ''}>Commission article</option>`);
  }
  const submit = async (form, payload) => { showFormMessage(form, ''); setBusy(form, true, 'Submitting…'); try { const result = await pipelineRequest('/api/newsroom/pipeline/jobs', payload); if (result.duplicate) { showFormMessage(form, 'An active matching job already exists. Opening it now.', 'ok'); setTimeout(() => location.href = jobHref(result.job), 450); } else location.href = jobHref(result.job); } catch (error) { setBusy(form, false); showFormMessage(form, error.message); } };
  document.querySelector('#commission-job').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget; const values = new FormData(form);
    try {
      submit(form, validateNewsroomJobRequest({
        job_type: 'commission_article',
        brief: values.get('brief'),
        section_id: values.get('section_id'),
        story_form: values.get('story_form'),
        beats: values.getAll('beats'),
        tags: values.get('tags'),
        source_urls: values.get('source_urls'),
        notes: values.get('notes'),
        priority: values.get('priority')
      }));
    } catch (error) { showFormMessage(form, error.message); }
  };
  document.querySelector('#discovery-job').onsubmit = event => { event.preventDefault(); const form = event.currentTarget; try { submit(form, validateNewsroomJobRequest({ job_type: 'discover', priority: new FormData(form).get('priority') })); } catch (error) { showFormMessage(form, error.message); } };
  document.querySelector('#job-filters').onsubmit = event => { event.preventDefault(); const next = new URLSearchParams(new FormData(event.currentTarget)); location.href = `/newsroom/pipeline${next.toString() ? `?${next}` : ''}`; };
  document.querySelectorAll('[data-process-candidate]').forEach(button => button.addEventListener('click', () => { const form = button.closest('.desk') || document.body; submit(form, { job_type: 'process_candidate', candidate_id: button.dataset.processCandidate, priority: 50 }); }));
  const reorder = async (id, action, priority) => { await pipelineRequest(`/api/newsroom/pipeline/jobs/${id}/reorder`, { action, priority }); location.reload(); };
  document.querySelectorAll('[data-queue-action]').forEach(button => button.addEventListener('click', () => reorder(button.dataset.jobId, button.dataset.queueAction)));
  document.querySelectorAll('[data-queue-priority]').forEach(select => select.addEventListener('change', () => reorder(select.dataset.queuePriority, 'priority', select.value)));
  let dragged = null;
  document.querySelectorAll('[data-queue-job]').forEach(row => { row.addEventListener('dragstart', () => { dragged = row.dataset.queueJob; }); row.addEventListener('dragover', event => event.preventDefault()); row.addEventListener('drop', event => { event.preventDefault(); if (dragged && dragged !== row.dataset.queueJob) reorder(dragged, 'next'); }); });
  bindSignOut(); if (active.length) setTimeout(() => location.reload(), 12000);
}

async function pipelineJobDetail(jobId) {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  if (!requirePipelineEditor(p)) return location.href = '/newsroom';
  const job = await dataOf(sb.from('pipeline_jobs').select('id,job_type,parameters,source,requested_by,priority,status,attempt_count,max_attempts,lease_owner,lease_expires_at,cancellation_requested_at,created_at,claimed_at,started_at,finished_at,last_heartbeat_at,result,error,summary_log,profiles(name),pipeline_job_events(id,at,level,event_type,message,metadata)').eq('id', jobId).maybeSingle(), 'pipeline job');
  if (!job) { title('Not found'); app.innerHTML = notFound(); return; }
  if (!job.parameters?.candidate_id && job.result?.result?.candidate_id) job.parameters = { ...job.parameters, candidate_id: job.result.result.candidate_id };
  const candidateId = job.parameters?.candidate_id; const candidate = candidateId ? await optionalData(sb.from('candidate_stories').select('id,external_id,title,status').eq('external_id', candidateId).limit(1), 'related pipeline candidate') : []; const related = candidate[0]; const cancellable = ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) && !job.cancellation_requested_at; const retryable = job.status === 'failed' && ['discover', 'process_candidate'].includes(job.job_type); const events = (job.pipeline_job_events || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at)); const review = pipelineReviewHref(related || {});
  title('Pipeline job'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline job</span></div><h1>${esc(humanize(job.job_type))}</h1><p class="standfirst">${esc(job.id)}</p></div>${deskNav(p, 'pipeline')}<p class="notice form-message" id="job-message" hidden></p><section class="desk-section"><div class="pipeline-status-grid"><div><span class="label">Status</span><p><span class="stamp st-${esc(job.status)}">${esc(humanize(job.status))}</span></p><p class="field-note">${job.cancellation_requested_at ? 'Cancellation requested.' : 'No cancellation requested.'}</p></div><div><span class="label">Execution</span><p class="field-note">Attempts ${job.attempt_count}/${job.max_attempts} · ${esc(pipelineDuration(job))}</p><p class="field-note">Started ${job.started_at ? esc(dLong(job.started_at)) : 'Not claimed yet'}</p></div><div><span class="label">Requester</span><p class="field-note">${esc(job.profiles?.name || 'System')} · ${esc(humanize(job.source))}</p><p class="field-note">Priority ${job.priority}</p></div></div><div class="form-actions">${cancellable ? '<button id="cancel-job" type="button" class="quiet">Cancel job</button>' : ''}${retryable ? '<button id="retry-job" type="button">Retry job</button>' : ''}${related ? `<a class="text-link" href="/newsroom/pipeline">Open candidate</a>` : ''}${review ? `<a class="text-link" href="${esc(review)}">Open review</a>` : ''}</div></section><section class="desk-section"><span class="label">Parameters</span><pre class="packet-data">${esc(JSON.stringify(job.parameters || {}, null, 2))}</pre><p class="field-note">Lease: ${esc(job.lease_owner ? 'Active controller lease' : 'No active lease')} ${job.lease_expires_at ? `until ${dLong(job.lease_expires_at)}` : ''}</p>${job.error ? `<h3>Error</h3><pre class="packet-data">${esc(JSON.stringify(job.error, null, 2))}</pre>` : ''}${job.result ? `<h3>Result</h3><pre class="packet-data">${esc(JSON.stringify(job.result, null, 2))}</pre>` : ''}</section><section class="desk-section"><span class="label">Timeline</span>${events.map(event => `<div class="revision-line"><span>${esc(dShort(event.at))}</span><span class="stamp st-${esc(event.level)}">${esc(humanize(event.event_type))}</span><span>${esc(event.message)}</span></div>`).join('') || '<p class="field-note">No event history retained.</p>'}</section><details class="editor-section"><summary>Concise controller log</summary><pre class="packet-data">${esc(safeLog(job.summary_log) || 'No summary log retained.')}</pre></details></div>`;
  if (job.status === 'failed' && job.job_type === 'commission_article') document.querySelector('.form-actions')?.insertAdjacentHTML('afterbegin', '<button id="retry-job" type="button">Retry assignment</button>');
  const message = document.querySelector('#job-message'); const action = async (suffix, success) => { try { await pipelineRequest(`/api/newsroom/pipeline/jobs/${job.id}/${suffix}`); message.textContent = success; message.className = 'notice form-message ok'; message.hidden = false; setTimeout(() => location.reload(), 650); } catch (error) { message.textContent = error.message; message.className = 'notice form-message'; message.hidden = false; } };
  document.querySelector('#cancel-job')?.addEventListener('click', () => action('cancel', 'Cancellation requested.'));
  document.querySelector('#retry-job')?.addEventListener('click', () => action('retry', 'Replacement job submitted.'));
  bindSignOut(); if (ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status)) setTimeout(() => location.reload(), 8000);
}
function sourceHref(url, label) { const safe = externalUrl(url); return safe ? `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${esc(label || safe)}</a>` : esc(label || 'Unavailable source'); }
function queueFilters(items) { const collect = key => [...new Set(items.flatMap(item => { const value = pipelineMetadata(item)[key]; return Array.isArray(value) ? value : [value]; }).filter(Boolean))].sort(); const options = (values, selected) => `<option value="">All</option>${values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(humanize(value))}</option>`).join('')}`; const qs = new URLSearchParams(location.search); return { qs, html: `<form class="queue-filters" id="pipeline-filters"><label>Section<select name="section">${options(collect('section'), qs.get('section'))}</select></label><label>Beat<select name="beat">${options(collect('beats'), qs.get('beat'))}</select></label><label>Tag<select name="tag">${options(collect('tags'), qs.get('tag'))}</select></label><label>Status<select name="status">${options(PIPELINE_QUEUE_STATUSES, qs.get('status'))}</select></label><button class="quiet" type="submit">Filter</button></form>` }; }
function batchSummary(batch = {}) {
  const shortfalls = Object.entries(batch.shortfalls || {}).filter(([, count]) => Number(count) > 0).map(([section, count]) => `${count} ${humanize(section)}`);
  const ready = Number(batch.summary?.review_ready || 0), failed = Number(batch.summary?.processing_failed || 0);
  const parts = [`target ${batch.target_count}`, `${ready} ready for review`];
  if (failed) parts.push(`${failed} did not produce an article`);
  if (shortfalls.length) parts.push(`missing ${shortfalls.join(', ')}`);
  return parts.join(' · ');
}
async function reviewQueue() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const [submittedStories, candidates, batches] = await Promise.all([
    optionalData(sb.from('stories').select('id,title,status,updated_at,sections(name),profiles!stories_author_id_fkey(name)').eq('status', 'review').order('updated_at', { ascending: false }), 'submitted stories'),
    optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,created_at,updated_at').in('status', PIPELINE_QUEUE_STATUSES).order('updated_at', { ascending: false }), 'pipeline review queue'),
    optionalData(sb.from('pipeline_batch_runs').select('id,status,target_count,shortfalls,summary,requested_at').order('requested_at', { ascending: false }).limit(3), 'editorial batches')
  ]);
  const ids = candidates.map(item => item.id);
  const [drafts, documents, claims, images] = await Promise.all([
    ids.length ? optionalData(sb.from('pipeline_drafts').select('candidate_id').in('candidate_id', ids), 'pipeline drafts') : [],
    ids.length ? optionalData(sb.from('discovered_documents').select('candidate_id').in('candidate_id', ids), 'pipeline documents') : [],
    ids.length ? optionalData(sb.from('pipeline_claims').select('draft_id,status,pipeline_drafts!inner(candidate_id)').in('pipeline_drafts.candidate_id', ids), 'pipeline claims') : [],
    ids.length ? optionalData(sb.from('image_candidates').select('candidate_id,rights_status,warning_flags').in('candidate_id', ids), 'pipeline images') : []
  ]);
  const counts = new Map(ids.map(id => [id, { source_count: 0, unresolved_claim_count: 0, rights_warning_count: 0 }])); documents.forEach(row => counts.get(row.candidate_id).source_count++); claims.filter(row => row.status !== 'supported').forEach(row => counts.get(row.pipeline_drafts?.candidate_id).unresolved_claim_count++); images.filter(row => row.rights_status !== 'verified_reusable' && row.rights_status !== 'official_press_asset').forEach(row => counts.get(row.candidate_id).rights_warning_count++);
  const items = candidates.map(item => ({ ...item, ...counts.get(item.id) })); const filters = queueFilters(items); const filtered = filterPipelineQueue(items, Object.fromEntries(filters.qs)); const visible = filters.qs.get('status') ? filtered : filtered.filter(item => ['ready_for_review', 'revision_requested'].includes(item.status));
  title('AI Review'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>AI Review</span></div><h1>Review proposed articles</h1><p class="standfirst">Edit an article, approve it for On Deck, or remove it completely. Approval never publishes.</p></div>${deskNav(p, 'review')}
    <section class="desk-section"><div class="section-head"><div><span class="label">Editorial Batch</span><h2>Find ideas with a point of view</h2><p class="field-note">Choose the primary section and article form before discovery. Leave either on Any to keep the balanced desk mix.</p></div></div><form id="run-editorial-batch" class="queue-filters"><label>Primary section<select name="section_id"><option value="">Any section</option>${SECTION_ORDER.map(section => `<option value="${esc(section)}">${esc(humanize(section))}</option>`).join('')}</select></label><label>Article form<select name="story_form"><option value="">Any form</option>${STORY_FORMS.map(form => `<option value="${esc(form.id)}">${esc(form.name)}</option>`).join('')}</select></label><label>Ideas<select name="target_count"><option value="5">5</option><option value="3">3</option><option value="10">10</option></select></label><button type="submit">Run focused discovery</button><p class="notice form-message" data-batch-message hidden></p></form>${batches.map(batch => `<p class="field-note"><strong>${esc(humanize(batch.status))}</strong> · ${esc(batchSummary(batch))}</p>`).join('') || '<p class="field-note">No batch runs yet.</p>'}</section>
    <section class="desk-section"><div class="section-head"><div><span class="label">Editorial submissions</span><h2>${submittedStories.length} waiting</h2></div></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Headline</th><th>Writer</th><th>Section</th><th>Submitted</th><th>Next step</th></tr></thead><tbody>${submittedStories.map(story => `<tr><td class="title-cell"><a href="/newsroom/${story.id}">${esc(story.title || 'Untitled story')}</a></td><td>${esc(story.profiles?.name || 'Unknown')}</td><td class="mono">${esc(story.sections?.name || '')}</td><td class="mono">${dShort(story.updated_at)}</td><td><a class="text-link" href="/newsroom/${story.id}">Open review</a></td></tr>`).join('') || '<tr><td colspan="5" class="empty-row">No editorial submissions are waiting.</td></tr>'}</tbody></table></div></section>
    <section class="desk-section"><div class="section-head"><div><span class="label">AI proposals</span><h2>Prepared article packages</h2></div></div><p class="field-note">Articles arrive before advisory evidence and style checks. An approval creates the editorial article and moves it directly to On Deck.</p>${filters.html}<div class="table-scroll"><table class="desk-table queue-table"><thead><tr><th>Headline</th><th>Status</th><th>Section</th><th>Beats / tags</th><th>Sources</th><th>Checks</th><th>Photos</th><th>Created</th><th>Actions</th></tr></thead><tbody>${visible.map(item => { const meta = pipelineMetadata(item); const checks = meta.reviewWarnings + meta.revisionSuggestions; return `<tr><td class="title-cell"><a href="/newsroom/review/${esc(item.external_id || item.id)}">${esc(item.title || 'Untitled')}</a></td><td><span class="stamp st-${esc(meta.status)}">${esc(humanize(meta.status))}</span></td><td class="mono">${esc(humanize(meta.section))}</td><td class="mono">${esc([...meta.beats, ...meta.tags].join(' · '))}</td><td>${meta.sourceCount}</td><td>${checks ? `<span class="warning-count">${checks} advisory</span>` : 'No warnings'}</td><td>${meta.rightsWarnings ? `<span class="warning-count">${meta.rightsWarnings} need clearance</span>` : 'Cleared'}</td><td class="mono">${dShort(meta.createdAt)}</td><td><button type="button" class="danger-quiet compact-button" data-purge-candidate="${esc(item.id)}">Delete</button></td></tr>`; }).join('') || '<tr><td colspan="9" class="empty-row">No pipeline submissions match these filters.</td></tr>'}</tbody></table></div></section></div>`; document.querySelector('#pipeline-filters').onsubmit = event => { event.preventDefault(); const qs = new URLSearchParams(new FormData(event.currentTarget)); location.href = `/newsroom/review?${qs}`; }; document.querySelectorAll('[data-purge-candidate]').forEach(button => { button.onclick = async () => { if (!window.confirm('Delete this proposed article and its research package?')) return; button.disabled = true; try { const { error } = await sb.rpc('purge_pipeline_candidate', { p_candidate_id: button.dataset.purgeCandidate, p_reason: 'editor_queue_delete' }); if (error) throw error; location.reload(); } catch (error) { button.disabled = false; window.alert(error.message || 'The proposal could not be deleted.'); } }; }); document.querySelector('#run-editorial-batch').onclick = async event => { const button = event.currentTarget, message = document.querySelector('[data-batch-message]'); button.disabled = true; button.textContent = 'Starting…'; try { await pipelineRequest('/api/newsroom/pipeline/jobs', { job_type: 'run_editorial_batch' }); location.reload(); } catch (error) { button.disabled = false; button.textContent = 'Run Editorial Batch'; message.textContent = error.message; message.hidden = false; } }; bindSignOut();
  // The legacy click handler above is retained in this compact render block for
  // backwards compatibility, but it treated every click inside the form as a
  // submission and replaced the controls with a text node. Focused controls
  // use a submit handler only.
  document.querySelector('#run-editorial-batch').onclick = null;
  document.querySelector('#run-editorial-batch').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button'), message = form.querySelector('[data-batch-message]'), values = new FormData(form);
    button.disabled = true;
    button.textContent = 'Starting…';
    try {
      await pipelineRequest('/api/newsroom/pipeline/jobs', validateNewsroomJobRequest({
        job_type: 'run_editorial_batch', section_id: values.get('section_id'), story_form: values.get('story_form'), target_count: values.get('target_count')
      }));
      location.reload();
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Run focused discovery';
      message.textContent = error.message;
      message.hidden = false;
    }
  };
}
async function reviewPackage(candidateId) {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const candidate = await dataOf(sb.from('candidate_stories').select('id,external_id,title,status,classification,created_at,updated_at').eq('external_id', candidateId).maybeSingle(), 'pipeline review package'); if (!candidate) { title('Not found'); return app.innerHTML = notFound(); }
  const databaseCandidateId = candidate.id;
  const [drafts, packetRows, documents, images, decisions, linkRows] = await Promise.all([
    optionalData(sb.from('pipeline_drafts').select('*').eq('candidate_id', databaseCandidateId).order('created_at', { ascending: false }).order('version', { ascending: false }), 'pipeline drafts'),
    optionalData(sb.from('research_packets').select('*').eq('candidate_id', databaseCandidateId).order('iteration', { ascending: false }), 'research packet'),
    optionalData(sb.from('discovered_documents').select('id,title,url,canonical_url,extraction_status,pipeline_run_id,retention,pipeline_sources(name,source_type)').eq('candidate_id', databaseCandidateId), 'pipeline documents'),
    optionalData(sb.from('image_candidates').select('*').eq('candidate_id', databaseCandidateId), 'image candidates'),
    optionalData(sb.from('pipeline_review_decisions').select('action,note,created_at,profiles(name)').eq('candidate_id', databaseCandidateId).order('created_at', { ascending: false }), 'review decisions'),
    optionalData(sb.from('pipeline_story_links').select('story_id,source_draft_version,created_at').eq('candidate_id', databaseCandidateId), 'pipeline story link')
  ]);
  const activeRunId = drafts[0]?.pipeline_run_id || null; const activeDrafts = drafts.filter(draft => !activeRunId || draft.pipeline_run_id === activeRunId); const activeDocuments = documents.filter(document => !activeRunId || document.pipeline_run_id === activeRunId); const activeImages = images.filter(image => !activeRunId || image.pipeline_run_id === activeRunId); const current = activeDrafts[0] || {}; const draftIds = activeDrafts.map(draft => draft.id); const claims = draftIds.length ? await optionalData(sb.from('pipeline_claims').select('id,claim,status,note,resolved_at,pipeline_claim_sources(document_id,discovered_documents(title,url))').in('draft_id', draftIds), 'claim ledger') : []; const meta = pipelineMetadata(candidate); const earlier = activeDrafts[1]; const bodyDiff = earlier ? lineDiff(earlier.body_markdown, current.body_markdown) : []; const materialization = materializationState(candidate, linkRows[0]);
  const usedDocumentIds = new Set(claims.flatMap(claim => (claim.pipeline_claim_sources || []).map(link => link.document_id)).filter(Boolean));
  const sourceDetail = doc => { let domain = ''; try { domain = new URL(doc.canonical_url || doc.url).hostname; } catch {} const retention = doc.retention?.reason || 'retained for this candidate'; const publisher = doc.pipeline_sources?.name || domain || 'Unknown publisher'; const type = doc.pipeline_sources?.source_type || 'document'; const usage = candidate.classification?.delivery_mode === 'article_first' ? 'available to writer and editor' : usedDocumentIds.has(doc.id) ? 'used in final draft' : 'retained, not cited in final draft'; return `<div class="source-row"><div class="src-title">${sourceHref(doc.canonical_url || doc.url, doc.title || 'Source')}<span class="src-meta">${esc([publisher, type, retention, usage, doc.extraction_status || ''].filter(Boolean).join(' · '))}</span></div></div>`; };
  const clearedImage = image => ['verified_reusable', 'official_press_asset'].includes(image.rights_status);
  const imageCards = activeImages.map(image => {
    const safeImage = mediaUrl(image.original_url);
    const cleared = clearedImage(image);
    return `<article class="review-image-card${image.selected ? ' is-selected' : ''}">
      ${safeImage ? `<a href="${esc(safeImage)}" target="_blank" rel="noreferrer"><img src="${esc(safeImage)}" alt="${esc(image.caption || 'Pipeline image candidate')}" loading="lazy"></a>` : ''}
      <div><p class="image-card-title">${esc(image.caption || 'Untitled image candidate')}</p><p class="field-note">${esc([image.creator, image.width && image.height ? `${image.width} × ${image.height}` : '', image.license].filter(Boolean).join(' · '))}</p><p><span class="stamp st-${esc(image.rights_status)}">${esc(humanize(image.rights_status))}</span></p>${(image.warning_flags || []).length ? `<p class="warning-count">${esc(image.warning_flags.join(' · '))}</p>` : ''}<label>Rights decision<select data-image-rights="${esc(image.id)}"><option value="unknown" ${image.rights_status === 'unknown' ? 'selected' : ''}>Not verified</option><option value="official_press_asset" ${image.rights_status === 'official_press_asset' ? 'selected' : ''}>Official press asset</option><option value="verified_reusable" ${image.rights_status === 'verified_reusable' ? 'selected' : ''}>Verified reusable license</option><option value="permission_required" ${image.rights_status === 'permission_required' ? 'selected' : ''}>Permission required</option><option value="do_not_use" ${image.rights_status === 'do_not_use' ? 'selected' : ''}>Do not use</option></select></label><button class="${image.selected ? '' : 'quiet'} compact-button" type="button" data-image-id="${esc(image.id)}" ${cleared ? '' : 'disabled'}>${image.selected ? 'Selected hero photo' : cleared ? 'Use as hero photo' : 'Rights clearance required'}</button></div>
    </article>`;
  }).join('');
  const advisoryChecks = [...(candidate.classification?.review_warnings || []).map(message => ({ kind: 'Evidence warning', message })), ...(candidate.classification?.revision_suggestions || []).map(message => ({ kind: 'Revision suggestion', message }))];
  title('Review package'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline review</span></div><h1>${esc(current.headline || candidate.title || 'Untitled')}</h1><p class="standfirst">${esc(current.dek || '')}</p></div>${deskNav(p, 'review')}<form id="pipeline-review" class="desk-form"><p class="notice form-message" data-form-message hidden></p><div class="editor-grid"><div><section class="editor-section"><h2>Article</h2><label>Headline<input name="headline" value="${esc(current.headline || candidate.title || '')}" required></label><label>Dek<textarea name="dek" class="textarea-short" required>${esc(current.dek || '')}</textarea></label><label>Body (Markdown)<textarea name="body_markdown" required>${esc(current.body_markdown || '')}</textarea></label><label>Primary section<input name="primary_section" value="${esc(meta.section)}" required></label><label>Recurring beats<input name="beats" value="${esc(meta.beats.join(', '))}"></label><label>Tags<input name="tags" value="${esc(meta.tags.join(', '))}"></label><div class="form-actions"><button type="submit">Save editorial changes</button></div></section><details class="editor-section" open><summary>Sources</summary>${activeDocuments.map(sourceDetail).join('') || '<p class="field-note">No sources retained.</p>'}${claims.map(claim => `<div class="claim-row"><strong>${esc(claim.claim)}</strong><span class="stamp st-${esc(claim.status)}">${esc(humanize(claim.status))}</span><p>${esc(claim.note || '')}</p><p class="field-note">${(claim.pipeline_claim_sources || []).map(link => sourceHref(link.discovered_documents?.url, link.discovered_documents?.title)).join(' · ') || 'No source mapping'}</p></div>`).join('')}</details><details class="editor-section"><summary>Version diff</summary>${earlier ? `${earlier.headline !== current.headline ? `<pre class="version-diff">- Headline: ${esc(earlier.headline || '')}\n+ Headline: ${esc(current.headline || '')}</pre>` : ''}${earlier.dek !== current.dek ? `<pre class="version-diff">- Dek: ${esc(earlier.dek || '')}\n+ Dek: ${esc(current.dek || '')}</pre>` : ''}${bodyDiff.length ? `<pre class="version-diff">${bodyDiff.map(row => `${row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '} ${esc(row.text)}`).join('\n')}</pre>` : ''}${earlier.headline === current.headline && earlier.dek === current.dek && !bodyDiff.length ? '<p class="field-note">No content changes in this version.</p>' : ''}` : '<p class="field-note">No earlier draft is retained.</p>'}</details></div><div><section class="editor-section"><h2>Review</h2><p class="meta-line">Status: <span class="stamp st-${esc(candidate.status)}">${esc(humanize(candidate.status))}</span></p><p class="field-note">Publishing is unavailable here. Approval does not publish.</p><label>Revision instructions<textarea name="revision_notes" class="textarea-short" placeholder="Required when requesting revision."></textarea></label><div class="buttons review-actions"><button name="action" value="approve" type="button">Approve</button><button name="action" value="reject" type="button" class="danger-quiet">Reject</button><button name="action" value="revision" type="button" class="quiet">Request revision</button><button name="action" value="archive" type="button" class="quiet">Archive</button></div></section><details class="editor-section" open><summary>Advisory checks</summary>${advisoryChecks.map(check => `<div class="claim-row"><strong>${esc(check.kind)}</strong><p>${esc(check.message)}</p></div>`).join('') || '<p class="field-note">No automatic warnings. Editorial review is still required.</p>'}</details><details class="editor-section"><summary>Research packet</summary><pre class="packet-data">${esc(JSON.stringify(packetRows[0]?.packet || {}, null, 2))}</pre><h3>Image candidates</h3>${activeImages.map(image => `<div class="claim-row">${sourceHref(image.original_url, image.caption || 'Image candidate')}<p><span class="stamp st-${esc(image.rights_status)}">${esc(humanize(image.rights_status))}</span> ${esc((image.warning_flags || []).join(', '))}</p></div>`).join('') || '<p class="field-note">No image candidates.</p>'}</details><details class="editor-section"><summary>Audit trail</summary>${decisions.map(decision => `<div class="revision-line"><span>${esc(humanize(decision.action))}</span><span>${esc(decision.profiles?.name || 'Editor')}</span><span>${dShort(decision.created_at)}</span><span>${esc(decision.note || '')}</span></div>`).join('') || '<p class="field-note">No review actions yet.</p>'}</details></div></div></form></div>`;
  const form = document.querySelector('#pipeline-review');
  const reviewPanel = document.querySelector('.review-actions')?.closest('.editor-section');
  if (reviewPanel) {
    const explanation = reviewPanel.querySelector('.field-note');
    if (explanation) explanation.textContent = 'Approve moves this article to On Deck. It will remain private until you publish it now or schedule it.';
    const approveButton = reviewPanel.querySelector('button[value="approve"]');
    if (approveButton) approveButton.textContent = 'Approve for On Deck';
    const rejectButton = reviewPanel.querySelector('button[value="reject"]');
    if (rejectButton) rejectButton.textContent = 'Deny';
    if (!materialization.storyId) reviewPanel.querySelector('.review-actions')?.insertAdjacentHTML('beforeend', '<button name="action" value="purge" type="button" class="danger-quiet">Purge proposal</button>');
  }
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
    const version = (current.version || 0) + 1;
    setBusy(form, true, 'Saving changes…');
    const { error } = await sb.from('pipeline_drafts').insert({ candidate_id: databaseCandidateId, pipeline_run_id: current.pipeline_run_id, version, headline: values.headline, dek: values.dek, body_markdown: values.body_markdown, prior_draft_id: current.id || null });
    if (error) { setBusy(form, false); return showFormMessage(form, error.message); }
    const { error: candidateError } = await sb.from('candidate_stories').update({ title: values.headline, classification: { ...(candidate.classification || {}), primary_section: values.primary_section, recurring_beats: values.beats.split(',').map(x => x.trim()).filter(Boolean), tags: values.tags.split(',').map(x => x.trim()).filter(Boolean) } }).eq('id', databaseCandidateId);
    if (candidateError) { setBusy(form, false); return showFormMessage(form, candidateError.message); }
    await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: 'edit', note: 'Editorial metadata or article updated.' });
    location.reload();
  };
  document.querySelectorAll('[data-image-rights]').forEach(select => select.onchange = async () => {
    const rightsStatus = select.value;
    select.disabled = true;
    const patch = { rights_status: rightsStatus };
    if (!['verified_reusable', 'official_press_asset'].includes(rightsStatus)) patch.selected = false;
    else {
      const image = activeImages.find(item => item.id === select.dataset.imageRights);
      patch.warning_flags = (image?.warning_flags || []).filter(flag => flag !== 'rights_not_verified');
    }
    const { error } = await sb.from('image_candidates').update(patch).eq('id', select.dataset.imageRights);
    if (error) {
      select.disabled = false;
      return showFormMessage(form, error.message);
    }
    await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: rightsStatus === 'do_not_use' ? 'reject_image' : 'edit', note: `Image rights set to ${humanize(rightsStatus)}.` });
    location.reload();
  });
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
    if (action === 'purge') {
      if (!confirm('Purge this proposal and all of its retained research, drafts, claims, images, jobs, and local artifacts? This cannot be undone.')) return;
      document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = true; });
      const { error } = await sb.rpc('purge_pipeline_candidate', { p_candidate_id: databaseCandidateId, p_reason: 'editor_purge' });
      if (error) { document.querySelectorAll('.review-actions button').forEach(control => { control.disabled = false; }); return showFormMessage(form, error.message); }
      location.href = '/newsroom/review'; return;
    }
    if (action === 'revision' && !notes) return showFormMessage(form, 'Revision instructions are required.');
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

async function onDeck() {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  const stories = await dataOf(
    sb.from('stories')
      .select('id,title,slug,dek,status,scheduled_for,updated_at,revision_number,editor_id,sections(name),story_beats(beat_id),story_tags(tags(name)),sources(id)')
      .in('status', ['fact_check', 'scheduled'])
      .order('scheduled_for', { ascending: true, nullsFirst: true })
      .order('updated_at', { ascending: false }),
    'on deck stories'
  ) || [];
  title('On deck');
  const cards = stories.map(story => {
    const scheduled = story.status === 'scheduled';
    const scheduleValue = story.scheduled_for ? localDateTimeValue(story.scheduled_for) : '';
    return `<article class="on-deck-card" id="story-${esc(story.id)}">
      <div class="on-deck-copy"><div class="meta-line"><span class="stamp st-${esc(story.status)}">${esc(workflowLabel(story.status))}</span><span>${esc(story.sections?.name || '')}</span>${scheduled ? `<span>Publishes ${esc(dDateTime(story.scheduled_for))}</span>` : ''}</div><h2><a href="/newsroom/${esc(story.id)}">${esc(story.title || 'Untitled story')}</a></h2><p>${esc(story.dek || '')}</p><p class="field-note">${story.sources?.length || 0} source${story.sources?.length === 1 ? '' : 's'} · <a class="text-link" href="/newsroom/${esc(story.id)}">Edit article</a></p></div>
      <form class="on-deck-actions" data-story-id="${esc(story.id)}"><p class="notice form-message" data-form-message hidden></p><button type="button" data-publish>Publish now</button><div class="schedule-row"><label for="schedule-${esc(story.id)}">Or schedule</label><input id="schedule-${esc(story.id)}" name="scheduled_for" type="datetime-local" value="${esc(scheduleValue)}" min="${esc(localDateTimeValue(Date.now() + 60000))}"><button type="button" class="quiet" data-schedule>${scheduled ? 'Reschedule' : 'Schedule'}</button></div>${scheduled ? '<button type="button" class="quiet compact-button" data-unschedule>Return to On Deck</button>' : ''}</form>
    </article>`;
  }).join('');
  app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>On deck</span></div><h1>Approved and ready</h1><p class="standfirst">Every article here has passed review. Publish it now, schedule a release time, or open it for a final edit.</p></div>${deskNav(p, 'on-deck')}<section class="desk-section"><div class="section-head"><div><span class="label">Ready to release</span><h2>${stories.length} article${stories.length === 1 ? '' : 's'}</h2></div></div><div class="on-deck-list">${cards || '<p class="empty-note">Nothing is on deck. Approved articles will appear here.</p>'}</div></section></div>`;
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
    form.querySelector('[data-publish]').onclick = () => transition(form, 'published');
    form.querySelector('[data-schedule]').onclick = () => {
      const value = form.scheduled_for.value;
      const scheduledFor = value ? new Date(value) : null;
      if (!scheduledFor || Number.isNaN(scheduledFor.getTime()) || scheduledFor <= new Date()) return showFormMessage(form, 'Choose a future date and time.');
      transition(form, 'scheduled', scheduledFor.toISOString());
    };
    form.querySelector('[data-unschedule]')?.addEventListener('click', () => transition(form, 'fact_check'));
  });
}

/* ---------- Story editor ---------- */

async function edit(id) {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  const [sections, beats, editors, record, sourceRows, presentationRows, mediaRows, pipelineLinks] = await Promise.all([
    dataOf(sb.from('sections').select('id,name,slug').order('name'), 'editor sections'),
    dataOf(sb.from('beats').select('id,name,slug').order('name'), 'editor beats'),
    dataOf(sb.from('profiles').select('id,name,role').in('role', ['admin', 'editor']).order('name'), 'responsible editors'),
    id
      ? dataOf(
        sb.from('stories').select('id,title,slug,dek,summary,body,section_id,author_id,editor_id,status,published_at,scheduled_for,updated_at,reading_time_minutes,hero_media_id,seo_title,seo_description,revision_number,story_beats(beat_id),story_tags(tags(name))').eq('id', id).maybeSingle(),
        'story editor'
      )
      : Promise.resolve({
        title: '', slug: '', dek: '', summary: '', body: '', section_id: 'internet',
        author_id: p.id, editor_id: p.role === 'contributor' ? null : p.id,
        status: 'idea', published_at: null, scheduled_for: null,
        seo_title: '', seo_description: '', revision_number: 1, story_beats: [], story_tags: []
      }),
    id
      ? dataOf(
        sb.from('sources').select('id,title,publisher,url,source_type,sort_order').eq('story_id', id).order('sort_order'),
        'editor sources'
      )
      : Promise.resolve([]),
    id ? optionalColumn(sb.from('stories').select('presentation').eq('id', id).limit(1)) : Promise.resolve([]),
    id
      ? optionalData(sb.from('media').select('id,public_url,alt_text,caption,credit,width,height,source_url,rights_status,rights_note,created_at,story_id').eq('story_id', id).order('created_at', { ascending: false }), 'article media')
      : Promise.resolve([]),
    id ? optionalData(sb.from('pipeline_story_links').select('candidate_id').eq('story_id', id).limit(1), 'pipeline story link') : Promise.resolve([])
  ]);
  const s = record;
  if (!s) { title('Not found'); return app.innerHTML = notFound(); }
  const chosen = new Set(s.story_beats?.map(x => x.beat_id));
  const existingTags = (s.story_tags || []).map(x => x.tags?.name).filter(Boolean).join(', ');
  const safeSources = (sourceRows || []).map(source => ({ ...source, safe_url: externalUrl(source.url) }));
  const linkedCandidateId = pipelineLinks[0]?.candidate_id || null;
  const pipelineImages = linkedCandidateId
    ? await optionalData(
      sb.from('image_candidates').select('id,candidate_id,original_url,creator,caption,rights_status,warning_flags,width,height,file_type,selected').eq('candidate_id', linkedCandidateId).order('created_at'),
      'article pipeline images'
    )
    : [];
  const validSourceCount = safeSources.filter(source => source.safe_url).length;
  const editorStatuses = statuses.filter(status => !['fact_check', 'scheduled', 'published'].includes(status));
  if (['fact_check', 'scheduled', 'published'].includes(s.status)) editorStatuses.push(s.status);
  const availableStatuses = p.role === 'contributor'
    ? ['idea', 'researching', 'draft', 'review']
    : editorStatuses;
  const assignedEditor = (editors || []).find(editor => editor.id === s.editor_id);
  title(`${id ? 'Edit' : 'New'} story`);
  app.innerHTML = `<div class="desk">
  <div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${id ? `Editing · ${esc(s.slug)}` : 'New story'}</span></div><h1>${id ? 'Edit story' : 'New story'}</h1></div>
  ${deskNav(p, id ? '' : 'new')}
  <form id="story" class="desk-form" novalidate>
  <p class="notice form-message" data-form-message role="alert" hidden></p>
  <div class="editor-grid">
    <div>
      <section class="editor-section">
        <h2>Story</h2>
        <label for="story-title">Title</label><input id="story-title" name="title" maxlength="180" value="${esc(s.title)}" placeholder="Title" required>
        <label for="story-dek">Dek</label><textarea id="story-dek" class="textarea-short" name="dek" maxlength="320" placeholder="One clear sentence that earns the click." required>${esc(s.dek)}</textarea>
        <label for="story-summary">Summary</label><textarea id="story-summary" class="textarea-short" name="summary" maxlength="600" placeholder="The brief readers should carry away.">${esc(s.summary)}</textarea>
        <label for="story-section">Primary section</label><select id="story-section" name="section_id" required>${(sections || []).map(x => `<option value="${x.id}" ${x.id === s.section_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <p class="field-note">${esc(EDITORIAL_CLASSIFICATION_HELP)}</p>
        <p class="field-note" id="section-question">${esc(promises[s.section_id] || '')}</p>
        <fieldset class="topic-fieldset"><legend>Recurring beats</legend><div class="topic-checks">${(beats || []).map(t => `<label><input type="checkbox" name="beat" value="${t.id}" ${chosen.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div></fieldset>
        <label for="story-tags">Tags</label><input id="story-tags" name="tags" maxlength="500" value="${esc(existingTags)}" placeholder="Comma-separated specific tags">
        <label for="story-body">Body (Markdown)</label><textarea id="story-body" name="body" placeholder="Body (Markdown)" required>${esc(s.body)}</textarea>
        <div class="editor-preview-actions">
          <button type="button" class="article-preview-launch" data-open-article-preview>Open Article Preview</button>
          <button type="button" class="quiet article-photo-launch" data-open-photo-library>Add photos</button>
        </div>
        <p class="field-note">Preview unsaved changes with the live article renderer. Nothing is published from preview.</p>
      </section>
    </div>
    <div>
      <section class="editor-section">
        <h2>Editorial</h2>
        <p class="meta-line">Current status: <span class="stamp st-${s.status || 'idea'}">${esc(workflowLabel(s.status || 'idea'))}</span></p>
        <label for="story-status">Status</label><select id="story-status" name="status">${availableStatuses.map(status => `<option value="${status}" ${status === s.status ? 'selected' : ''}>${esc(status === 'review' ? 'Submit for review' : workflowLabel(status))}</option>`).join('')}</select>
        ${p.role === 'contributor'
          ? `<p class="field-note">Responsible editor: ${esc(assignedEditor?.name || 'Unassigned. An editor will claim the story during review.')}</p>`
          : `<label for="story-editor">Responsible editor</label><select id="story-editor" name="editor_id"><option value="">Unassigned</option>${(editors || []).map(editor => `<option value="${editor.id}" ${editor.id === s.editor_id ? 'selected' : ''}>${esc(editor.name)} · ${esc(humanize(editor.role))}</option>`).join('')}</select>`}
        <p class="field-note">${p.role === 'contributor' ? 'Choose Submit for review when the article is ready for an editor.' : s.status === 'review' ? 'Review the article and sources, then approve it for On Deck or return it for more work.' : 'Publishing happens from On Deck after approval. A responsible editor, complete metadata, and a valid source are required.'}</p>
      </section>
      <details class="editor-section" open>
        <summary>Publishing</summary>
        <div class="secondary-fields">
          <label for="story-slug">Slug (stable URL)</label><input id="story-slug" name="slug" maxlength="96" value="${esc(s.slug)}" placeholder="Filled from the title if blank">
          <label for="story-seo-title">SEO title</label><input id="story-seo-title" name="seo_title" maxlength="180" value="${esc(s.seo_title)}" placeholder="Defaults to the title">
          <label for="story-seo-description">SEO description</label><textarea id="story-seo-description" class="textarea-short" name="seo_description" maxlength="320" placeholder="Defaults to the dek">${esc(s.seo_description)}</textarea>
        </div>
      </details>
    </div>
  </div>
  <div class="action-bar">
    <span class="meta-line">${id ? `Revision ${Number(s.revision_number || 1)} · ${esc(workflowLabel(s.status))}.` : 'Create the draft, then add its source on the saved story.'}</span>
    <div class="buttons"><button type="submit">Save edits</button>${s.status === 'published' ? '<button type="button" class="danger-quiet" data-hide-story>Take down</button>' : ''}${p.role !== 'contributor' && s.status === 'review' ? '<button type="submit" name="editor_decision" value="approve">Approve for On Deck</button><button type="submit" name="editor_decision" value="return" class="danger-quiet">Deny / return to draft</button>' : ''}${['fact_check', 'scheduled'].includes(s.status) ? '<a class="button quiet" href="/newsroom/on-deck">Open On Deck</a>' : ''}</div>
  </div>
  </form>
  <section class="editor-section photo-editor" data-photo-library aria-labelledby="photos-heading">
    <div class="section-head">
      <div><span class="label">Article media</span><h2 id="photos-heading">Photos</h2></div>
      <p class="field-note">Upload photos for this article only. Save the story before adding photos so they remain attached to it.</p>
    </div>
    <p class="notice form-message" data-photo-message role="alert" hidden></p>
    <div class="article-media-attached" data-article-media-attached><h3>Photos in this article</h3><div class="attached-media-grid"><p class="field-note">No photos have been added to this article yet.</p></div></div>
    <div class="photo-editor-grid">
      <div class="photo-library-picker">
        <label for="editor-photo-select">Hero and image library</label>
        <select id="editor-photo-select"><option value="">Choose a photo</option></select>
        <div class="photo-editor-actions">
          <button type="button" data-editor-use-hero>Use as hero</button>
          <button type="button" class="quiet" data-editor-align-hero>Preview and align hero</button>
          <button type="button" class="quiet" data-editor-open-preview>Place in body</button>
        </div>
        <div class="photo-library-preview" data-photo-library-preview><p class="field-note">Choose a photo to inspect it.</p></div>
      </div>
      <form id="photo-upload-form" class="photo-upload-form">
        <h3>Upload a batch</h3>
        <p class="field-note">Choose up to 12 photos. Add metadata and decide whether each belongs in the library, the hero, or the article body before uploading.</p>
        <label for="photo-file">Image files</label><input id="photo-file" name="files" type="file" accept="image/avif,image/jpeg,image/png,image/webp" multiple required>
        <div class="photo-batch-staging" data-photo-batch-staging><p class="field-note">Selected photos will appear here for review.</p></div>
        <h4>Rights for this batch</h4>
        <label for="photo-source-url">Source or license URL</label><input id="photo-source-url" name="source_url" type="url" maxlength="2048" placeholder="https://">
        <label for="photo-rights">Publication rights</label><select id="photo-rights" name="rights_status" required><option value="">Choose a rights decision</option>${MEDIA_RIGHTS_DECISIONS.map(item => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}</select>
        <label for="photo-rights-note">Rights record</label><textarea id="photo-rights-note" name="rights_note" class="textarea-short" maxlength="600" placeholder="License, ownership, permission, or press-use basis" required></textarea>
        <div class="form-actions"><button type="submit">Upload selected photos</button></div>
      </form>
    </div>
  </section>
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
          <label for="preview-focal-x">Focal point · horizontal</label><input id="preview-focal-x" type="range" min="0" max="100" value="50">
          <label for="preview-focal-y">Focal point · vertical</label><input id="preview-focal-y" type="range" min="0" max="100" value="50">
          <p class="field-note">Pipeline candidates marked “preview only” can be evaluated here, but block approval until rights are verified.</p>
        </section>
        <section data-control-section="detour">
          <h3>Detour card</h3>
          <label class="inline-check"><input id="preview-detour-visible" type="checkbox"> Show Detour</label>
          <label for="preview-detour-label">Label</label><input id="preview-detour-label" maxlength="80">
          <label for="preview-detour-text">Text</label><textarea id="preview-detour-text" class="textarea-short" maxlength="600"></textarea>
          <label for="preview-detour-after">Place after</label><select id="preview-detour-after"></select>
          <p class="field-note">This card uses dedicated fields. Summary and Dek are never copied into it.</p>
        </section>
        <section data-control-section="inline-image">
          <h3>Inline images</h3>
          <label for="preview-inline-source">Image</label><select id="preview-inline-source"><option value="">Choose an image</option></select>
          <label for="preview-inline-after">Insert after</label><select id="preview-inline-after"></select>
          <label for="preview-inline-layout">Layout</label><select id="preview-inline-layout">${INLINE_IMAGE_LAYOUTS.map(item => `<option value="${item.value}">${esc(item.label)}</option>`).join('')}</select>
          <label for="preview-inline-alt">Alt text</label><input id="preview-inline-alt" maxlength="320">
          <label for="preview-inline-caption">Caption</label><textarea id="preview-inline-caption" class="textarea-short" maxlength="500"></textarea>
          <label for="preview-inline-credit">Credit</label><input id="preview-inline-credit" maxlength="240">
          <button type="button" data-add-inline-image>Add inline image</button>
          <div class="inline-image-list" data-inline-image-list></div>
        </section>
      </aside>
      <main class="article-preview-stage" data-preview-stage data-viewport="desktop">
        <iframe class="article-preview-canvas" data-preview-canvas title="Rendered article preview"></iframe>
      </main>
    </div>
  </section>
  ${id ? `<section class="editor-section source-editor" aria-labelledby="sources-heading">
    <h2 id="sources-heading">Sources</h2>
    <p class="muted">Sources are part of the story. Save any story edits before adding one.</p>
    <div class="source-list">${safeSources.length ? safeSources.map(source => `<div class="source-row">
      <div class="src-title">${source.safe_url ? `<a href="${esc(source.safe_url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>` : `<span>${esc(source.title)}</span>`}<span class="src-meta">${esc(source.publisher || 'Publisher not set')} · ${esc(humanize(source.source_type))}</span></div>
    </div>`).join('') : emptyNote('No source is on file yet.')}</div>
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
  </div>`;
  bindSignOut();
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
      alt_text: item.alt_text,
      caption: item.caption,
      credit: item.credit,
      width: item.width,
      height: item.height,
      source_url: item.source_url,
      rights_status: item.rights_status || 'permission_required',
      rights_note: item.rights_note || '',
      previewOnly: !['verified_reusable', 'official_press_asset'].includes(item.rights_status),
      label: item.caption || item.alt_text || `Media ${item.id.slice(0, 8)}`
    })),
    ...(pipelineImages || []).map(item => ({
      id: `pipeline:${item.id}`,
      candidateImageId: item.id,
      original_url: item.original_url,
      alt_text: item.caption || '',
      caption: item.caption || '',
      credit: item.creator || '',
      width: item.width,
      height: item.height,
      rights_status: item.rights_status,
      warning_flags: item.warning_flags || [],
      previewOnly: !['verified_reusable', 'official_press_asset'].includes(item.rights_status),
      label: item.caption || item.creator || `Pipeline candidate ${item.id.slice(0, 8)}`
    }))
  ];
  const mediaById = new Map(mediaLibrary.map(item => [item.id, item]));
  let presentationDraft = normalizePresentation(presentationRows[0]?.presentation || {});
  if (!presentationDraft.hero && s.hero_media_id && mediaById.has(`media:${s.hero_media_id}`)) {
    presentationDraft.hero = { ...mediaById.get(`media:${s.hero_media_id}`), crop: 'auto', focalX: 50, focalY: 50 };
  }
  let dirty = false;
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
  sectionSelect?.addEventListener('change', () => { sectionQuestion.textContent = promises[sectionSelect.value] || ''; });
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
  const hasRightsBlocker = () => {
    const used = [presentationDraft.hero, ...presentationDraft.inlineImages].filter(Boolean);
    return used.some(item => item.previewOnly || !['verified_reusable', 'official_press_asset', undefined, null, ''].includes(item.rights_status));
  };
  const updateInlineList = () => {
    const list = document.querySelector('[data-inline-image-list]');
    if (!list) return;
    list.innerHTML = presentationDraft.inlineImages.length
      ? presentationDraft.inlineImages.map((item, index) => `<div class="inline-image-item"><span>${esc(item.caption || item.alt_text || item.label || `Image ${index + 1}`)} · ${esc(humanize(item.layout || 'wide'))}</span><button type="button" class="quiet compact-button" data-remove-inline="${index}">Remove</button></div>`).join('')
      : '<p class="field-note">No inline images placed.</p>';
    list.querySelectorAll('[data-remove-inline]').forEach(button => {
      button.onclick = () => {
        presentationDraft.inlineImages.splice(Number(button.dataset.removeInline), 1);
        setDirty();
        renderPreview();
      };
    });
  };
  const syncPreviewControls = () => {
    document.getElementById('preview-composition').value = presentationDraft.composition;
    document.getElementById('preview-accent').value = presentationDraft.accent;
    document.getElementById('preview-detour-visible').checked = presentationDraft.detour.visible;
    document.getElementById('preview-detour-label').value = presentationDraft.detour.label;
    document.getElementById('preview-detour-text').value = presentationDraft.detour.text;
    const options = blockOptions();
    document.getElementById('preview-detour-after').innerHTML = options;
    document.getElementById('preview-inline-after').innerHTML = options;
    document.getElementById('preview-detour-after').value = String(presentationDraft.detour.afterBlock);
    const hero = presentationDraft.hero;
    document.getElementById('preview-hero').value = hero?.id || '';
    document.getElementById('preview-hero-crop').value = hero?.crop || 'auto';
    document.getElementById('preview-focal-x').value = String(hero?.focalX ?? 50);
    document.getElementById('preview-focal-y').value = String(hero?.focalY ?? 50);
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
  const photoBatchStaging = document.querySelector('[data-photo-batch-staging]');
  const photoMessage = document.querySelector('[data-photo-message]');
  const photoLibraryPreview = document.querySelector('[data-photo-library-preview]');
  const mediaOptions = mediaLibrary.map(item => `<option value="${esc(item.id)}">${esc(item.label)}${item.previewOnly ? ` · preview only (${esc(humanize(item.rights_status))})` : ''}</option>`).join('');
  heroSelect.insertAdjacentHTML('beforeend', mediaOptions);
  inlineSelect.insertAdjacentHTML('beforeend', mediaOptions);
  editorPhotoSelect.insertAdjacentHTML('beforeend', mediaOptions);
  const showPhotoMessage = (message, kind = 'error') => {
    photoMessage.textContent = message;
    photoMessage.className = `notice form-message${kind === 'ok' ? ' ok' : ''}`;
    photoMessage.hidden = !message;
  };
  const mediaOption = item => `<option value="${esc(item.id)}">${esc(item.label)}${item.previewOnly ? ` · preview only (${esc(humanize(item.rights_status))})` : ''}</option>`;
  const renderAttachedMedia = () => {
    const target = document.querySelector('[data-article-media-attached] .attached-media-grid');
    if (!target) return;
    const items = mediaLibrary;
    target.innerHTML = items.length ? items.map(item => {
      const url = mediaUrl(item.public_url || item.original_url);
      const hero = presentationDraft.hero?.id === item.id ? '<span class="stamp st-published">Hero</span>' : '';
      const inline = presentationDraft.inlineImages.some(image => image.id === item.id || image.sourceId === item.mediaId) ? '<span class="stamp st-review">In body</span>' : '';
      const rights = item.previewOnly ? '<span class="stamp st-review">Rights review required</span>' : '<span class="stamp st-published">Rights cleared</span>';
      return `<figure class="attached-media-card">${url ? `<img src="${esc(url)}" alt="${esc(item.alt_text || '')}">` : ''}<figcaption><strong>${esc(item.label)}</strong><span>${hero}${inline}${rights}</span><button type="button" class="quiet compact-button" data-photo-use-hero="${esc(item.id)}">${presentationDraft.hero?.id === item.id ? 'Current hero' : 'Use as hero'}</button></figcaption></figure>`;
    }).join('') : '<p class="field-note">No photos have been added to this article yet.</p>';
    target.querySelectorAll('[data-photo-use-hero]').forEach(button => button.onclick = () => {
      const source = mediaById.get(button.dataset.photoUseHero);
      if (!source) return;
      presentationDraft.hero = { ...source, crop: 'auto', focalX: 50, focalY: 50 };
      heroSelect.value = source.id;
      setDirty();
      renderAttachedMedia();
      showPhotoMessage(source.previewOnly ? 'Hero selected for preview. Verify rights before publishing.' : 'Hero replaced. Open Preview and align it before saving.', source.previewOnly ? 'error' : 'ok');
    });
  };
  const addToMediaLibrary = item => {
    mediaLibrary.unshift(item);
    mediaById.set(item.id, item);
    const option = mediaOption(item);
    heroSelect.insertAdjacentHTML('beforeend', option);
    inlineSelect.insertAdjacentHTML('beforeend', option);
    editorPhotoSelect.insertAdjacentHTML('beforeend', option);
    renderAttachedMedia();
  };
  renderAttachedMedia();
  const selectedEditorPhoto = () => mediaById.get(editorPhotoSelect.value);
  const renderPhotoLibraryPreview = () => {
    const item = selectedEditorPhoto();
    if (!item) {
      photoLibraryPreview.innerHTML = '<p class="field-note">Choose a photo to inspect it.</p>';
      return;
    }
    const url = mediaUrl(item.public_url || item.original_url);
    photoLibraryPreview.innerHTML = `${url ? `<img src="${esc(url)}" alt="${esc(item.alt_text || '')}">` : ''}
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
    presentationDraft.hero = { ...source, crop: 'auto', focalX: 50, focalY: 50 };
    heroSelect.value = source.id;
    setDirty();
    showPhotoMessage(source.previewOnly ? 'Hero selected for preview only. Record valid rights before approval.' : 'Hero photo selected. Save the article to keep it.', source.previewOnly ? 'error' : 'ok');
  });
  document.querySelector('[data-editor-align-hero]')?.addEventListener('click', () => {
    const source = selectedEditorPhoto();
    if (!source) return showPhotoMessage('Choose a photo before aligning the hero.');
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
    openPreview();
    document.querySelector('[data-control-section="inline-image"]')?.scrollIntoView({ block: 'start' });
  });
  let stagedPhotoUrls = [];
  const clearStagedPhotoUrls = () => {
    stagedPhotoUrls.forEach(url => URL.revokeObjectURL(url));
    stagedPhotoUrls = [];
  };
  const renderPhotoBatch = () => {
    clearStagedPhotoUrls();
    const files = Array.from(photoFileInput.files || []);
    const batchError = validateStoryImageBatch(files);
    if (batchError && files.length) showPhotoMessage(batchError);
    if (!files.length) {
      photoBatchStaging.innerHTML = '<p class="field-note">Selected photos will appear here for review.</p>';
      return;
    }
    photoBatchStaging.innerHTML = files.map((file, index) => {
      const previewUrl = URL.createObjectURL(file);
      stagedPhotoUrls.push(previewUrl);
      const label = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
      return `<article class="photo-batch-card" data-photo-batch-index="${index}">
        <img src="${esc(previewUrl)}" alt="">
        <div>
          <p><strong>${esc(file.name)}</strong></p>
          <p class="field-note">${esc((file.size / 1024 / 1024).toFixed(1))} MB · ${esc(file.type || 'Unknown type')}</p>
          <label>Alt text<input data-batch-alt maxlength="320" value="${esc(label)}" required></label>
          <label>Caption<textarea data-batch-caption class="textarea-short" maxlength="500"></textarea></label>
          <label>Credit<input data-batch-credit maxlength="240"></label>
          <label>Placement<select data-batch-placement>
            <option value="library">Library only</option>
            <option value="hero">Hero photo</option>
            <option value="body">Article body</option>
          </select></label>
        </div>
      </article>`;
    }).join('');
    photoBatchStaging.querySelectorAll('[data-batch-placement]').forEach(select => {
      select.onchange = () => {
        if (select.value !== 'hero') return;
        photoBatchStaging.querySelectorAll('[data-batch-placement]').forEach(other => {
          if (other !== select && other.value === 'hero') other.value = 'library';
        });
      };
    });
  };
  photoFileInput.onchange = renderPhotoBatch;
  photoUploadForm.onsubmit = async event => {
    event.preventDefault();
    showPhotoMessage('');
    if (!id) return showPhotoMessage('Save the story before adding photos so they stay attached to this article.');
    const values = new FormData(photoUploadForm);
    const files = Array.from(photoFileInput.files || []);
    const batchError = validateStoryImageBatch(files);
    if (batchError) return showPhotoMessage(batchError);
    const sourceUrl = externalUrl(values.get('source_url')) || '';
    const cards = Array.from(photoBatchStaging.querySelectorAll('[data-photo-batch-index]'));
    const entries = files.map((file, index) => {
      const card = cards[index];
      return {
        file,
        altText: card.querySelector('[data-batch-alt]').value,
        caption: card.querySelector('[data-batch-caption]').value,
        credit: card.querySelector('[data-batch-credit]').value,
        placement: card.querySelector('[data-batch-placement]').value
      };
    });
    for (const entry of entries) {
      const validationError = validateStoryImage({
        file: entry.file,
        altText: entry.altText,
        rightsStatus: values.get('rights_status'),
        rightsNote: values.get('rights_note'),
        sourceUrl: values.get('source_url')
      });
      if (validationError) return showPhotoMessage(`${entry.file.name}: ${validationError}`);
    }
    setBusy(photoUploadForm, true, `Uploading 0 of ${entries.length}…`);
    const uploadButton = photoUploadForm.querySelector('button[type="submit"]');
    const uploaded = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      uploadButton.textContent = `Uploading ${index + 1} of ${entries.length}…`;
      const storagePath = storyMediaPath(p.id, entry.file, crypto.randomUUID());
      const { error: uploadError } = await sb.storage.from(STORY_MEDIA_BUCKET).upload(storagePath, entry.file, {
        cacheControl: '31536000',
        contentType: entry.file.type,
        upsert: false
      });
      if (uploadError) {
        setBusy(photoUploadForm, false);
        return showPhotoMessage(`${entry.file.name} could not be uploaded. ${uploaded.length} earlier photo${uploaded.length === 1 ? ' was' : 's were'} added successfully.`);
      }
      const { data: publicData } = sb.storage.from(STORY_MEDIA_BUCKET).getPublicUrl(storagePath);
      const publicUrl = mediaUrl(publicData?.publicUrl);
      const { data: savedMedia, error: mediaError } = await sb.from('media').insert({
        storage_path: storagePath,
        public_url: publicUrl,
        filename: entry.file.name,
        mime_type: entry.file.type,
        alt_text: String(entry.altText || '').trim(),
        caption: String(entry.caption || '').trim() || null,
        credit: String(entry.credit || '').trim() || null,
        source_url: sourceUrl || null,
        story_id: id || null,
        rights_status: values.get('rights_status'),
        rights_note: String(values.get('rights_note') || '').trim(),
        uploaded_by: p.id
      }).select('id,public_url,alt_text,caption,credit,width,height,source_url,rights_status,rights_note').single();
      if (mediaError || !savedMedia) {
        await sb.storage.from(STORY_MEDIA_BUCKET).remove([storagePath]);
        setBusy(photoUploadForm, false);
        return showPhotoMessage(`${entry.file.name} uploaded, but its newsroom record could not be saved. ${uploaded.length} earlier photo${uploaded.length === 1 ? ' was' : 's were'} added successfully.`);
      }
      const item = {
        id: `media:${savedMedia.id}`,
        mediaId: savedMedia.id,
        public_url: savedMedia.public_url,
        alt_text: savedMedia.alt_text,
        caption: savedMedia.caption,
        credit: savedMedia.credit,
        width: savedMedia.width,
        height: savedMedia.height,
        source_url: savedMedia.source_url,
        rights_status: savedMedia.rights_status,
        rights_note: savedMedia.rights_note,
        previewOnly: false,
        label: savedMedia.caption || savedMedia.alt_text || entry.file.name
      };
      addToMediaLibrary(item);
      uploaded.push({ item, placement: entry.placement });
    }
    const hero = uploaded.find(entry => entry.placement === 'hero');
    if (hero) {
      presentationDraft.hero = { ...hero.item, crop: 'auto', focalX: 50, focalY: 50 };
      heroSelect.value = hero.item.id;
    }
    const bodyPhotos = uploaded.filter(entry => entry.placement === 'body');
    bodyPhotos.forEach(({ item }) => {
      if (!presentationDraft.inlineImages.some(image => image.id === item.id)) presentationDraft.inlineImages.push({ ...item, afterBlock: 0, layout: 'wide' });
    });
    renderAttachedMedia();
    const last = uploaded.at(-1)?.item;
    if (last) {
      editorPhotoSelect.value = last.id;
      renderPhotoLibraryPreview();
    }
    if (hero || bodyPhotos.length) setDirty();
    photoUploadForm.reset();
    clearStagedPhotoUrls();
    renderPhotoBatch();
    setBusy(photoUploadForm, false);
    showPhotoMessage(`${uploaded.length} photo${uploaded.length === 1 ? '' : 's'} uploaded.${hero ? ' Hero selected.' : ''}${bodyPhotos.length ? ` ${bodyPhotos.length} added to the body.` : ''} Save the article to keep placements.`, 'ok');
    if (bodyPhotos.length) {
      inlineSelect.value = bodyPhotos[0].item.id;
      openPreview();
      document.querySelector('[data-control-section="inline-image"]')?.scrollIntoView({ block: 'start' });
    }
  };
  document.querySelector('[data-open-article-preview]')?.addEventListener('click', openPreview);
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
  for (const id of ['preview-hero-crop', 'preview-focal-x', 'preview-focal-y']) {
    document.getElementById(id).oninput = () => {
      if (!presentationDraft.hero) return;
      presentationDraft.hero.crop = document.getElementById('preview-hero-crop').value;
      presentationDraft.hero.focalX = Number(document.getElementById('preview-focal-x').value);
      presentationDraft.hero.focalY = Number(document.getElementById('preview-focal-y').value);
      setDirty();
      renderPreview();
    };
  }
  document.getElementById('preview-detour-visible').onchange = event => { presentationDraft.detour.visible = event.target.checked; setDirty(); renderPreview(); };
  document.getElementById('preview-detour-label').oninput = event => { presentationDraft.detour.label = event.target.value; setDirty(); renderPreview(); };
  document.getElementById('preview-detour-text').oninput = event => { presentationDraft.detour.text = event.target.value; setDirty(); renderPreview(); };
  document.getElementById('preview-detour-after').onchange = event => { presentationDraft.detour.afterBlock = Number(event.target.value); setDirty(); renderPreview(); };
  document.querySelector('[data-add-inline-image]').onclick = () => {
    const source = mediaById.get(inlineSelect.value);
    if (!source) return showPreviewMessage('Choose an image before adding it.');
    presentationDraft.inlineImages.push({
      ...source,
      id: `${source.id}:${Date.now()}`,
      sourceId: source.id,
      afterBlock: Number(document.getElementById('preview-inline-after').value || 0),
      layout: document.getElementById('preview-inline-layout').value,
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
      if (button.dataset.previewDecision === 'approve' && hasRightsBlocker()) {
        showPreviewMessage('Approval is blocked because a selected image still needs a valid rights decision.');
        return;
      }
      const submitButton = storyForm.querySelector(`[name="editor_decision"][value="${button.dataset.previewDecision}"]`);
      if (!submitButton) return;
      closePreview();
      submitButton.click();
    };
  });

  storyForm.onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget;
    showFormMessage(form, '');
    const f = new FormData(form), beatIds = f.getAll('beat').map(String), tags = String(f.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean), payload = Object.fromEntries(f);
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
    payload.author_id = s.author_id || p.id;
    payload.editor_id = p.role === 'contributor' ? (s.editor_id || null) : (payload.editor_id || null);
    payload.reading_time_minutes = Math.max(1, Math.ceil(payload.body.split(/\s+/).filter(Boolean).length / 220));
    payload.presentation = presentationForSave(presentationDraft);
    if (nextStatus === 'published') payload.published_at = s.published_at || new Date().toISOString();
    else if (s.published_at) payload.published_at = s.published_at;
    if (nextStatus === 'fact_check') payload.scheduled_for = null;
    delete payload.beat;
    delete payload.tags;
    if (['fact_check', 'published'].includes(nextStatus) && hasRightsBlocker()) {
      showFormMessage(form, 'A selected preview image still needs a valid rights decision. Verify or replace it before approval.');
      return;
    }
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
      showFormMessage(form, 'Before approval, assign an editor, complete the title, dek, body, and primary section, and add a valid source.');
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
        p_tags: tags
      })
      : await sb.from('stories').insert(payload).select('id').single();
    const saved = Array.isArray(savedResult) ? savedResult[0] : savedResult;
    if (saveError || !saved) {
      setBusy(form, false);
      showFormMessage(form, !saveError ? 'This story changed in another session. Reload before saving again.' : 'The story could not be saved. Check the required fields and try again.');
      return;
    }
    if (!id) {
      const { error: classificationError } = await sb.rpc('save_story', { p_story_id: saved.id, p_expected_revision: 1, p_patch: {}, p_beat_ids: beatIds, p_tags: tags });
      if (classificationError) { setBusy(form, false); showFormMessage(form, 'The draft was saved, but its classification was not added. Open it from the newsroom and try again.'); return; }
    }
    dirty = false;
    if (editorDecision === 'approve') location.href = `/newsroom/on-deck#story-${saved.id}`;
    else if (editorDecision === 'return') location.href = '/newsroom/review';
    else location.href = '/newsroom/' + saved.id;
  };
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
  if (pathname === '/topics') return topics();
  if (/^\/topics\/[^/]+$/.test(pathname)) return topic(pathname.split('/')[2]);
  if (/^\/sections\/[^/]+$/.test(pathname)) return section(pathname.split('/')[2]);
  if (/^\/stories\/[^/]+$/.test(pathname)) return showStory(pathname.split('/')[2]);
  if (pathname === '/search') return search();
  if (pathname === '/newsroom') return newsroom();
  if (pathname === '/newsroom/analytics') return analyticsDashboard();
  if (pathname === '/newsroom/pipeline') return pipelineControls();
  if (/^\/newsroom\/pipeline\/jobs\/[0-9a-f-]{36}$/i.test(pathname)) return pipelineJobDetail(pathname.split('/')[4]);
  if (pathname === '/newsroom/review') return reviewQueue();
  if (/^\/newsroom\/review\/[0-9a-f-]+$/i.test(pathname)) return reviewPackage(pathname.split('/')[3]);
  if (pathname === '/newsroom/on-deck') return onDeck();
  if (pathname === '/newsroom/new') return edit();
  if (/^\/newsroom\/[0-9a-f-]{36}$/i.test(pathname)) return edit(pathname.split('/')[2]);
  title('Not found');
  app.innerHTML = notFound();
}

chrome();
route().catch(() => {
  title('Temporarily unavailable');
  app.innerHTML = unavailable();
  document.querySelector('.retry-button')?.addEventListener('click', () => location.reload());
});
