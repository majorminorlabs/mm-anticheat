export const INGESTION_STATUSES = Object.freeze([
  'not_activated', 'ready', 'polling', 'healthy', 'degraded', 'failed', 'unsupported'
]);

export const SUPPORTED_INGESTION_SOURCE_TYPES = Object.freeze(['rss', 'blog', 'official_announcements']);
export const MAX_FETCH_BYTES = 512 * 1024;
export const MAX_FETCH_ITEMS = 100;
export const MAX_REDIRECTS = 2;
export const FETCH_TIMEOUT_MS = 8000;

const PRIVATE_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'metadata.google.internal', 'metadata.google',
  'instance-data.ec2.internal', 'kubernetes.default.svc'
]);

const trim = value => String(value ?? '').trim();

function privateIpv4(hostname) {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d+$/.test(part) || Number(part) > 255)) return false;
  const [a, b] = parts.map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function decodeEntities(value) {
  return trim(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'");
}

function stripTags(value) {
  return decodeEntities(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(text, expression) {
  const match = String(text || '').match(expression);
  return match ? decodeEntities(match[1]) : '';
}

function tagValue(block, names) {
  for (const name of names) {
    const value = firstMatch(block, new RegExp(`<(?:(?:[A-Za-z0-9_-]+):)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:[A-Za-z0-9_-]+):)?${name}>`, 'i'));
    if (value) return stripTags(value);
  }
  return '';
}

function attributeValue(tag, name) {
  return firstMatch(tag, new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
}

function linkValue(block, atom = false) {
  if (atom) {
    const links = [...String(block || '').matchAll(/<link\b([^>]*)>/gi)];
    const preferred = links.find(match => !attributeValue(match[1], 'rel') || attributeValue(match[1], 'rel') === 'alternate');
    return decodeEntities(attributeValue(preferred?.[1] || '', 'href'));
  }
  return tagValue(block, ['link', 'guid']) || firstMatch(block, /<enclosure\b[^>]*url\s*=\s*["']([^"']+)["']/i);
}

function mediaValues(block) {
  const urls = [];
  for (const match of String(block || '').matchAll(/<(?:media:content|media:thumbnail|enclosure)\b([^>]*)>/gi)) {
    const url = decodeEntities(attributeValue(match[1], 'url'));
    if (url) urls.push({ url, type: attributeValue(match[1], 'type') || null, width: attributeValue(match[1], 'width') || null, height: attributeValue(match[1], 'height') || null });
  }
  return urls;
}

function itemFromBlock(block, { atom = false, rawDocument = '' } = {}) {
  const title = tagValue(block, ['title']);
  const canonicalUrl = linkValue(block, atom);
  const externalId = tagValue(block, atom ? ['id'] : ['guid']) || canonicalUrl;
  const rawText = tagValue(block, ['content:encoded', 'content', 'description', 'summary']);
  const summary = tagValue(block, ['description', 'summary', 'subtitle']) || rawText.slice(0, 360);
  const published = tagValue(block, atom ? ['published', 'updated'] : ['pubDate', 'published', 'updated', 'dc:date']);
  const author = tagValue(block, ['author', 'dc:creator', 'name']);
  return {
    external_id: externalId || null,
    canonical_url: canonicalUrl || null,
    title: title || canonicalUrl || 'Untitled source item',
    raw_text: rawText || stripTags(block),
    summary,
    author_name: author || null,
    published_at: normalizeTimestamp(published),
    media: mediaValues(block),
    // Retain the source item itself. Repeating the entire feed document on
    // every event multiplies a bounded feed into an oversized database write.
    raw_payload: { item_xml: block }
  };
}

export function normalizeTimestamp(value) {
  const text = trim(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function canonicalizeUrl(value) {
  try {
    const url = new URL(trim(value));
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$)/i.test(key)) url.searchParams.delete(key);
    return url.href.replace(/\/$/, '');
  } catch { return ''; }
}

export function isSafeFetchUrl(value, { expectedHostname = null } = {}) {
  let url;
  try { url = new URL(trim(value)); } catch { return { ok: false, reason: 'URL is invalid.' }; }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:') return { ok: false, reason: 'Only HTTPS source URLs are allowed.' };
  if (url.username || url.password) return { ok: false, reason: 'Source URLs cannot contain credentials.' };
  if (url.port && url.port !== '443') return { ok: false, reason: 'Only the default HTTPS port is allowed.' };
  if (PRIVATE_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.internal') || hostname.endsWith('.local')) return { ok: false, reason: 'Private and internal hostnames are blocked.' };
  if (privateIpv4(hostname)) return { ok: false, reason: 'Private and link-local IP ranges are blocked.' };
  if (/^(?:fc|fd|fe80):/i.test(hostname) || hostname === '::1' || hostname === '0.0.0.0') return { ok: false, reason: 'Private IPv6 and wildcard addresses are blocked.' };
  if (expectedHostname && hostname !== expectedHostname.toLowerCase()) return { ok: false, reason: 'Redirected source host is not the configured official host.' };
  return { ok: true, url };
}

export function sourceEligibility(source) {
  if (!source || source.active !== true) return { eligible: false, status: 'not_activated', reason: 'Source is inactive.' };
  if (source.review_status !== 'ready') return { eligible: false, status: 'not_activated', reason: 'Source still needs newsroom review.' };
  if (!SUPPORTED_INGESTION_SOURCE_TYPES.includes(source.source_type)) return { eligible: false, status: 'unsupported', reason: source.source_type === 'x_account' ? 'X ingestion is not implemented in V1.' : 'Source type is not supported by V1.' };
  const safe = isSafeFetchUrl(source.handle_or_url);
  if (!safe.ok) return { eligible: false, status: 'not_activated', reason: safe.reason || 'Source needs a usable HTTPS URL.' };
  return { eligible: true, status: source.ingestion_status === 'not_activated' ? 'ready' : source.ingestion_status, url: safe.url };
}

export function parseFeed(text, { contentType = '', rawDocument = text } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  if (contentType.toLowerCase().includes('json') || raw.startsWith('{')) return parseJsonFeed(raw, { rawDocument });
  const blocks = [...raw.matchAll(/<(item|entry)\b[^>]*>[\s\S]*?<\/\1>/gi)];
  return blocks.slice(0, MAX_FETCH_ITEMS).map(match => itemFromBlock(match[0], { atom: match[1].toLowerCase() === 'entry', rawDocument }));
}

export function parseJsonFeed(text, { rawDocument = text } = {}) {
  let document;
  try { document = JSON.parse(text); } catch { return []; }
  if (!document || !Array.isArray(document.items)) return [];
  return document.items.slice(0, MAX_FETCH_ITEMS).map(item => ({
    external_id: trim(item.id) || trim(item.url) || null,
    canonical_url: trim(item.url) || trim(item.external_url) || null,
    title: trim(item.title) || trim(item.url) || 'Untitled source item',
    raw_text: stripTags(item.content_html || item.content_text || item.summary || ''),
    summary: stripTags(item.summary || item.content_text || item.content_html || '').slice(0, 360),
    author_name: trim(item.author?.name || item.authors?.[0]?.name) || null,
    published_at: normalizeTimestamp(item.date_published || item.date_modified),
    media: [item.image, item.banner_image].filter(Boolean).map(url => ({ url: trim(url), type: null, width: null, height: null })),
    // Retain the normalized JSON Feed item without duplicating the full feed
    // document across every event in the batch.
    raw_payload: { item }
  }));
}

function htmlMeta(document, property) {
  return firstMatch(document, new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${property}["'][^>]*content\\s*=\\s*["']([^"']*)["'][^>]*>`, 'i'))
    || firstMatch(document, new RegExp(`<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${property}["'][^>]*>`, 'i'));
}

export function parseOfficialPage(document, { pageUrl, rawDocument = document } = {}) {
  const article = firstMatch(document, /<article\b[^>]*>([\s\S]*?)<\/article>/i) || document;
  const title = htmlMeta(document, 'og:title') || firstMatch(document, /<title\b[^>]*>([\s\S]*?)<\/title>/i) || stripTags(firstMatch(article, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i));
  const summary = htmlMeta(document, 'og:description') || htmlMeta(document, 'description') || stripTags(firstMatch(article, /<p\b[^>]*>([\s\S]*?)<\/p>/i)).slice(0, 360);
  const canonical = firstMatch(document, /<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*href\s*=\s*["']([^"']+)["'][^>]*>/i) || pageUrl;
  const published = htmlMeta(document, 'article:published_time') || firstMatch(document, /<(?:time|meta)\b[^>]*(?:datetime|content)\s*=\s*["']([^"']+)["'][^>]*>/i);
  const media = [htmlMeta(document, 'og:image')].filter(Boolean).map(url => ({ url, type: null, width: null, height: null }));
  return [{
    external_id: canonical,
    canonical_url: canonical,
    title: stripTags(title) || canonical,
    raw_text: stripTags(article),
    summary: stripTags(summary),
    author_name: htmlMeta(document, 'author') || null,
    published_at: normalizeTimestamp(published),
    media,
    raw_payload: { html: rawDocument, page_url: pageUrl }
  }];
}

export function discoverFeedUrl(document, pageUrl) {
  const base = new URL(pageUrl);
  for (const match of String(document || '').matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = match[1];
    const rel = attributeValue(attrs, 'rel').toLowerCase();
    const type = attributeValue(attrs, 'type').toLowerCase();
    if (rel.split(/\s+/).includes('alternate') && /(rss|atom|json)/i.test(type)) {
      try { return new URL(attributeValue(attrs, 'href'), base).href; } catch {}
    }
  }
  return '';
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function normalizeEvent(item, source, { now = new Date(), fetcher = 'rss', responseMetadata = {} } = {}) {
  const originalSourceUrl = trim(source.handle_or_url);
  const sourceUrl = canonicalizeUrl(originalSourceUrl) || originalSourceUrl;
  const canonicalUrl = canonicalizeUrl(item.canonical_url) || sourceUrl;
  const rawText = stripTags(item.raw_text || item.summary || item.title);
  const contentHash = await sha256([item.title, rawText, item.published_at || '', canonicalUrl].join('\n'));
  const discoveredAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const media = Array.isArray(item.media) ? item.media.filter(mediaItem => isSafeFetchUrl(mediaItem.url).ok).slice(0, 12) : [];
  return {
    source_id: source.id,
    source_type: source.source_type,
    external_id: trim(item.external_id) || canonicalUrl || contentHash,
    canonical_url: canonicalUrl || null,
    title: stripTags(item.title).slice(0, 1000) || 'Untitled source item',
    raw_text: rawText.slice(0, 100000),
    summary: stripTags(item.summary || rawText).slice(0, 4000),
    author_name: stripTags(item.author_name).slice(0, 500) || null,
    published_at: normalizeTimestamp(item.published_at),
    discovered_at: discoveredAt,
    fetched_at: discoveredAt,
    raw_payload: item.raw_payload || {},
    content_hash: contentHash,
    media,
    source_metadata: { source_url: originalSourceUrl, canonical_source_url: sourceUrl, fetcher, response: responseMetadata, primary_sections: source.primary_sections || [], topic_tags: source.topic_tags || [] },
    status: 'ingested',
    error: null
  };
}

export function duplicateEvent(existing, candidate) {
  return (existing || []).some(row => (candidate.external_id && row.external_id === candidate.external_id)
    || (candidate.canonical_url && row.canonical_url === candidate.canonical_url)
    || (candidate.content_hash && row.content_hash === candidate.content_hash));
}

export function backoffSeconds({ pollIntervalSeconds = 3600, failureCount = 0, maxSeconds = 86400 } = {}) {
  return Math.min(maxSeconds, Math.max(60, Number(pollIntervalSeconds) || 3600) * (2 ** Math.min(8, Math.max(0, Number(failureCount) || 0))));
}

export function selectPollSources(sources, { now = new Date(), limit = 3 } = {}) {
  const time = new Date(now).getTime();
  return (sources || []).filter(source => {
    const eligibility = sourceEligibility(source);
    if (!eligibility.eligible) return false;
    if (source.ingestion_status === 'polling') return false;
    return !source.ingestion_next_eligible_at || new Date(source.ingestion_next_eligible_at).getTime() <= time;
  }).sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) || new Date(a.ingestion_next_eligible_at || 0) - new Date(b.ingestion_next_eligible_at || 0)).slice(0, Math.max(0, limit));
}

async function readLimited(response, { maxBytes = MAX_FETCH_BYTES } = {}) {
  const advertised = Number(response.headers.get('content-length') || 0);
  if (advertised > maxBytes) throw Object.assign(new Error('Source response exceeds the configured payload limit.'), { code: 'PAYLOAD_TOO_LARGE' });
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw Object.assign(new Error('Source response exceeds the configured payload limit.'), { code: 'PAYLOAD_TOO_LARGE' });
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw Object.assign(new Error('Source response exceeds the configured payload limit.'), { code: 'PAYLOAD_TOO_LARGE' }); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

async function fetchSafe(url, { fetchImpl = fetch, headers = {}, expectedHostname = null, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = {}) {
  let current = url;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const safe = isSafeFetchUrl(current, { expectedHostname });
    if (!safe.ok) throw Object.assign(new Error(safe.reason), { code: 'SSRF_BLOCKED' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, { method: 'GET', headers: { accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/html;q=0.9, */*;q=0.1', 'user-agent': 'AnywaysSourceIngestion/1.0', ...headers }, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error('Source request timed out.'), { code: 'FETCH_TIMEOUT' });
      throw error;
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirect === MAX_REDIRECTS) throw Object.assign(new Error('Source redirected too many times.'), { code: 'UNSAFE_REDIRECT' });
      current = new URL(location, current).href;
      continue;
    }
    if (response.status === 304) return { response, text: '', url: current, notModified: true };
    if (!response.ok) throw Object.assign(new Error(`Source returned HTTP ${response.status}.`), { code: 'HTTP_ERROR', status: response.status });
    const text = await readLimited(response, { maxBytes });
    return { response, text, url: current, notModified: false };
  }
  throw Object.assign(new Error('Source request was not completed.'), { code: 'FETCH_FAILED' });
}

export async function fetchSource(source, { fetchImpl = fetch, now = new Date(), timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = {}) {
  const eligibility = sourceEligibility(source);
  if (!eligibility.eligible) throw Object.assign(new Error(eligibility.reason), { code: eligibility.status === 'unsupported' ? 'UNSUPPORTED_SOURCE' : 'SOURCE_NOT_READY' });
  const baseUrl = eligibility.url.href;
  const conditional = {};
  if (source.ingestion_etag) conditional['if-none-match'] = source.ingestion_etag;
  if (source.ingestion_last_modified) conditional['if-modified-since'] = source.ingestion_last_modified;
  const first = await fetchSafe(baseUrl, { fetchImpl, headers: conditional, expectedHostname: eligibility.url.hostname, timeoutMs, maxBytes });
  if (first.notModified) return { items: [], notModified: true, fetcher: 'conditional', url: first.url, responseMetadata: { status: 304, etag: source.ingestion_etag || null, last_modified: source.ingestion_last_modified || null } };
  const contentType = first.response.headers.get('content-type') || '';
  const responseMetadata = { status: first.response.status, content_type: contentType, etag: first.response.headers.get('etag'), last_modified: first.response.headers.get('last-modified'), fetched_url: first.url };
  const parsedFeed = parseFeed(first.text, { contentType, rawDocument: first.text });
  if (parsedFeed.length || /(?:rss|atom|feed\+json|json)/i.test(contentType) || /<(?:(?:rss|feed|feedburner):)?(?:rss|feed|channel|entry)/i.test(first.text.slice(0, 1000))) {
    return { items: parsedFeed, fetcher: contentType.includes('json') ? 'json_feed' : /atom/i.test(contentType) || /<feed\b/i.test(first.text.slice(0, 1000)) ? 'atom' : 'rss', url: first.url, responseMetadata };
  }
  const discoveredFeed = source.source_type === 'rss' ? '' : discoverFeedUrl(first.text, first.url);
  if (discoveredFeed) {
    const feed = await fetchSafe(discoveredFeed, { fetchImpl, expectedHostname: eligibility.url.hostname, timeoutMs, maxBytes });
    const feedType = feed.response.headers.get('content-type') || '';
    const items = parseFeed(feed.text, { contentType: feedType, rawDocument: feed.text });
    if (items.length) return { items, fetcher: feedType.includes('json') ? 'json_feed' : /atom/i.test(feedType) || /<feed\b/i.test(feed.text.slice(0, 1000)) ? 'atom' : 'rss', url: feed.url, responseMetadata: { ...responseMetadata, feed_url: feed.url, feed_etag: feed.response.headers.get('etag'), feed_last_modified: feed.response.headers.get('last-modified') } };
  }
  if (source.source_type === 'blog' && source.primary_class !== 'official') throw Object.assign(new Error('HTML fallback is limited to configured official blogs and newsrooms.'), { code: 'UNSUPPORTED_SOURCE' });
  if (source.source_type === 'rss') throw Object.assign(new Error('Configured RSS source did not contain a supported feed.'), { code: 'INVALID_FEED' });
  return { items: parseOfficialPage(first.text, { pageUrl: first.url, rawDocument: first.text }), fetcher: 'official_html', url: first.url, responseMetadata };
}

export async function fetchOfficialEvidencePage(pageUrl, { source, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_FETCH_BYTES } = {}) {
  const eligibility = sourceEligibility(source);
  if (!eligibility.eligible || source?.trust_level !== 'official') throw Object.assign(new Error('Only active, reviewed official sources may provide Luna enrichment.'), { code: 'OFFICIAL_SOURCE_REQUIRED' });
  const safe = isSafeFetchUrl(pageUrl, { expectedHostname: eligibility.url.hostname });
  if (!safe.ok) throw Object.assign(new Error(safe.reason), { code: 'SSRF_BLOCKED' });
  const fetched = await fetchSafe(safe.url.href, { fetchImpl, expectedHostname: eligibility.url.hostname, timeoutMs, maxBytes });
  const item = parseOfficialPage(fetched.text, { pageUrl: fetched.url, rawDocument: fetched.text })[0];
  const canonical = canonicalizeUrl(item?.canonical_url) || canonicalizeUrl(fetched.url);
  const canonicalSafe = isSafeFetchUrl(canonical, { expectedHostname: eligibility.url.hostname });
  if (!canonicalSafe.ok) throw Object.assign(new Error('Official page canonical URL is outside the configured source host.'), { code: 'OFFICIAL_CANONICAL_HOST_MISMATCH' });
  return {
    requested_url: safe.url.href,
    fetched_url: fetched.url,
    canonical_url: canonicalSafe.url.href,
    title: item?.title || fetched.url,
    summary: item?.summary || '',
    raw_text: item?.raw_text || '',
    published_at: item?.published_at || null,
    author_name: item?.author_name || null,
    media: Array.isArray(item?.media) ? item.media.slice(0, 12) : [],
    source_id: source.id,
    source_name: source.public_display_name || source.name || '',
    source_type: source.source_type,
    fetched_at: new Date().toISOString(),
    response_metadata: { status: fetched.response.status, content_type: fetched.response.headers.get('content-type') || '', fetched_url: fetched.url }
  };
}
