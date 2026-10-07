import { createShareUrl } from './analytics-attribution.mjs';

export const ARTICLE_COMPOSITIONS = Object.freeze([
  { value: 'split', label: 'Standard hero beside headline' }
]);

export const ARTICLE_ACCENTS = Object.freeze([
  'cyan', 'magenta', 'mustard', 'yellow', 'brick', 'cobalt',
  'coral', 'mint', 'lime', 'peach', 'lavender', 'deepgreen'
]);

export const INLINE_IMAGE_LAYOUTS = Object.freeze([
  { value: 'full', label: 'Full width' },
  { value: 'wide', label: 'Wide' },
  { value: 'left', label: 'Float left' },
  { value: 'right', label: 'Float right' }
]);

export const DEFAULT_PRESENTATION = Object.freeze({
  composition: 'split',
  accent: 'auto',
  hero: null,
  detour: { visible: false, label: 'The detour', text: '', afterBlock: 1 },
  detours: [],
  inlineImages: []
});

export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
}[char]));

/* Source records arrive from feeds and scrapers that sometimes leave HTML
   entities encoded in titles. Decode once so esc() can re-encode cleanly
   instead of double-escaping the ampersand (won&#x27;t → won&amp;#x27;t). */
export function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[body.toLowerCase()] ?? match;
  });
}

export function hash(value) {
  let result = 2166136261;
  for (const char of String(value)) {
    result ^= char.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function safeMediaUrl(value) {
  const raw = String(value || '');
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return '';
    return url.href;
  } catch {
    return '';
  }
}

const dLong = value => new Date(value).toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
});
const dShort = value => new Date(value).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', year: 'numeric'
});
const humanize = value => String(value || '').replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());

export function normalizePresentation(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const rawDetours = Array.isArray(input.detours)
    ? input.detours
    : input.detour && typeof input.detour === 'object' ? [input.detour] : [];
  const detours = rawDetours
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      id: String(item.id || `detour-${index + 1}`),
      visible: item.visible !== false,
      label: String(item.label || 'The detour'),
      text: String(item.text || ''),
      afterBlock: Math.max(0, Number(item.afterBlock) || 0)
    }));
  return {
    // One reliable article opening beats several clever but unpredictable
    // treatments. Older composition values deliberately resolve to Split.
    composition: 'split',
    accent: ARTICLE_ACCENTS.includes(input.accent) ? input.accent : 'auto',
    hero: input.hero && typeof input.hero === 'object' ? { ...input.hero } : null,
    detour: detours[0] || { visible: false, label: 'The detour', text: '', afterBlock: 1 },
    detours,
    inlineImages: Array.isArray(input.inlineImages)
      ? input.inlineImages.filter(item => item && typeof item === 'object').map(item => ({ ...item }))
      : []
  };
}

/* Signature 1: the signal index chip. */
export function numChip(number, cls = '') {
  if (!number) return '';
  return `<span class="num${cls ? ` ${cls}` : ''}">[${String(number).padStart(3, '0')}]</span>`;
}

export function signalMark(cls = '') {
  return `<span class="signal-mark${cls ? ` ${cls}` : ''}" aria-hidden="true"><i></i><i></i><i></i></span>`;
}

function previewControl(name, interactive, label) {
  return interactive
    ? ` data-preview-control="${esc(name)}" role="button" tabindex="0" aria-label="${esc(label)}"`
    : '';
}

/* Signature 2: the frame. Real story media when it exists, a type-only plate
   when it doesn't — photography is optional, never invented. */
