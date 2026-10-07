import { esc, renderArticle } from './article-renderer.mjs';

/* Progressive enhancement for the public edition only. No Supabase client,
   auth, storage, pipeline, realtime, or newsroom code belongs in this entry. */

const app = document.querySelector('#app');
const PUBLIC_LIMIT = 20;

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

function privacyOptOut() {
  try {
    return navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true || localStorage.getItem('anyways.analytics.optout') === '1';
  } catch {
    return navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
  }
}

function installPrivacyControl() {
  const control = document.querySelector('#analytics-opt-out');
  if (!control) return;
  const update = () => {
    const optedOut = (() => { try { return localStorage.getItem('anyways.analytics.optout') === '1'; } catch { return false; } })();
    control.textContent = optedOut ? 'Optional analytics disabled' : 'Disable optional analytics';
    control.setAttribute('aria-pressed', optedOut ? 'true' : 'false');
    control.disabled = optedOut;
  };
  control.addEventListener('click', () => {
    try { localStorage.setItem('anyways.analytics.optout', '1'); } catch {}
    update();
  });
  update();
}

function safeJson(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function analyticsSession() {
  try {
    const existing = sessionStorage.getItem('anyways.analytics.session');
    if (existing) return existing;
    const created = randomId();
    sessionStorage.setItem('anyways.analytics.session', created);
    return created;
  } catch { return ''; }
}

function analyticsAttribution() {
  const params = new URLSearchParams(location.search);
  const value = {
    source: String(params.get('utm_source') || params.get('ref') || '').toLowerCase().slice(0, 80),
    medium: String(params.get('utm_medium') || '').toLowerCase().slice(0, 80),
    campaign: String(params.get('utm_campaign') || '').toLowerCase().slice(0, 80),
    content: String(params.get('utm_content') || '').toLowerCase().slice(0, 80)
  };
  const key = 'anyways.analytics.first-touch';
  const ttl = 30 * 24 * 60 * 60 * 1000;
  let first = null;
  try {
    const stored = safeJson(localStorage.getItem(key) || '', null);
    if (stored?.value && Number(stored.captured_at) > Date.now() - ttl) first = stored;
    if (!first) {
      first = { captured_at: Date.now(), value };
      localStorage.setItem(key, JSON.stringify(first));
    }
  } catch { first = { value }; }
  return { session: value, first: first.value || value };
}

function installReaderSignals() {
  if (location.pathname.startsWith('/newsroom') || privacyOptOut()) return;
  const sessionId = analyticsSession();
  if (!sessionId) return;
  const attribution = analyticsAttribution();
  const send = (eventType, eventValue = null, detail = '') => {
    const body = JSON.stringify({
      event_type: eventType,
      session_id: sessionId,
      path: location.pathname,
      landing_page: location.pathname,
      referrer_host: (() => { try { const referrer = document.referrer ? new URL(document.referrer) : null; return referrer && referrer.origin !== location.origin ? referrer.hostname : null; } catch { return null; } })(),
      session_source: attribution.session.source || null,
      session_medium: attribution.session.medium || null,
      session_campaign: attribution.session.campaign || null,
      session_content: attribution.session.content || null,
      first_source: attribution.first.source || null,
      first_medium: attribution.first.medium || null,
      first_campaign: attribution.first.campaign || null,
      first_content: attribution.first.content || null,
      event_value,
      detail
    });
    fetch('/api/analytics/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
  };
  send('page_view');
  let activeSince = document.visibilityState === 'visible' ? Date.now() : 0;
  const reportEngaged = () => {
    if (!activeSince) return;
    const seconds = Math.floor((Date.now() - activeSince) / 1000);
    activeSince = 0;
    if (seconds > 0) send('engaged', Math.min(seconds, 86400));
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') reportEngaged();
    else activeSince = Date.now();
  });
  window.addEventListener('pagehide', reportEngaged, { once: true });

  const sent = new Set();
  let hadRealScroll = false;
  let stable = false;
  const markStable = () => { stable = true; };
  if (document.readyState === 'complete') setTimeout(markStable, 250);
  else window.addEventListener('load', () => setTimeout(markStable, 250), { once: true });
  const reportScroll = () => {
    if (!stable || !hadRealScroll) return;
    const range = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    if (range <= 0) return;
    const depth = Math.round(Math.min(1, Math.max(0, window.scrollY / range)) * 100);
    for (const mark of [25, 50, 75, 100]) {
      if (depth >= mark && !sent.has(mark)) { sent.add(mark); send('scroll', mark); }
    }
  };
  window.addEventListener('scroll', () => { hadRealScroll = true; reportScroll(); }, { passive: true });
  window.addEventListener('resize', reportScroll, { passive: true });
  document.addEventListener('click', event => {
    const share = event.target.closest('[data-share-destination]');
    if (share) send('share', null, share.dataset.shareDestination || 'share');
    const link = event.target.closest('a[href]');
    if (!link) return;
    try { const destination = new URL(link.href, location.href); if (destination.origin !== location.origin) send('outbound', null, destination.hostname); } catch {}
  });

  /* Coarse first-party web-vital samples are useful for release regression
     checks. They share the same opt-out gate and carry no URL or identity. */
  const reportedMetrics = new Set();
  const reportMetric = (name, value) => {
    const numeric = Number(value);
    if (reportedMetrics.has(name) || !Number.isFinite(numeric) || numeric < 0) return;
    reportedMetrics.add(name);
    send('performance', Math.min(86400, Math.round(name === 'cls' ? numeric * 1000 : numeric)), name);
  };
  const navigation = performance.getEntriesByType?.('navigation')?.[0];
  if (navigation?.responseStart > 0) reportMetric('ttfb', navigation.responseStart);
  const observeMetric = (type, callback) => {
    if (!('PerformanceObserver' in window)) return;
    try {
      const observer = new PerformanceObserver(list => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
      window.setTimeout(() => observer.disconnect(), 5000);
    } catch {}
  };
  let largestContentfulPaint = 0;
  let lcpTimer;
  observeMetric('largest-contentful-paint', entries => {
    largestContentfulPaint = entries.at(-1)?.startTime || largestContentfulPaint;
    clearTimeout(lcpTimer);
    lcpTimer = window.setTimeout(() => reportMetric('lcp', largestContentfulPaint), 1800);
  });
  let cumulativeLayoutShift = 0;
  let clsTimer;
  observeMetric('layout-shift', entries => {
    for (const entry of entries) if (!entry.hadRecentInput) cumulativeLayoutShift += entry.value || 0;
    clearTimeout(clsTimer);
    clsTimer = window.setTimeout(() => reportMetric('cls', cumulativeLayoutShift), 1800);
  });
  let interactionToNextPaint = 0;
  let inpTimer;
  observeMetric('event', entries => {
    for (const entry of entries) interactionToNextPaint = Math.max(interactionToNextPaint, entry.duration || 0);
    clearTimeout(inpTimer);
    inpTimer = window.setTimeout(() => reportMetric('inp', interactionToNextPaint), 1800);
  });
}

async function requestJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, { headers: { accept: 'application/json' }, signal: controller.signal });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data?.error?.message || 'The public edition is unavailable.'), { status: response.status });
    return data;
  } finally { clearTimeout(timer); }
}

