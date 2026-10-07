import { createClient } from '@supabase/supabase-js';
import { BEAT_ORDER, EDITORIAL_CLASSIFICATION_HELP, SECTION_ORDER, SECTION_PROMISES } from './editorial.mjs';
import { PIPELINE_QUEUE_STATUSES, filterPipelineQueue, lineDiff, pipelineMetadata } from './newsroom-pipeline.mjs';
import { materializationState } from './pipeline/materialization.mjs';
import { ACTIVE_PIPELINE_JOB_STATUSES, PIPELINE_JOB_STATUSES, candidatePipelineAction, concisePipelineError, pipelineReviewHref, validateNewsroomJobRequest } from './newsroom-pipeline-controls.mjs';

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

/* ---------- Shared editorial helpers (same rules as the local application) ---------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
const humanize = s => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
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
const statuses = ['idea', 'researching', 'draft', 'review', 'fact_check', 'scheduled', 'published', 'archived'];
const sourceTypes = ['article', 'official_announcement', 'filing', 'research_paper', 'court_document', 'legislation', 'earnings_report', 'documentation', 'video', 'podcast', 'social_post', 'dataset', 'repository', 'other'];
const publicStorySelect = [
  'id', 'title', 'slug', 'dek', 'summary', 'body', 'section_id', 'status',
  'published_at', 'updated_at', 'reading_time_minutes', 'hero_media_id',
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
  const candidate = s.hero_media;
  const imageUrl = candidate ? mediaUrl(candidate.public_url) : '';
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

const sampleFiller = `## The middle of the story

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Integer feugiat scelerisque varius morbi enim nunc faucibus a pellentesque sit amet porttitor eget dolor. Curabitur blandit tempus porttitor, and the record stays open long enough for the reader to see how the page behaves.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed posuere consectetur est at lobortis. Aenean lacinia bibendum nulla sed consectetur, while every claim remains attached to the source that made it possible to check.

> “A sample pull quote gives the page a second voice and a place to breathe.”

---

- One finding gets its own line.
- Another finding creates rhythm.
- A third finding gives the eye somewhere to stop.

## What comes next

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Donec ullamcorper nulla non metus auctor fringilla. This is deliberately marked sample filler for evaluating the publication layout, not reported editorial content.

Lorem ipsum dolor sit amet, consectetur adipiscing elit. Maecenas faucibus mollis interdum. The archive stays open, the sources stay visible, and the reader gets a clear ending.`;
function presentationBody(s) {
  const body = String(s.body || '').trim();
  const isSample = /^sample-/i.test(String(s.slug || '')) || body.includes('clearly marked sample editorial content');
  return isSample && body.split(/\s+/).length < 120 ? `${body}\n\n${sampleFiller}` : body;
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
  const story = await dataOf(
    sb.from('stories').select(publicStorySelect).eq('slug', slug).eq('status', 'published').lte('published_at', new Date().toISOString()).maybeSingle(),
    'story'
  );
  if (!story) { title('Not found'); return app.innerHTML = notFound(); }
  const [s] = await hydrateMedia([story]);
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
  const beats = (s.story_beats || []).map(x => x.beats).filter(Boolean);
  const tags = (s.story_tags || []).map(x => x.tags).filter(Boolean);
  const filed = beats.map(x => `<a href="/topics/${esc(x.slug)}">${esc(x.name)}</a>`).join(' / ');
  /* The slug picks the composition, so a story always opens the same way. */
  const comps = ['comp-offset', 'comp-split', 'comp-poster', 'comp-margin'];
  const comp = comps[hash(s.slug) % comps.length];
  const head = `<div class="article-kicker"><a href="/sections/${esc(s.sections?.slug || '')}">${esc(s.sections?.name || '')}</a><span>Public record / ${dShort(s.published_at || s.updated_at)}</span></div>
      ${folio(nums.get(s.id), 'hero')}
      <h1>${esc(s.title)}</h1>
      <p class="standfirst">${esc(s.dek)}</p>`;
  const hero = knockoutWindow(s, nums.get(s.id), { className: 'article-window', label: 'Story window', eager: true });
  const opening =
    comp === 'comp-poster' ? `<div class="article-poster-window">${hero}</div><header class="article-head"><div class="head-pad">${head}</div></header>`
    : comp === 'comp-margin' ? `<div class="article-margin-opening"><header class="article-head">${head}</header><div class="article-margin-window">${hero}</div></div>`
    : comp === 'comp-split' ? `<div class="head-grid"><div class="article-hero">${hero}</div><header class="article-head">${head}</header></div>`
    : `<div class="head-grid"><header class="article-head">${head}</header><div class="article-hero">${hero}</div></div>`;
  app.innerHTML = `<article class="comp ${comp} a-${acc.get(s.id) || 'brick'}">
    ${opening}
    <div class="byline-block">
      ${s.profiles?.name ? `<span>By ${esc(s.profiles.name)}</span>` : ''}
      <span>${dLong(s.published_at || s.updated_at)}</span>
      <span>${s.reading_time_minutes} min read</span>
      ${filed ? `<span class="filed">Beats: ${filed}</span>` : ''}
      ${tags.length ? `<span class="filed">Tags: ${tags.map(x => esc(x.name)).join(' / ')}</span>` : ''}
    </div>
    <div class="article-body-shell">
      ${articleRail(s, sources, nums, all)}
      <div class="article-body prose">${composeBody(s, markdown(presentationBody(s)), nums)}<p class="article-end">Anyways / end of story</p></div>
    </div>
    ${sources.length ? `<aside class="sources">
      <span class="label">Sources</span>
      <p class="sources-note">Sources are part of the story.</p>
      <ol>${sources.map(x => `<li><a target="_blank" rel="noopener noreferrer" href="${esc(x.safe_url)}">${esc(x.title)}</a><span class="src-meta">${esc(x.publisher || '')} · ${esc(humanize(x.source_type))}${x.published_at ? ` · ${dShort(x.published_at)}` : ''}</span></li>`).join('')}</ol>
    </aside>` : ''}
    ${related.length ? `<section class="next-reads">
      <h2>Anyways…</h2>
      <p class="meta-line faint next-note">Here’s where we’d go next.</p>
      <div class="next-grid">${related.map((x, i) => entry(x, nums, { acc: acc.get(x.id), variant: i ? 'compact' : 'offset', window: i ? '' : 'square' })).join('')}</div>
    </section>` : ''}
  </article>`;
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
  const create = p?.role ? `<a class="desk-create" href="/newsroom/new" ${current === 'new' ? 'aria-current="page"' : ''}>New story →</a>` : '';
  return `<nav class="desk-nav" aria-label="Newsroom">
    <a href="/newsroom" ${current === 'overview' ? 'aria-current="page"' : ''}>Overview</a>
    <a href="/newsroom/review" ${current === 'review' ? 'aria-current="page"' : ''}>Review queue</a>
    ${['admin', 'editor'].includes(p?.role) ? `<a href="/newsroom/pipeline" ${current === 'pipeline' ? 'aria-current="page"' : ''}>Pipeline</a>` : ''}
    ${create}
    <span class="who">${esc(p?.name || '')} · ${esc(humanize(p?.role || ''))} · <button class="quiet compact-button" id="signout" type="button">Sign out</button></span>
  </nav>`;
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
    return n ? `<li><div class="toc-line"><span class="t"><span class="stamp st-${st}">${esc(humanize(st))}</span></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n}</span></div></li>` : '';
  }).join('');
  app.innerHTML = `<div class="desk">
    <div class="page-head">
      <div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div>
      <h1>${greeting}, ${esc((p?.name || '').split(' ')[0])}.</h1>
      <p class="standfirst">${p?.role === 'contributor' ? 'Your drafts, the board, and the way to review.' : 'The board, the queue, and everything in progress.'}</p>
    </div>
    ${deskNav(p, 'overview')}
    ${pipelineRows.length ? `<div class="desk-section"><span class="label">Ready for review</span><p class="field-note">${pipelineRows.filter(item => item.status === 'ready_for_review').length} pipeline package${pipelineRows.filter(item => item.status === 'ready_for_review').length === 1 ? '' : 's'} awaiting editorial judgment. <a class="text-link" href="/newsroom/review">Open queue</a></p></div>` : ''}
    <div class="desk-section"><span class="label">The board</span><ul class="toc desk-index">${board || '<li class="meta-line empty-row">No stories yet.</li>'}</ul></div>
    <div class="desk-section"><span class="label">Stories</span>${ss.length ? `<div class="table-scroll" role="region" aria-label="Newsroom stories" tabindex="0"><table class="desk-table">
      <thead><tr><th>Title</th><th>Status</th><th>Section</th><th>Updated</th></tr></thead>
      <tbody>${ss.map(s => `<tr><td class="title-cell"><a href="/newsroom/${s.id}">${esc(s.title || 'Untitled story')}</a></td><td><span class="stamp st-${s.status}">${esc(humanize(s.status))}</span></td><td class="mono">${esc(s.sections?.name || '')}</td><td class="mono">${dShort(s.updated_at)}</td></tr>`).join('')}</tbody>
    </table></div>` : emptyNote('No stories yet. Start a draft when the next idea is ready.')}</div>
  </div>`;
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
function jobTarget(job) { return job.parameters?.candidate_id || job.parameters?.run_id || 'All enabled sources'; }
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
  title('Pipeline'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline</span></div><h1>Pipeline control</h1><p class="standfirst">Queue work for the local controller. Review and publishing remain separate editorial decisions.</p></div>${deskNav(p, 'pipeline')}<section class="desk-section"><div class="pipeline-status-grid"><div><span class="label">Controller</span><p class="meta-line">Controller status unavailable</p><p class="field-note">The Newsroom reads durable queue activity only. It does not contact the Mac Studio.</p></div><div><span class="label">Queue</span><p class="meta-line">${counts.queued} queued · ${counts.running} running · ${counts.failed} failed · ${counts.completed} completed</p><p class="field-note">${active.length ? `${active.length} active job${active.length === 1 ? '' : 's'} in the controller queue.` : 'No active jobs.'}</p></div><div><span class="label">Latest work</span><p class="field-note">Discovery: ${latestDiscovery ? `<a href="${jobHref(latestDiscovery)}">${dShort(latestDiscovery.finished_at || latestDiscovery.created_at)}</a>` : 'None recorded'}</p><p class="field-note">Candidate processing: ${latestProcess ? `<a href="${jobHref(latestProcess)}">${dShort(latestProcess.finished_at || latestProcess.created_at)}</a>` : 'None recorded'}</p></div></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Running now</span><h2>${active.map(jobTarget).join(' · ') || 'No active job'}</h2></div></div><p class="field-note">Running and claimed jobs cannot be moved.</p></section><section class="desk-section"><div class="section-head"><div><span class="label">Next up</span><h2>Queued work</h2></div></div><div class="table-scroll"><table class="desk-table"><thead><tr><th>Order</th><th>Job</th><th>Target</th><th>Type</th><th>Priority</th><th>Created</th><th>Requester</th><th>Controls</th></tr></thead><tbody>${queued.map(queueRow).join('') || '<tr><td colspan="8" class="empty-row">No queued jobs.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Discovery</span><h2>Run enabled sources</h2></div></div><form id="discovery-job" class="queue-filters"><label>Priority<select name="priority"><option value="50">Normal</option><option value="75">High</option><option value="25">Low</option></select></label><button type="submit">Run discovery</button><p class="notice form-message" data-form-message hidden></p></form></section><section class="desk-section"><div class="section-head"><div><span class="label">Candidates</span><h2>Retained pipeline candidates</h2></div></div><div class="table-scroll" role="region" aria-label="Pipeline candidates" tabindex="0"><table class="desk-table"><thead><tr><th>Candidate</th><th>Status</th><th>Updated</th><th>Action</th></tr></thead><tbody>${candidates.map(candidate => { const action = candidatePipelineAction(candidate, jobs, linkByCandidate.get(candidate.id)); const button = action?.type === 'process' ? `<button class="quiet compact-button" type="button" data-process-candidate="${esc(action.candidate_id)}">${esc(action.label)}</button>` : action ? `<a class="text-link" href="${esc(action.href)}">${esc(action.label)}</a>` : '—'; return `<tr><td class="title-cell">${candidate.canonical_url ? sourceHref(candidate.canonical_url, candidate.title || 'Untitled candidate') : esc(candidate.title || 'Untitled candidate')}</td><td><span class="stamp st-${esc(candidate.status)}">${esc(humanize(candidate.status))}</span></td><td class="mono">${dShort(candidate.updated_at)}</td><td>${button}</td></tr>`; }).join('') || '<tr><td colspan="4" class="empty-row">Run discovery to retain candidates for processing.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Recent jobs</span><h2>Queue history</h2></div></div><form id="job-filters" class="queue-filters"><label>Status<select name="status">${statusOptions(PIPELINE_JOB_STATUSES, statusFilter)}</select></label><label>Type<select name="type">${statusOptions(['discover', 'process_candidate', 'retry_run', 'sync_candidate', 'health_check'], typeFilter)}</select></label><label>Source<select name="source">${statusOptions([...new Set(jobs.map(job => job.source))].filter(Boolean).sort(), sourceFilter)}</select></label><button class="quiet" type="submit">Filter</button></form><div class="table-scroll" role="region" aria-label="Pipeline jobs" tabindex="0"><table class="desk-table pipeline-jobs"><thead><tr><th>Job</th><th>Type</th><th>Requester</th><th>Target</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Result</th></tr></thead><tbody>${visible.map(job => `<tr><td class="mono"><a href="${jobHref(job)}">${esc(job.id.slice(0, 8))}</a></td><td>${esc(humanize(job.job_type))}</td><td>${esc(job.profiles?.name || 'System')}</td><td>${esc(jobTarget(job))}</td><td><span class="stamp st-${esc(job.status)}">${esc(humanize(job.status))}</span></td><td>${job.attempt_count}/${job.max_attempts}</td><td>${esc(pipelineDuration(job))}</td><td>${esc(jobResult(job))}</td></tr>`).join('') || '<tr><td colspan="8" class="empty-row">No jobs match these filters.</td></tr>'}</tbody></table></div></section><section class="desk-section"><div class="section-head"><div><span class="label">Sources</span><h2>Enabled discovery sources</h2></div></div><div class="table-scroll" role="region" aria-label="Discovery sources" tabindex="0"><table class="desk-table"><thead><tr><th>Source</th><th>Type</th><th>Domain</th><th>Section / beats</th><th>Last check</th></tr></thead><tbody>${sources.filter(source => source.enabled).map(source => { let domain = source.locator; try { domain = new URL(source.locator).hostname; } catch {} return `<tr><td>${esc(source.name)}</td><td>${esc(humanize(source.source_type))}</td><td>${esc(domain)}</td><td>${esc([source.default_section, ...(source.default_beats || [])].filter(Boolean).join(' · '))}</td><td class="mono">${source.last_checked_at ? dShort(source.last_checked_at) : 'Not yet recorded'}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty-row">Source snapshot will appear after the next controller discovery.</td></tr>'}</tbody></table></div></section></div>`;
  const submit = async (form, payload) => { showFormMessage(form, ''); setBusy(form, true, 'Submitting…'); try { const result = await pipelineRequest('/api/newsroom/pipeline/jobs', payload); if (result.duplicate) { showFormMessage(form, 'An active matching job already exists. Opening it now.', 'ok'); setTimeout(() => location.href = jobHref(result.job), 450); } else location.href = jobHref(result.job); } catch (error) { setBusy(form, false); showFormMessage(form, error.message); } };
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
  const candidateId = job.parameters?.candidate_id; const candidate = candidateId ? await optionalData(sb.from('candidate_stories').select('id,external_id,title,status').eq('external_id', candidateId).limit(1), 'related pipeline candidate') : []; const related = candidate[0]; const cancellable = ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status) && !job.cancellation_requested_at; const retryable = job.status === 'failed' && ['discover', 'process_candidate'].includes(job.job_type); const events = (job.pipeline_job_events || []).slice().sort((a, b) => new Date(a.at) - new Date(b.at)); const review = pipelineReviewHref(related || {});
  title('Pipeline job'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline job</span></div><h1>${esc(humanize(job.job_type))}</h1><p class="standfirst">${esc(job.id)}</p></div>${deskNav(p, 'pipeline')}<p class="notice form-message" id="job-message" hidden></p><section class="desk-section"><div class="pipeline-status-grid"><div><span class="label">Status</span><p><span class="stamp st-${esc(job.status)}">${esc(humanize(job.status))}</span></p><p class="field-note">${job.cancellation_requested_at ? 'Cancellation requested.' : 'No cancellation requested.'}</p></div><div><span class="label">Execution</span><p class="field-note">Attempts ${job.attempt_count}/${job.max_attempts} · ${esc(pipelineDuration(job))}</p><p class="field-note">Started ${job.started_at ? esc(dLong(job.started_at)) : 'Not claimed yet'}</p></div><div><span class="label">Requester</span><p class="field-note">${esc(job.profiles?.name || 'System')} · ${esc(humanize(job.source))}</p><p class="field-note">Priority ${job.priority}</p></div></div><div class="form-actions">${cancellable ? '<button id="cancel-job" type="button" class="quiet">Cancel job</button>' : ''}${retryable ? '<button id="retry-job" type="button">Retry job</button>' : ''}${related ? `<a class="text-link" href="/newsroom/pipeline">Open candidate</a>` : ''}${review ? `<a class="text-link" href="${esc(review)}">Open review</a>` : ''}</div></section><section class="desk-section"><span class="label">Parameters</span><pre class="packet-data">${esc(JSON.stringify(job.parameters || {}, null, 2))}</pre><p class="field-note">Lease: ${esc(job.lease_owner ? 'Active controller lease' : 'No active lease')} ${job.lease_expires_at ? `until ${dLong(job.lease_expires_at)}` : ''}</p>${job.error ? `<h3>Error</h3><pre class="packet-data">${esc(JSON.stringify(job.error, null, 2))}</pre>` : ''}${job.result ? `<h3>Result</h3><pre class="packet-data">${esc(JSON.stringify(job.result, null, 2))}</pre>` : ''}</section><section class="desk-section"><span class="label">Timeline</span>${events.map(event => `<div class="revision-line"><span>${esc(dShort(event.at))}</span><span class="stamp st-${esc(event.level)}">${esc(humanize(event.event_type))}</span><span>${esc(event.message)}</span></div>`).join('') || '<p class="field-note">No event history retained.</p>'}</section><details class="editor-section"><summary>Concise controller log</summary><pre class="packet-data">${esc(safeLog(job.summary_log) || 'No summary log retained.')}</pre></details></div>`;
  const message = document.querySelector('#job-message'); const action = async (suffix, success) => { try { await pipelineRequest(`/api/newsroom/pipeline/jobs/${job.id}/${suffix}`); message.textContent = success; message.className = 'notice form-message ok'; message.hidden = false; setTimeout(() => location.reload(), 650); } catch (error) { message.textContent = error.message; message.className = 'notice form-message'; message.hidden = false; } };
  document.querySelector('#cancel-job')?.addEventListener('click', () => action('cancel', 'Cancellation requested.'));
  document.querySelector('#retry-job')?.addEventListener('click', () => action('retry', 'Replacement job submitted.'));
  bindSignOut(); if (ACTIVE_PIPELINE_JOB_STATUSES.includes(job.status)) setTimeout(() => location.reload(), 8000);
}
function sourceHref(url, label) { const safe = externalUrl(url); return safe ? `<a href="${esc(safe)}" target="_blank" rel="noreferrer">${esc(label || safe)}</a>` : esc(label || 'Unavailable source'); }
function queueFilters(items) { const collect = key => [...new Set(items.flatMap(item => { const value = pipelineMetadata(item)[key]; return Array.isArray(value) ? value : [value]; }).filter(Boolean))].sort(); const options = (values, selected) => `<option value="">All</option>${values.map(value => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(humanize(value))}</option>`).join('')}`; const qs = new URLSearchParams(location.search); return { qs, html: `<form class="queue-filters" id="pipeline-filters"><label>Section<select name="section">${options(collect('section'), qs.get('section'))}</select></label><label>Beat<select name="beat">${options(collect('beats'), qs.get('beat'))}</select></label><label>Tag<select name="tag">${options(collect('tags'), qs.get('tag'))}</select></label><label>Status<select name="status">${options(PIPELINE_QUEUE_STATUSES, qs.get('status'))}</select></label><button class="quiet" type="submit">Filter</button></form>` }; }
async function reviewQueue() {
  const p = await profile(); if (!p) return location.href = '/newsroom';
  const candidates = await optionalData(sb.from('candidate_stories').select('id,external_id,title,status,classification,created_at,updated_at').in('status', PIPELINE_QUEUE_STATUSES).order('updated_at', { ascending: false }), 'pipeline review queue');
  const ids = candidates.map(item => item.id);
  const [drafts, documents, claims, images] = await Promise.all([
    ids.length ? optionalData(sb.from('pipeline_drafts').select('candidate_id').in('candidate_id', ids), 'pipeline drafts') : [],
    ids.length ? optionalData(sb.from('discovered_documents').select('candidate_id').in('candidate_id', ids), 'pipeline documents') : [],
    ids.length ? optionalData(sb.from('pipeline_claims').select('draft_id,status,pipeline_drafts!inner(candidate_id)').in('pipeline_drafts.candidate_id', ids), 'pipeline claims') : [],
    ids.length ? optionalData(sb.from('image_candidates').select('candidate_id,rights_status,warning_flags').in('candidate_id', ids), 'pipeline images') : []
  ]);
  const counts = new Map(ids.map(id => [id, { source_count: 0, unresolved_claim_count: 0, rights_warning_count: 0 }])); documents.forEach(row => counts.get(row.candidate_id).source_count++); claims.filter(row => row.status !== 'supported').forEach(row => counts.get(row.pipeline_drafts?.candidate_id).unresolved_claim_count++); images.filter(row => row.rights_status !== 'verified_reusable' && row.rights_status !== 'official_press_asset').forEach(row => counts.get(row.candidate_id).rights_warning_count++);
  const items = candidates.map(item => ({ ...item, ...counts.get(item.id) })); const filters = queueFilters(items); const visible = filterPipelineQueue(items, Object.fromEntries(filters.qs));
  title('Review queue'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Review queue</span></div><h1>Ready for review</h1><p class="standfirst">Pipeline packages sit beside ordinary newsroom work. Approval records an editorial decision only; it never publishes.</p></div>${deskNav(p, 'review')}${filters.html}<div class="desk-section"><div class="table-scroll"><table class="desk-table queue-table"><thead><tr><th>Headline</th><th>Status</th><th>Section</th><th>Beats / tags</th><th>Sources</th><th>Claims</th><th>Images</th><th>Created</th></tr></thead><tbody>${visible.map(item => { const meta = pipelineMetadata(item); return `<tr><td class="title-cell"><a href="/newsroom/review/${esc(item.external_id || item.id)}">${esc(item.title || 'Untitled')}</a></td><td><span class="stamp st-${esc(meta.status)}">${esc(humanize(meta.status))}</span></td><td class="mono">${esc(humanize(meta.section))}</td><td class="mono">${esc([...meta.beats, ...meta.tags].join(' · '))}</td><td>${meta.sourceCount}</td><td>${meta.unresolvedClaims ? `<span class="warning-count">${meta.unresolvedClaims} unresolved</span>` : 'Resolved'}</td><td>${meta.rightsWarnings ? `<span class="warning-count">${meta.rightsWarnings} warning</span>` : 'Clear'}</td><td class="mono">${dShort(meta.createdAt)}</td></tr>`; }).join('') || '<tr><td colspan="8" class="empty-row">No pipeline candidates match these filters.</td></tr>'}</tbody></table></div></div></div>`; document.querySelector('#pipeline-filters').onsubmit = event => { event.preventDefault(); const qs = new URLSearchParams(new FormData(event.currentTarget)); location.href = `/newsroom/review?${qs}`; }; bindSignOut();
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
  const sourceDetail = doc => { let domain = ''; try { domain = new URL(doc.canonical_url || doc.url).hostname; } catch {} const retention = doc.retention?.reason || 'retained for this candidate'; const publisher = doc.pipeline_sources?.name || domain || 'Unknown publisher'; const type = doc.pipeline_sources?.source_type || 'document'; const usage = usedDocumentIds.has(doc.id) ? 'used in final draft' : 'retained, not cited in final draft'; return `<div class="source-row"><div class="src-title">${sourceHref(doc.canonical_url || doc.url, doc.title || 'Source')}<span class="src-meta">${esc([publisher, type, retention, usage, doc.extraction_status || ''].filter(Boolean).join(' · '))}</span></div></div>`; };
  title('Review package'); app.innerHTML = `<div class="desk"><div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>Pipeline review</span></div><h1>${esc(current.headline || candidate.title || 'Untitled')}</h1><p class="standfirst">${esc(current.dek || '')}</p></div>${deskNav(p, 'review')}<form id="pipeline-review" class="desk-form"><p class="notice form-message" data-form-message hidden></p><div class="editor-grid"><div><section class="editor-section"><h2>Article</h2><label>Headline<input name="headline" value="${esc(current.headline || candidate.title || '')}" required></label><label>Dek<textarea name="dek" class="textarea-short" required>${esc(current.dek || '')}</textarea></label><label>Body (Markdown)<textarea name="body_markdown" required>${esc(current.body_markdown || '')}</textarea></label><label>Primary section<input name="primary_section" value="${esc(meta.section)}" required></label><label>Recurring beats<input name="beats" value="${esc(meta.beats.join(', '))}"></label><label>Tags<input name="tags" value="${esc(meta.tags.join(', '))}"></label><div class="form-actions"><button type="submit">Save editorial changes</button></div></section><details class="editor-section" open><summary>Sources and claim ledger</summary>${activeDocuments.map(sourceDetail).join('') || '<p class="field-note">No sources retained.</p>'}${claims.map(claim => `<div class="claim-row"><strong>${esc(claim.claim)}</strong><span class="stamp st-${esc(claim.status)}">${esc(humanize(claim.status))}</span><p>${esc(claim.note || '')}</p><p class="field-note">${(claim.pipeline_claim_sources || []).map(link => sourceHref(link.discovered_documents?.url, link.discovered_documents?.title)).join(' · ') || 'No source mapping'}</p></div>`).join('')}</details><details class="editor-section"><summary>Version diff</summary>${earlier ? `${earlier.headline !== current.headline ? `<pre class="version-diff">- Headline: ${esc(earlier.headline || '')}\n+ Headline: ${esc(current.headline || '')}</pre>` : ''}${earlier.dek !== current.dek ? `<pre class="version-diff">- Dek: ${esc(earlier.dek || '')}\n+ Dek: ${esc(current.dek || '')}</pre>` : ''}${bodyDiff.length ? `<pre class="version-diff">${bodyDiff.map(row => `${row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '} ${esc(row.text)}`).join('\n')}</pre>` : ''}${earlier.headline === current.headline && earlier.dek === current.dek && !bodyDiff.length ? '<p class="field-note">No content changes in this version.</p>' : ''}` : '<p class="field-note">No earlier draft is retained.</p>'}</details></div><div><section class="editor-section"><h2>Review</h2><p class="meta-line">Status: <span class="stamp st-${esc(candidate.status)}">${esc(humanize(candidate.status))}</span></p><p class="field-note">Publishing is unavailable here. Approval does not publish.</p><label>Revision instructions<textarea name="revision_notes" class="textarea-short" placeholder="Required when requesting revision."></textarea></label><div class="buttons review-actions"><button name="action" value="approve" type="button">Approve</button><button name="action" value="reject" type="button" class="danger-quiet">Reject</button><button name="action" value="revision" type="button" class="quiet">Request revision</button><button name="action" value="archive" type="button" class="quiet">Archive</button></div></section><details class="editor-section" open><summary>Research and validation</summary><pre class="packet-data">${esc(JSON.stringify(packetRows[0]?.packet || {}, null, 2))}</pre><h3>Image candidates</h3>${activeImages.map(image => `<div class="claim-row">${sourceHref(image.original_url, image.caption || 'Image candidate')}<p><span class="stamp st-${esc(image.rights_status)}">${esc(humanize(image.rights_status))}</span> ${esc((image.warning_flags || []).join(', '))}</p></div>`).join('') || '<p class="field-note">No image candidates.</p>'}</details><details class="editor-section"><summary>Audit trail</summary>${decisions.map(decision => `<div class="revision-line"><span>${esc(humanize(decision.action))}</span><span>${esc(decision.profiles?.name || 'Editor')}</span><span>${dShort(decision.created_at)}</span><span>${esc(decision.note || '')}</span></div>`).join('') || '<p class="field-note">No review actions yet.</p>'}</details></div></div></form></div>`;
  const form = document.querySelector('#pipeline-review'); form.onsubmit = async event => { event.preventDefault(); const values = Object.fromEntries(new FormData(form)); const version = (current.version || 0) + 1; const { error } = await sb.from('pipeline_drafts').insert({ candidate_id: databaseCandidateId, pipeline_run_id: current.pipeline_run_id, version, headline: values.headline, dek: values.dek, body_markdown: values.body_markdown, prior_draft_id: current.id || null }); if (error) return showFormMessage(form, error.message); await sb.from('candidate_stories').update({ title: values.headline, classification: { ...(candidate.classification || {}), primary_section: values.primary_section, recurring_beats: values.beats.split(',').map(x => x.trim()).filter(Boolean), tags: values.tags.split(',').map(x => x.trim()).filter(Boolean) } }).eq('id', databaseCandidateId); await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: 'edit', note: 'Editorial metadata or article updated.' }); location.reload(); };
  document.querySelectorAll('[data-action]').forEach(() => {}); document.querySelectorAll('.review-actions button').forEach(button => button.onclick = async () => { const action = button.value; const notes = form.revision_notes.value.trim(); if (action === 'revision' && !notes) return showFormMessage(form, 'Revision instructions are required.'); const next = { approve: 'approved', reject: 'rejected_by_editor', revision: 'revision_requested', archive: 'archived' }[action]; const { error } = await sb.from('candidate_stories').update({ status: next }).eq('id', databaseCandidateId); if (error) return showFormMessage(form, error.message); await sb.from('pipeline_review_decisions').insert({ candidate_id: databaseCandidateId, actor_id: p.id, action: action === 'revision' ? 'request_revision' : action, note: notes || null }); location.href = '/newsroom/review'; }); bindSignOut();
  const reviewActions = document.querySelector('.review-actions');
  if (reviewActions) {
    const materialize = document.createElement('div');
    materialize.className = 'form-actions';
    if (materialization.action === 'open') {
      materialize.innerHTML = `<a class="text-link" href="/newsroom/${esc(materialization.storyId)}">Open Editorial Draft</a><p class="field-note">Created from pipeline draft ${esc(linkRows[0]?.source_draft_version || '')}.</p>`;
    } else if (materialization.eligible) {
      materialize.innerHTML = '<button id="materialize-pipeline" type="button">Create Editorial Draft</button><p class="field-note">Creates an unpublished editorial draft. It does not publish, and unverified pipeline images are not attached.</p>';
    }
    if (materialize.childElementCount) reviewActions.before(materialize);
  }
  const materializeButton = document.querySelector('#materialize-pipeline');
  if (materializeButton) materializeButton.onclick = async () => {
    if (materializeButton.dataset.confirmed !== 'true') {
      materializeButton.dataset.confirmed = 'true';
      materializeButton.textContent = 'Confirm Create Editorial Draft';
      const confirmation = document.createElement('p');
      confirmation.className = 'field-note';
      confirmation.id = 'materialize-confirmation';
      confirmation.textContent = 'Confirming creates one unpublished editorial draft. It does not publish the story.';
      materializeButton.after(confirmation);
      return;
    }
    materializeButton.disabled = true;
    materializeButton.textContent = 'Creating editorial draft…';
    const { data, error } = await sb.rpc('materialize_pipeline_story', { p_candidate_id: databaseCandidateId });
    const result = Array.isArray(data) ? data[0] : data;
    if (error || !result?.story_id) {
      materializeButton.disabled = false;
      materializeButton.textContent = 'Create Editorial Draft';
      showFormMessage(form, error?.message || 'The editorial draft could not be created. No pipeline state was changed; retry safely.');
      return;
    }
    location.href = `/newsroom/${result.story_id}`;
  };
}

/* ---------- Story editor ---------- */

async function edit(id) {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  const [sections, beats, editors, record, sourceRows] = await Promise.all([
    dataOf(sb.from('sections').select('id,name,slug').order('name'), 'editor sections'),
    dataOf(sb.from('beats').select('id,name,slug').order('name'), 'editor beats'),
    dataOf(sb.from('profiles').select('id,name,role').in('role', ['admin', 'editor']).order('name'), 'responsible editors'),
    id
      ? dataOf(
        sb.from('stories').select('id,title,slug,dek,summary,body,section_id,author_id,editor_id,status,published_at,scheduled_for,seo_title,seo_description,revision_number,story_beats(beat_id),story_tags(tags(name))').eq('id', id).maybeSingle(),
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
      : Promise.resolve([])
  ]);
  const s = record;
  if (!s) { title('Not found'); return app.innerHTML = notFound(); }
  const chosen = new Set(s.story_beats?.map(x => x.beat_id));
  const existingTags = (s.story_tags || []).map(x => x.tags?.name).filter(Boolean).join(', ');
  const safeSources = (sourceRows || []).map(source => ({ ...source, safe_url: externalUrl(source.url) }));
  const validSourceCount = safeSources.filter(source => source.safe_url).length;
  const editorStatuses = statuses.filter(status => status !== 'scheduled');
  if (s.status === 'scheduled') editorStatuses.splice(editorStatuses.indexOf('published'), 0, 'scheduled');
  const availableStatuses = p.role === 'contributor'
    ? ['idea', 'researching', 'draft', 'review']
    : editorStatuses;
  const assignedEditor = (editors || []).find(editor => editor.id === s.editor_id);
  title(`${id ? 'Edit' : 'New'} story`);
  app.innerHTML = `<div class="desk">
  <div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${id ? `Editing · ${esc(s.slug)}` : 'New story'}</span></div><h1>${id ? 'Edit story' : 'New story'}</h1></div>
  ${deskNav(p, id ? '' : 'new')}
  <form id="story" class="desk-form">
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
        <details class="preview"><summary>Preview markdown</summary><div id="markdown-preview" class="markdown-preview">${markdown(s.body || '')}</div></details>
      </section>
    </div>
    <div>
      <section class="editor-section">
        <h2>Editorial</h2>
        <p class="meta-line">Current status: <span class="stamp st-${s.status || 'idea'}">${esc(humanize(s.status || 'idea'))}</span></p>
        <label for="story-status">Status</label><select id="story-status" name="status">${availableStatuses.map(status => `<option value="${status}" ${status === s.status ? 'selected' : ''}>${esc(humanize(status))}</option>`).join('')}</select>
        ${p.role === 'contributor'
          ? `<p class="field-note">Responsible editor: ${esc(assignedEditor?.name || 'Unassigned. An editor will claim the story during review.')}</p>`
          : `<label for="story-editor">Responsible editor</label><select id="story-editor" name="editor_id"><option value="">Unassigned</option>${(editors || []).map(editor => `<option value="${editor.id}" ${editor.id === s.editor_id ? 'selected' : ''}>${esc(editor.name)} · ${esc(humanize(editor.role))}</option>`).join('')}</select>`}
        <p class="field-note">Publishing requires a responsible editor, one primary section, complete metadata, and a valid source. Beats are optional subjects, not sections.</p>
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
    <span class="meta-line">${id ? `Revision ${Number(s.revision_number || 1)} · ${esc(humanize(s.status))}.` : 'Create the draft, then add its source on the saved story.'}</span>
    <div class="buttons"><button type="submit">Save story</button></div>
  </div>
  </form>
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
  const bodyInput = document.getElementById('story-body'), preview = document.getElementById('markdown-preview');
  const titleInput = document.getElementById('story-title'), slugInput = document.getElementById('story-slug');
  const sectionSelect = document.getElementById('story-section'), sectionQuestion = document.getElementById('section-question');
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
  if (bodyInput && preview) bodyInput.addEventListener('input', () => { preview.innerHTML = markdown(bodyInput.value); });
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

  storyForm.onsubmit = async e => {
    e.preventDefault();
    const form = e.currentTarget;
    showFormMessage(form, '');
    const f = new FormData(form), beatIds = f.getAll('beat').map(String), tags = String(f.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean), payload = Object.fromEntries(f);
    const nextStatus = String(payload.status || 'idea');
    if (!availableStatuses.includes(nextStatus)) {
      showFormMessage(form, 'That workflow change is not available for this account.');
      return;
    }
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
    if (nextStatus === 'published') payload.published_at = s.published_at || new Date().toISOString();
    else if (s.published_at) payload.published_at = s.published_at;
    delete payload.beat;
    delete payload.tags;
    if (nextStatus === 'published' && (!validSourceCount || !payload.editor_id)) {
      showFormMessage(form, 'Before publishing, assign an editor, choose a primary section, and add a valid source.');
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
    location.href = '/newsroom/' + saved.id;
  };

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
  if (pathname === '/newsroom/pipeline') return pipelineControls();
  if (/^\/newsroom\/pipeline\/jobs\/[0-9a-f-]{36}$/i.test(pathname)) return pipelineJobDetail(pathname.split('/')[4]);
  if (pathname === '/newsroom/review') return reviewQueue();
  if (/^\/newsroom\/review\/[0-9a-f-]+$/i.test(pathname)) return reviewPackage(pathname.split('/')[3]);
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