export function frame(story, number, options = {}) {
  const presentation = normalizePresentation(options.presentation || story.presentation);
  const configured = presentation.hero;
  const candidate = configured || story.hero_media;
  const imageUrl = candidate ? safeMediaUrl(candidate.public_url || candidate.url || candidate.original_url) : '';
  const media = candidate && imageUrl && !configured?.removed ? candidate : null;
  const className = options.className ? ` ${options.className}` : '';
  const focalX = Math.min(100, Math.max(0, Number(media?.focalX ?? 50)));
  const focalY = Math.min(100, Math.max(0, Number(media?.focalY ?? 50)));
  const crop = ['auto', 'landscape', 'portrait', 'square'].includes(media?.crop) ? media.crop : 'auto';
  const fit = media?.fit === 'contain' ? 'contain' : 'cover';
  const credit = String(media?.credit || '').trim();
  const caption = credit
    ? `<figcaption class="mono"><span>${esc(credit)}</span></figcaption>`
    : '';
  const rightsWarning = options.interactive && media && (media.previewOnly || media.rights_status !== 'approved')
    ? '<span class="preview-rights-warning">Preview only · rights decision required</span>'
    : '';
  const content = media
    ? `<img src="${esc(imageUrl)}" alt="${esc(media.alt_text || media.alt || '')}" loading="${options.eager ? 'eager' : 'lazy'}" decoding="async" style="object-position:${focalX}% ${focalY}%">`
    : `<div class="frame-type" aria-hidden="true">
        <span class="frame-glyph">${esc((story.title || 'A').trim().charAt(0).toUpperCase())}</span>
        <span class="frame-num">${number ? String(number).padStart(3, '0') : 'ANY'}</span>
      </div>`;
  return `<figure class="frame${media ? ' has-media' : ' is-type'} crop-${crop} fit-${fit}${className}"${previewControl('hero', options.interactive, 'Configure hero photo')}>
    <div class="frame-cut">${content}</div>
    ${rightsWarning}${caption}
  </figure>`;
}

/* Signature 3: the sticker. Article copy always comes from the presentation's
   dedicated detour fields — never from the story summary or dek. */
export function detour(story, number, options = {}) {
  const label = esc(options.label || 'The detour');
  const text = esc(options.text || '');
  if (!text && !options.href) return '';
  const linkedTitle = options.href ? `<a class="sticker-link mono" href="${esc(options.href)}">${esc(options.linkTitle || story.title)} →</a>` : '';
  return `<aside class="sticker${options.className ? ` ${options.className}` : ''}"${previewControl('detour', options.interactive, 'Configure Detour card')}>
    ${signalMark('signal-mark--sticker')}
    <span class="sticker-label mono">${label}</span>
    <p>${text}</p>
    <div class="sticker-foot">${numChip(number)}${linkedTitle}</div>
  </aside>`;
}

/* Functional article marginalia, kept deliberately quieter than the three
   signature devices. */
export function articleRail(story, sources, numbers, pool) {
  const notes = [];
  const secondarySections = (story.story_sections || []).map(item => item.sections).filter(Boolean);
  const beats = (story.story_beats || []).map(item => item.beats).filter(Boolean);
  const tags = (story.story_tags || []).map(item => item.tags).filter(Boolean);
  if (secondarySections.length) notes.push(`<div class="rail-note"><span class="rail-label mono">Also filed under</span><p>${secondarySections.map(section => `<a href="/sections/${esc(section.slug)}">${esc(section.name)}</a>`).join(' / ')}</p></div>`);
  if (beats.length) notes.push(`<div class="rail-note"><span class="rail-label mono">Topics</span><p>${beats.map(topic => `<a href="/topics/${esc(topic.slug)}">${esc(topic.name)}</a>`).join(' / ')}</p></div>`);
  if (tags.length) notes.push(`<div class="rail-note"><span class="rail-label mono">Tags</span><p>${tags.map(topic => esc(topic.name)).join(' / ')}</p></div>`);
  if (sources.length) notes.push(`<div class="rail-note"><span class="rail-label mono">The record</span><p>${sources.length} source${sources.length === 1 ? '' : 's'} on file, beginning with ${esc(decodeEntities(sources[0].publisher || sources[0].title))}.</p></div>`);
  const archive = (pool || []).filter(item => item.id !== story.id);
  if (archive.length) {
    const pick = archive[hash(story.id || story.slug) % archive.length];
    notes.push(`<div class="rail-note"><span class="rail-label mono">From the archive</span><p>${numChip(numbers.get(pick.id))} <a href="/stories/${esc(pick.slug)}">${esc(pick.title)}</a></p></div>`);
  }
  return notes.length ? `<aside class="story-rail" aria-label="Story notes">${notes.join('')}</aside>` : '';
}

function safeInlineUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 2048) return '';
    return url.href;
  } catch {
    return '';
  }
}

function inlineText(value) {
  return esc(value).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>');
}

function inline(value) {
  const source = String(value || '');
  const links = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let html = '';
  let cursor = 0;
  let match;
  while ((match = links.exec(source))) {
    html += inlineText(source.slice(cursor, match.index));
    const href = safeInlineUrl(match[2]);
    html += href
      ? `<a class="body-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${inlineText(match[1])}</a>`
      : inlineText(match[0]);
    cursor = match.index + match[0].length;
  }
  return html + inlineText(source.slice(cursor));
}