function publishedDate(value, options = { month: 'short', day: 'numeric', year: 'numeric' }) {
  try { return new Date(value).toLocaleDateString('en-US', options); } catch { return ''; }
}

function card(story, { eager = false } = {}) {
  const media = story.presentation?.hero || story.hero_media;
  const imageUrl = media?.public_url || media?.url || media?.original_url || '';
  const image = imageUrl ? `<img src="${esc(imageUrl)}" alt="${esc(media?.alt_text || '')}"${media?.width ? ` width="${Number(media.width)}"` : ''}${media?.height ? ` height="${Number(media.height)}"` : ''} loading="${eager ? 'eager' : 'lazy'}" decoding="async"${eager ? ' fetchpriority="high"' : ''}>` : '';
  return `<article class="card${image ? ' card--media' : ''}" data-reveal>${image ? `<a class="card-media" href="/stories/${encodeURIComponent(story.slug)}" tabindex="-1" aria-hidden="true">${image}</a>` : ''}<div class="card-body"><div class="chiprow">${story.sections?.slug ? `<a class="chip" href="/sections/${esc(story.sections.slug)}">${esc(story.sections.name || '')}</a>` : ''}<span class="chip chip--quiet">${esc(story.article_format || 'News')}</span></div><h2 class="card-title"><a href="/stories/${encodeURIComponent(story.slug)}">${esc(story.title)}</a></h2><p class="card-dek">${esc(story.dek)}</p><div class="card-meta mono"><time datetime="${esc(story.published_at || '')}">${esc(publishedDate(story.published_at))}</time><span>${Number(story.reading_time_minutes) || 1} min</span></div></div></article>`;
}

