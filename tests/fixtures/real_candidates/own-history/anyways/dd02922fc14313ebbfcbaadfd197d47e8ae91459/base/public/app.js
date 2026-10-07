import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/* Anyways · public edition view layer.
   Public presentation is intentionally isolated from the newsroom. Data access,
   authentication, workflow, and routing behavior stay unchanged. */

const sb = createClient(window.ANYWAYS_CONFIG.supabaseUrl, window.ANYWAYS_CONFIG.supabaseAnonKey);
const app = document.querySelector('#app');
const isPublicRoute = !location.pathname.startsWith('/newsroom');
document.body.classList.add(isPublicRoute ? 'public-site' : 'newsroom-site');

/* ---------- Shared editorial helpers (same rules as the local application) ---------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));

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
const promises = {
  'anyways': 'The answer on consequential news, with the stakes up front.',
  'worth-your-time': 'Work that earns your attention, recommended only after firsthand evaluation.',
  'we-read-it': 'Dense primary material, turned into understanding.',
  'receipts': 'The record, kept. Public words against later conduct.',
  'meanwhile': 'Honest internet delight, with dignity intact.',
  'research': 'Original knowledge through transparent methods.'
};
const sectionOrder = ['anyways', 'worth-your-time', 'we-read-it', 'receipts', 'meanwhile', 'research'];
const statuses = ['idea', 'researching', 'draft', 'review', 'fact_check', 'scheduled', 'published', 'archived'];

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
  const media = s.hero_media;
  const className = opts.className ? ` ${opts.className}` : '';
  const label = esc(opts.label || s.sections?.name || 'Anyways');
  const caption = media && (media.caption || media.credit)
    ? `<figcaption><span>${esc(media.caption || media.alt_text || '')}</span>${media.credit ? `<span>${esc(media.credit)}</span>` : ''}</figcaption>`
    : '';
  const content = media
    ? `<img src="${esc(media.public_url)}" alt="${esc(media.alt_text || '')}" loading="${opts.eager ? 'eager' : 'lazy'}">`
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
  const ts = (s.story_topics || []).map(x => x.topics).filter(Boolean);
  if (ts.length) notes.push(`<div><span class="rail-label">Filed under</span><p>${ts.map(t => `<a href="/topics/${esc(t.slug)}">${esc(t.name)}</a>`).join(' / ')}</p></div>`);
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

async function session() { return (await sb.auth.getUser()).data.user; }
async function profile() { const u = await session(); return u ? (await sb.from('profiles').select('*').eq('id', u.id).single()).data : null; }
async function hydrateMedia(stories) {
  const ids = [...new Set(stories.map(s => s.hero_media_id).filter(Boolean))];
  if (!ids.length) return stories;
  try {
    const { data = [] } = await sb.from('media').select('id,public_url,alt_text,caption,credit').in('id', ids);
    const byId = new Map(data.map(m => [m.id, m]));
    return stories.map(s => ({ ...s, hero_media: byId.get(s.hero_media_id) || null }));
  } catch {
    return stories;
  }
}

let publishedCatalogPromise;
async function publishedCatalog() {
  if (!publishedCatalogPromise) {
    publishedCatalogPromise = (async () => {
      const { data = [] } = await sb.from('stories')
        .select('*,sections(name,slug),story_topics(topics(name,slug)),profiles!stories_author_id_fkey(name,slug)')
        .eq('status', 'published')
        .lte('published_at', new Date().toISOString())
        .order('published_at', { ascending: false });
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
  const { data = [] } = await sb.from('sections').select('*');
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
      nav.insertAdjacentHTML('afterbegin', sections.map(s => `<a href="/sections/${esc(s.slug)}" ${current === s.slug ? 'aria-current="page"' : ''}>${esc(s.name)}</a>`).join(''));
    }
    const colophonSections = document.querySelector('#colophon-sections');
    if (colophonSections) colophonSections.innerHTML = sections.map(s => `<li><a href="/sections/${esc(s.slug)}">${esc(s.name)}</a></li>`).join('');
  } catch { /* navigation degrades to the desk links */ }
  const deskCurrent = location.pathname === '/topics' || location.pathname.startsWith('/topics/') ? 'topics'
    : location.pathname === '/search' ? 'search'
    : location.pathname.startsWith('/newsroom') ? 'newsroom' : null;
  if (deskCurrent) document.querySelector(`#index-nav [data-current="${deskCurrent}"]`)?.setAttribute('aria-current', 'page');
  try {
    const { count } = await sb.from('stories').select('id', { count: 'exact', head: true }).eq('status', 'published').lte('published_at', new Date().toISOString());
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
const notFound = () => `<div class="not-found"><div class="endmark" aria-hidden="true">…</div><h1>This page is not in the edition.</h1><p class="meta-line"><a href="/" style="color:var(--green);text-decoration:underline">Return to the front page</a></p></div>`;

function title(t) { document.title = t ? `${t} | Anyways` : 'Anyways'; }

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
  const sectionRows = sections.map((sec, sectionIndex) => {
    const xs = stories.filter(s => s.section_id === sec.id && !featured.has(s.id)).slice(0, 4);
    xs.forEach(s => featured.add(s.id));
    if (!xs.length) return '';
    const mode = modes[sectionIndex % modes.length];
    const variants = mode === 'ledger' ? ['ledger', 'ledger', 'ledger', 'ledger']
      : mode === 'split' ? ['poster', 'compact', 'compact', 'strip']
      : ['tall', 'offset', 'compact', 'strip'];
    return `<section class="section-module section-module--${mode} a-${acc.get(xs[0].id)}">
      <header class="section-module-head">
        <span class="section-count">${String(sectionIndex + 1).padStart(2, '0')} / ${String(sections.length).padStart(2, '0')}</span>
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
      <div class="desk-links"><a class="all-link" href="/topics">Browse topics</a><a class="all-link" href="/search">Search the archive</a></div>
    </section>`;
}

/* ---------- Story: one of four reusable compositions ---------- */

async function showStory(slug) {
  const { data: story } = await sb.from('stories').select('*,sections(name,slug),story_topics(topics(name,slug)),profiles!stories_author_id_fkey(name,slug)').eq('slug', slug).single();
  if (!story) { title('Not found'); return app.innerHTML = notFound(); }
  const [s] = await hydrateMedia([story]);
  const { data: sources = [] } = await sb.from('sources').select('*').eq('story_id', s.id).order('sort_order');
  const all = await published();
  const nums = numerals(all), acc = accents(all);
  let related = [];
  try {
    const { data: links = [] } = await sb.from('story_related').select('related_story_id').eq('story_id', s.id);
    const ids = links.map(x => x.related_story_id);
    if (ids.length) {
      const data = (await sb.from('stories').select('*,sections(name,slug),profiles!stories_author_id_fkey(name,slug)').in('id', ids).eq('status', 'published').order('published_at', { ascending: false })).data || [];
      related = await hydrateMedia(data);
    }
  } catch { /* next reads are optional */ }
  title(s.seo_title || s.title);
  const filed = (s.story_topics || []).map(x => `<a href="/topics/${esc(x.topics.slug)}">${esc(x.topics.name)}</a>`).join(' / ');
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
      ${filed ? `<span class="filed">Filed under ${filed}</span>` : ''}
    </div>
    <div class="article-body-shell">
      ${articleRail(s, sources, nums, all)}
      <div class="article-body prose">${composeBody(s, markdown(presentationBody(s)), nums)}<p class="article-end">Anyways / end of story</p></div>
    </div>
    ${sources.length ? `<aside class="sources">
      <span class="label">Sources</span>
      <p class="sources-note">Sources are part of the story.</p>
      <ol>${sources.map(x => `<li><a target="_blank" rel="noopener" href="${esc(x.url)}">${esc(x.title)}</a><span class="src-meta">${esc(x.publisher || '')} · ${esc(String(x.source_type).replace(/_/g, ' '))}${x.published_at ? ` · ${dShort(x.published_at)}` : ''}</span></li>`).join('')}</ol>
    </aside>` : ''}
    <section class="next-reads">
      <h2>Anyways…</h2>
      <p class="meta-line faint" style="margin-bottom:0.6rem">Here’s where we’d go next.</p>
      ${related.length ? `<div class="next-grid">${related.map((x, i) => entry(x, nums, { acc: acc.get(x.id), variant: i ? 'compact' : 'offset', window: i ? '' : 'square' })).join('')}</div>` : ''}
    </section>
  </article>`;
}

/* ---------- Sections: the promise ---------- */

async function section(slug) {
  const { data: sec } = await sb.from('sections').select('*').eq('slug', slug).single();
  if (!sec) { title('Not found'); return app.innerHTML = notFound(); }
  const topicFilter = new URLSearchParams(location.search).get('topic') || '';
  const catalog = await published(), xs = catalog.filter(s => s.section_id === sec.id);
  const nums = numerals(catalog), acc = accents(catalog);
  const filtered = topicFilter ? xs.filter(s => (s.story_topics || []).some(x => x.topics?.slug === topicFilter)) : xs;
  const { data: topics = [] } = await sb.from('topics').select('*').order('name');
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
    <form method="get" class="filter-bar"><label class="label" for="section-topic">Topic</label><select id="section-topic" name="topic"><option value="">All topics</option>${topics.map(t => `<option value="${esc(t.slug)}" ${topicFilter === t.slug ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select><button type="submit">Filter →</button></form>
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

/* ---------- Topics ---------- */

async function topics() {
  const { data: ts = [] } = await sb.from('topics').select('*').order('name');
  const stories = await published(), nums = numerals(stories);
  title('Topics');
  app.innerHTML = `<div class="page-head">
      <div class="kicker"><span>The archive, by subject</span></div>
      <h1>Topics</h1>
      <p class="standfirst">The ongoing files. New stories are added as they are published.</p>
    </div>
    <ul class="toc topic-index">${ts.map(t => {
      const n = stories.filter(s => (s.story_topics || []).some(x => x.topics?.slug === t.slug)).length;
      return n ? `<li><div class="toc-line"><span class="t"><a href="/topics/${esc(t.slug)}">${esc(t.name)}</a></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n} ${n === 1 ? 'story' : 'stories'}</span></div></li>` : '';
    }).join('')}</ul>`;
}

async function topic(slug) {
  const { data: t } = await sb.from('topics').select('*').eq('slug', slug).single();
  if (!t) { title('Not found'); return app.innerHTML = notFound(); }
  const { data: links = [] } = await sb.from('story_topics').select('story_id').eq('topic_id', t.id);
  const ids = new Set(links.map(x => x.story_id));
  const catalog = await published(), ss = catalog.filter(s => ids.has(s.id));
  const nums = numerals(catalog), acc = accents(catalog);
  const sectionFilter = new URLSearchParams(location.search).get('section') || '';
  const filtered = sectionFilter ? ss.filter(s => s.section_id === sectionFilter) : ss;
  const sections = await allSections();
  title(t.name);
  app.innerHTML = `<div class="page-head">
      <div class="kicker"><span>Topic</span><span class="sep">·</span><span class="numeral">${filtered.length} ${filtered.length === 1 ? 'story' : 'stories'}</span></div>
      <h1>${esc(t.name)}</h1>
    </div>
    <form method="get" class="filter-bar"><span class="label">Section</span><select name="section"><option value="">All sections</option>${sections.map(s => `<option value="${esc(s.id)}" ${sectionFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><button type="submit">Filter →</button></form>
    ${filtered.length ? `<div class="topic-results">${filtered.map((s, i) => entry(s, nums, {
      acc: acc.get(s.id),
      level: 2,
      variant: ['offset', 'ledger', 'strip'][i % 3],
      window: i % 4 === 0 ? 'square' : ''
    })).join('')}</div>` : emptyNote('No published stories match this filter.')}`;
}

/* ---------- Search: ask the desk ---------- */

async function search() {
  const q = new URLSearchParams(location.search).get('q') || '';
  const sectionFilter = new URLSearchParams(location.search).get('section') || '';
  const catalog = await published();
  let ss = [];
  if (q) {
    let query = sb.from('stories').select('*,sections(name,slug),story_topics(topics(name,slug)),profiles!stories_author_id_fkey(name,slug)').eq('status', 'published').or(`title.ilike.%${q}%,dek.ilike.%${q}%,summary.ilike.%${q}%,body.ilike.%${q}%`).order('published_at', { ascending: false });
    if (sectionFilter) query = query.eq('section_id', sectionFilter);
    ss = await hydrateMedia((await query).data || []);
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
      <div class="search-form"><input name="q" type="search" value="${esc(q)}" placeholder="Search stories, people, topics" aria-label="Search"><button type="submit">Search →</button></div>
      <div class="search-filter"><span class="label">In</span><select name="section" aria-label="Section"><option value="">All sections</option>${sections.map(s => `<option value="${esc(s.id)}" ${sectionFilter === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>
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
  const create = p?.role ? `<a href="/newsroom/new" style="color:var(--green)">New story →</a>` : '';
  return `<nav class="desk-nav" aria-label="Newsroom">
    <a href="/newsroom" ${current === 'overview' ? 'aria-current="page" style="color:var(--red)"' : ''}>Overview</a>
    ${create}
    <span class="who">${esc(p?.name || '')} · ${esc(p?.role || '')} · <button class="quiet" id="signout" style="padding:0.3em 0.8em">Sign out</button></span>
  </nav>`;
}

async function newsroom() {
  const u = await session();
  if (!u) {
    title('Sign in');
    app.innerHTML = `<div class="signin desk">
      <div class="kicker"><span>The desk</span></div>
      <h1>Newsroom sign in</h1>
      <p class="hint">The desk is for editors and contributors. Sign in with your newsroom account.</p>
      <form id="login"><label>Email</label><input name="email" type="email" placeholder="Email" required><label>Password</label><input name="password" type="password" placeholder="Password" required><div style="margin-top:1.4rem"><button>Sign in</button></div></form>
    </div>`;
    document.querySelector('#login').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
      if (error) return alert(error.message);
      location.reload();
    };
    return;
  }
  const p = await profile(), { data: ss = [] } = await sb.from('stories').select('*,sections(name)').order('updated_at', { ascending: false });
  title('Newsroom');
  const hour = new Date().getHours(), greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const board = statuses.map(st => {
    const n = ss.filter(s => s.status === st).length;
    return n ? `<li><div class="toc-line"><span class="t"><span class="stamp st-${st}">${st.replace('_', ' ')}</span></span><span class="dots" aria-hidden="true"></span><span class="numeral">${n}</span></div></li>` : '';
  }).join('');
  app.innerHTML = `<div class="desk">
    <div class="page-head">
      <div class="kicker"><span>The desk</span><span class="sep">·</span><span>${dLong(new Date())}</span></div>
      <h1>${greeting}, ${esc((p?.name || '').split(' ')[0])}.</h1>
      <p class="standfirst">${p?.role === 'contributor' ? 'Your drafts, the board, and the way to review.' : 'The board, the queue, and everything in progress.'}</p>
    </div>
    ${deskNav(p, 'overview')}
    <div class="desk-section"><span class="label">The board</span><ul class="toc desk-index">${board || '<li class="meta-line" style="padding:1em 0">No stories yet.</li>'}</ul></div>
    <div class="desk-section"><span class="label">Stories</span><table class="desk-table">
      <tr><th>Title</th><th>Status</th><th>Section</th><th>Updated</th></tr>
      ${ss.map(s => `<tr><td class="title-cell"><a href="/newsroom/${s.id}">${esc(s.title || 'Untitled story')}</a></td><td><span class="stamp st-${s.status}">${s.status.replace('_', ' ')}</span></td><td class="mono">${esc(s.sections?.name || '')}</td><td class="mono">${dShort(s.updated_at)}</td></tr>`).join('')}
    </table></div>
  </div>`;
  document.querySelector('#signout').onclick = async () => { await sb.auth.signOut(); location.reload(); };
}

/* ---------- Story editor ---------- */

async function edit(id) {
  const p = await profile();
  if (!p) return location.href = '/newsroom';
  const { data: sections = [] } = await sb.from('sections').select('*').order('name');
  const { data: topics = [] } = await sb.from('topics').select('*').order('name');
  const { data: s } = id
    ? await sb.from('stories').select('*,story_topics(topic_id)').eq('id', id).single()
    : { data: { title: '', slug: '', dek: '', summary: '', body: '', section_id: 'anyways', status: 'idea', seo_title: '', seo_description: '', story_topics: [] } };
  if (!s) { title('Not found'); return app.innerHTML = notFound(); }
  const chosen = new Set(s.story_topics?.map(x => x.topic_id));
  title(`${id ? 'Edit' : 'New'} story`);
  app.innerHTML = `<div class="desk">
  <div class="page-head"><div class="kicker"><span>The desk</span><span class="sep">·</span><span>${id ? `Editing · ${esc(s.slug)}` : 'New story'}</span></div><h1>${id ? 'Edit story' : 'New story'}</h1></div>
  ${deskNav(p)}
  <form id="story" class="desk-form">
  <div class="editor-grid">
    <div>
      <section class="editor-section">
        <h2>Story</h2>
        <label>Title</label><input name="title" value="${esc(s.title)}" placeholder="Title" required>
        <label>Dek</label><textarea name="dek" placeholder="Dek" required style="min-height:70px">${esc(s.dek)}</textarea>
        <label>Primary section</label><select name="section_id">${sections.map(x => `<option value="${x.id}" ${x.id === s.section_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
        <label>Topics</label><div class="topic-checks">${topics.map(t => `<label><input type="checkbox" name="topic" value="${t.id}" ${chosen.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`).join('')}</div>
        <label>Body (Markdown)</label><textarea id="story-body" name="body" placeholder="Body (Markdown)" required>${esc(s.body)}</textarea>
        <details class="preview"><summary>Preview markdown</summary><div id="markdown-preview" class="markdown-preview">${markdown(s.body || '')}</div></details>
      </section>
    </div>
    <div>
      <section class="editor-section">
        <h2>Editorial</h2>
        <p class="meta-line">Current status: <span class="stamp st-${s.status || 'idea'}">${esc((s.status || 'idea').replace('_', ' '))}</span></p>
        <label>Status</label><select name="status">${statuses.map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>
      </section>
      <details class="editor-section" open>
        <summary>Publishing</summary>
        <div class="secondary-fields">
          <label>Slug (stable URL)</label><input name="slug" value="${esc(s.slug)}" placeholder="Stable slug" required>
          <label>SEO title</label><input name="seo_title" value="${esc(s.seo_title)}" placeholder="SEO title" required>
          <label>SEO description</label><textarea name="seo_description" placeholder="SEO description" required style="min-height:60px">${esc(s.seo_description)}</textarea>
        </div>
      </details>
    </div>
  </div>
  <div class="action-bar">
    <span class="meta-line">${id ? `Status: ${esc(s.status)}.` : 'Create a draft first, then use the workflow actions on the saved story.'}</span>
    <div class="buttons"><button>Save</button></div>
  </div>
  </form>
  </div>`;
  const bodyInput = document.getElementById('story-body'), preview = document.getElementById('markdown-preview');
  if (bodyInput && preview) bodyInput.addEventListener('input', () => { preview.innerHTML = markdown(bodyInput.value); });
  document.querySelector('#story').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), topics = f.getAll('topic'), payload = Object.fromEntries(f);
    payload.author_id = s.author_id || p.id;
    payload.editor_id = s.editor_id || (p.role === 'contributor' ? null : p.id);
    payload.reading_time_minutes = Math.max(1, payload.body.split(/\s+/).length / 220 | 0);
    payload.published_at = payload.status === 'published' ? (s.published_at || new Date().toISOString()) : null;
    delete payload.topic;
    const r = id ? await sb.from('stories').update(payload).eq('id', id).select().single() : await sb.from('stories').insert(payload).select().single();
    if (r.error) return alert(r.error.message);
    if (id) await sb.from('story_topics').delete().eq('story_id', r.data.id);
    if (topics.length) {
      const z = await sb.from('story_topics').insert(topics.map(topic_id => ({ story_id: r.data.id, topic_id })));
      if (z.error) return alert(z.error.message);
    }
    location.href = '/newsroom/' + r.data.id;
  };
}

/* ---------- Router (unchanged behavior) ---------- */

chrome();
const p = location.pathname;
if (p === '/') home();
else if (p === '/topics') topics();
else if (p.startsWith('/topics/')) topic(p.split('/')[2]);
else if (p.startsWith('/sections/')) section(p.split('/')[2]);
else if (p.startsWith('/stories/')) showStory(p.split('/')[2]);
else if (p === '/search') search();
else if (p === '/newsroom/new') edit();
else if (p.startsWith('/newsroom/') && p !== '/newsroom/') edit(p.split('/')[2]);
else newsroom();