export function markdown(text) {
  const lines = String(text || '').split('\n');
  let html = '';
  let list = null;
  const close = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const line of lines) {
    if (line.startsWith('### ')) { close(); html += `<h3>${inline(line.slice(4))}</h3>`; }
    else if (line.startsWith('## ')) { close(); html += `<h2>${inline(line.slice(3))}</h2>`; }
    else if (line.startsWith('> ')) { close(); html += `<blockquote>${inline(line.slice(2))}</blockquote>`; }
    else if (/^\d+\. /.test(line)) { if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += `<li>${inline(line.replace(/^\d+\. /, ''))}</li>`; }
    else if (line.startsWith('- ')) { if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += `<li>${inline(line.slice(2))}</li>`; }
    else if (line === '---') { close(); html += '<hr>'; }
    else if (line) { close(); html += `<p>${inline(line)}</p>`; }
    else close();
  }
  close();
  return html;
}

export function presentationBody(story) {
  return String(story.body || '').trim();
}

export function bodyBlocks(storyOrText) {
  const text = storyOrText && typeof storyOrText === 'object' ? presentationBody(storyOrText) : storyOrText;
  return markdown(text)
    .split(/(?=<h2|<h3|<p>|<blockquote>|<ul>|<ol>|<hr>)/)
    .filter(Boolean);
}

function inlineFigure(image, interactive) {
  const url = safeMediaUrl(image.public_url || image.url || image.original_url);
  if (!url) return '';
  const layout = INLINE_IMAGE_LAYOUTS.some(item => item.value === image.layout) ? image.layout : 'wide';
  const credit = String(image.credit || '').trim();
  const warning = interactive && (image.previewOnly || image.rights_status !== 'approved')
    ? '<span class="preview-rights-warning">Preview only · rights decision required</span>'
    : '';
  return `<figure class="fig inline-${layout}" data-inline-id="${esc(image.id || image.mediaId || '')}"${previewControl('inline-image', interactive, 'Configure inline image')}>
    <img src="${esc(url)}" alt="${esc(image.alt_text || image.alt || '')}" loading="lazy" decoding="async">
    ${warning}
    ${credit ? `<figcaption class="mono"><span>${esc(credit)}</span></figcaption>` : ''}
  </figure>`;
}

export function composeBody(story, number, presentationValue, interactive = false) {
  const presentation = normalizePresentation(presentationValue);
  const blocks = bodyBlocks(story);
  const groupedImages = new Map();
  const groupedDetours = new Map();
  for (const image of presentation.inlineImages) {
    const afterBlock = Math.max(0, Number(image.afterBlock) || 0);
    groupedImages.set(afterBlock, [...(groupedImages.get(afterBlock) || []), image]);
  }
  for (const item of presentation.detours.filter(detourItem => detourItem.visible && detourItem.text.trim())) {
    const afterBlock = Math.max(0, Number(item.afterBlock) || 0);
    groupedDetours.set(afterBlock, [...(groupedDetours.get(afterBlock) || []), item]);
  }
  const output = [];
  blocks.forEach((block, index) => {
    output.push(block);
    for (const image of groupedImages.get(index) || []) output.push(inlineFigure(image, interactive));
    for (const item of groupedDetours.get(index) || []) output.push(detour(story, number, {
        className: 'sticker--article',
        label: item.label,
        text: item.text,
        interactive
      }));
  });
  return output.join('');
}

export function resolveComposition(story, presentationValue) {
  normalizePresentation(presentationValue);
  return 'comp-split';
}