function indexLine(story) {
  return `<li class="indexrow" data-reveal><a class="indexrow-hit" href="/stories/${encodeURIComponent(story.slug)}"><span class="indexrow-title">${esc(story.title)}</span><span class="indexrow-dots" aria-hidden="true"></span><span class="indexrow-meta mono"><time datetime="${esc(story.published_at || '')}">${esc(publishedDate(story.published_at, { month: 'short', day: 'numeric' }))}</time> · ${Number(story.reading_time_minutes) || 1} min</span></a></li>`;
}

function pageHtml(data) {
  if (data.type === 'story') return renderArticle({ story: data.story, sources: data.sources || [], corrections: data.corrections || [], related: data.related || [], catalog: [data.story, ...(data.related || [])], shareHref: location.href, relatedHtml: data.related?.length ? `<div class="upnext-grid">${data.related.map((story, index) => card(story, { eager: index === 0 })).join('')}</div>` : '' });
  if (data.type === 'home') {
    const lead = data.lead;
    const support = (data.featured || []).filter(story => story.id !== lead?.id).slice(0, 4);
    const latest = (data.latest || []).filter(story => story.id !== lead?.id && !support.some(item => item.id === story.id));
    return `<div class="server-home"><header class="hero"><p class="hero-eyebrow mono">[ fresh off the desk · ${esc(publishedDate(new Date(), { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))} ]</p><h1 class="hero-word">ANYWAYS</h1><p class="hero-promise">We cover the stories the timeline will talk about tomorrow.</p></header>${lead ? `<section class="billboard a-brick" aria-label="Top story">${card(lead, { eager: true })}</section>` : '<p class="empty-note">The desk is setting its first edition.</p>'}${support.length ? `<section class="wire" aria-label="Featured stories"><header class="sec-head"><h2>Featured stories</h2></header><div class="wire-row">${support.map((story, index) => card(story, { eager: index === 0 })).join('')}</div></section>` : ''}<section class="allindex"><header class="sec-head"><h2>Latest</h2></header><ul class="indexlist indexlist--full">${latest.map(indexLine).join('')}</ul><p class="zonetail mono"><a href="/latest">see every recent story →</a></p></section></div>`;
  }
  if (['latest', 'section', 'topic'].includes(data.type)) {
    const label = data.type === 'section' ? data.section.name : data.type === 'topic' ? data.topic.name : 'Latest';
    return `<div class="zonepage"><header class="zone-head"><p class="zone-kicker mono">[ ${esc(data.type)} · ${(data.stories || []).length} stories ]</p><h1 class="zone-name">${esc(label)}</h1><p class="zone-promise">${esc(data.type === 'latest' ? 'Follow the signal. Ignore the noise.' : `Stories connected to ${label}.`)}</p></header><div class="zone-lead">${data.stories?.length ? card(data.stories[0], { eager: true }) + `<ul class="indexlist indexlist--zone">${data.stories.slice(1).map(indexLine).join('')}</ul>` : '<p class="empty-note">No published stories match this desk yet.</p>'}</div></div>`;
  }
  if (data.type === 'topics') return `<div class="zonepage"><header class="zone-head"><h1 class="zone-name">Topics</h1><p class="zone-promise">Subjects that keep coming back.</p></header><ul class="beatmenu">${data.rows.map(row => `<li class="beatmenu-row"><a class="beatmenu-hit" href="/topics/${esc(row.topic.slug)}"><span class="beatmenu-name">${esc(row.topic.name)}</span><span class="beatmenu-count mono">${row.count} stories</span></a></li>`).join('')}</ul></div>`;
  if (data.type === 'search') {
    const section = data.section ? `&section=${encodeURIComponent(data.section)}` : '';
    const next = data.next_cursor ? `<p class="zonetail mono"><a href="/search?q=${encodeURIComponent(data.query)}${section}&cursor=${encodeURIComponent(data.next_cursor)}">next results →</a></p>` : '';
    return `<div class="askpage"><header class="zone-head"><h1 class="zone-name">Search</h1><p class="zone-promise">Search the published file by story, subject, or source language.</p></header><form id="search" method="get" class="askbox"><div class="ask-line"><label class="sr-only" for="archive-query">Search the archive</label><input id="archive-query" name="q" type="search" maxlength="120" value="${esc(data.query || '')}" placeholder="people, protocols, drama…"><button type="submit">search →</button></div></form>${data.query ? (data.results.length ? `<p class="ask-results mono">[ ${data.results.length} results ]</p><div class="zone-lead">${data.results.map(story => card(story)).join('')}</div>${next}` : '<p class="empty-note">No results. Try a shorter phrase or browse <a href="/latest">Latest</a>.</p>') : '<p class="empty-note">Try a person, a protocol, a company, or the thing everyone keeps talking around.</p>'}</div>`;
  }
  return '<div class="lost"><p class="mono">[ 404 · wiped out ]</p><h1>This page does not exist.</h1><p><a class="more-link mono" href="/latest">read the latest →</a></p></div>';
}

function apiPath() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  if (path === '/') return '/api/public/home';
  if (path === '/latest') return `/api/public/latest${location.search}`;
  if (path === '/topics') return '/api/public/topics';
  if (path.startsWith('/topics/')) return `/api/public/topic/${encodeURIComponent(path.split('/')[2])}${location.search}`;
  if (path.startsWith('/sections/')) return `/api/public/section/${encodeURIComponent(path.split('/')[2])}${location.search}`;
  if (path.startsWith('/stories/')) return `/api/public/story/${encodeURIComponent(path.split('/')[2])}`;
  if (path === '/search') return `/api/public/search${location.search}`;
  return '';
}

function bindSearch() {
  const form = document.querySelector('#search');
  if (!form || form.dataset.bound) return;
  form.dataset.bound = '1';
  form.addEventListener('submit', event => {
    event.preventDefault();
    const params = new URLSearchParams(new FormData(form));
    for (const [key, value] of [...params]) if (!String(value).trim()) params.delete(key);
    location.href = `/search${params.toString() ? `?${params}` : ''}`;
  });
}

function bindActiveNavigation() {
  const path = location.pathname;
  for (const link of document.querySelectorAll('[data-current]')) {
    const current = link.dataset.current;
    const sectionSlug = path.match(/^\/sections\/([^/]+)/)?.[1] || '';
    if ((current === 'home' && path === '/') || (current === 'latest' && path === '/latest') || (current === 'topics' && path.startsWith('/topics')) || (current === 'search' && path === '/search') || (current === `section:${sectionSlug}` && sectionSlug)) link.setAttribute('aria-current', 'page');
  }
  const details = document.querySelector('.nav-sections-menu');
  if (details && window.matchMedia('(max-width: 760px)').matches) details.removeAttribute('open');
  const media = window.matchMedia('(max-width: 760px)');
  media.addEventListener?.('change', event => { if (!event.matches) details?.removeAttribute('open'); });
}

async function populateTicker() {
  const ticker = document.querySelector('#ticker');
  const track = document.querySelector('#ticker-track');
  if (!ticker || !track || track.children.length) return;
  try {
    const latest = await requestJson('/api/public/latest?limit=8');
    const stories = (latest.stories || []).slice(0, 8);
    if (!stories.length) return;
    track.innerHTML = stories.map(story => `<a class="ticker-item" href="/stories/${encodeURIComponent(story.slug)}">${esc(story.title)}</a><span class="ticker-sep" aria-hidden="true">✺</span>`).join('');
    ticker.hidden = false;
  } catch {}
}

async function loadPublicPage() {
  if (!app) return;
  bindSearch();
  bindActiveNavigation();
  populateTicker();
  if (app.dataset.serverRendered === 'true') return;
  const path = apiPath();
  if (!path) return;
  app.setAttribute('aria-busy', 'true');
  try {
    const data = await requestJson(path);
    if (data.redirect) { location.replace(data.redirect); return; }
    if (data.status === 404) { app.innerHTML = pageHtml({ type: 'not-found' }); return; }
    app.innerHTML = pageHtml(data);
    bindSearch();
  } catch (error) {
    app.innerHTML = `<div class="lost"><p class="mono">[ interference ]</p><h1>The edition is temporarily unavailable.</h1><p class="lede">The last readable page could not be loaded. Check your connection and try again.</p><p><button class="retry-button" type="button">Try again</button></p></div>`;
    document.querySelector('.retry-button')?.addEventListener('click', () => location.reload());
  } finally { app.removeAttribute('aria-busy'); }
}

installPrivacyControl();
installReaderSignals();
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loadPublicPage, { once: true });
else loadPublicPage();