export function renderArticle({
  story,
  sources = [],
  corrections = [],
  related = [],
  catalog = [],
  numbers = new Map(),
  accent = 'brick',
  presentation,
  interactive = false,
  relatedHtml = '',
  shareHref = ''
}) {
  const value = normalizePresentation(presentation || story.presentation);
  const safeAccent = value.accent === 'auto' ? accent : value.accent;
  const composition = resolveComposition(story, value);
  const date = story.published_at || story.updated_at || new Date().toISOString();
  const minutes = story.reading_time_minutes || 1;
  const ghost = esc((story.title || 'Anyways').split(/\s+/)[0].replace(/[^a-z0-9]/gi, '').slice(0, 10).toUpperCase() || 'ANY');
  const hero = frame(story, numbers.get(story.id), {
    className: 'frame--story', eager: true, presentation: value, interactive
  });
  const xShareUrl = shareHref ? createShareUrl(shareHref, 'x', { medium: 'social' }) : '';
  const copyShareUrl = shareHref ? createShareUrl(shareHref, 'copy') : '';
  const share = shareHref ? `<div class="share mono" data-reveal>
      <span class="share-label">pass it on</span>
      <button type="button" class="share-btn" data-copy-link data-share-url="${esc(copyShareUrl)}" data-share-destination="copy">copy link</button>
      <a class="share-btn" data-share-destination="x" href="https://x.com/intent/post?text=${encodeURIComponent(story.title || '')}&url=${encodeURIComponent(xShareUrl)}" target="_blank" rel="noopener noreferrer">post to x ↗</a>
    </div>` : '';
  return `<article class="story ${composition} a-${safeAccent}"${interactive ? ' data-article-preview' : ''}>
    <div class="readbar" aria-hidden="true"><i></i></div>
    <div class="storybar" aria-hidden="true">
      <span class="storybar-name">${signalMark('signal-mark--storybar')} ${esc(story.title)}</span>
      <span class="storybar-meta mono"><span data-minutes-left="${minutes}">${minutes} min read</span></span>
    </div>
    <header class="story-hero"${previewControl('opening', interactive, 'Configure opening composition')}>
      <span class="ghost" data-drift="0.06" aria-hidden="true">${ghost}</span>
      <div class="story-hero-copy">
        <div class="chiprow" data-reveal>
          <a class="chip" href="/sections/${esc(story.sections?.slug || '')}">${esc(story.sections?.name || '')}</a>
          ${numChip(numbers.get(story.id))}
          <span class="chip chip--quiet">${dShort(date)}</span>
        </div>
        <h1 class="story-title"><span>${esc(story.title)}</span></h1>
        <p class="story-lede" data-reveal>${esc(story.dek)}</p>
        <div class="story-byline mono" data-reveal>
          <span>${dLong(date)}</span>
          ${story.updated_at && story.published_at && new Date(story.updated_at) > new Date(story.published_at) ? `<span>Updated ${dShort(story.updated_at)}</span>` : ''}
          <span>${minutes} min read</span>
        </div>
      </div>
      ${hero}
    </header>
    ${share}
    <div class="story-shell">
      ${articleRail(story, sources, numbers, catalog)}
      <div class="story-body prose">${composeBody(story, numbers.get(story.id), value, interactive)}<p class="story-end mono" aria-hidden="true">${signalMark('signal-mark--end')}</p></div>
    </div>
    ${sources.length ? `<aside class="sourcelist" data-reveal>
      <h2 class="sourcelist-head">The record <span class="src-count mono">[${String(sources.length).padStart(2, '0')}]</span></h2>
      <p class="sourcelist-note mono">sources are part of the story.</p>
      <ol>${sources.map((source, i) => `<li class="src"><a class="src-hit" target="_blank" rel="noopener noreferrer" href="${esc(source.safe_url || source.url)}">
        <span class="src-num mono">${String(i + 1).padStart(2, '0')}</span>
        <span class="src-body"><span class="src-title">${esc(decodeEntities(source.title))}</span>
        <span class="src-meta mono">${esc(decodeEntities(source.publisher || ''))} · ${esc(humanize(source.source_type))}${source.published_at ? ` · ${dShort(source.published_at)}` : ''}</span></span>
        <span class="src-arrow" aria-hidden="true">↗</span>
      </a></li>`).join('')}</ol>
    </aside>` : ''}
    ${corrections.length ? `<aside class="correction-history" data-reveal>
      <h2 class="sourcelist-head">Correction history</h2>
      <ol>${corrections.map(correction => `<li><span class="mono">${dShort(correction.corrected_at)}</span><span>${esc(correction.note)}</span></li>`).join('')}</ol>
    </aside>` : ''}
    ${related.length ? `<section class="upnext" data-reveal>
      <h2 class="upnext-head">Anyways…</h2>
      <p class="upnext-note mono">here’s where we’d go next.</p>
      ${relatedHtml}
    </section>` : ''}
  </article>`;
}
