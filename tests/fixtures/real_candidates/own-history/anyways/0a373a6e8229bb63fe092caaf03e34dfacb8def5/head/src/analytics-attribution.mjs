const TRACKING_PARAMETERS = Object.freeze(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']);

const KNOWN_REFERRERS = Object.freeze([
  ['x', ['x.com', 'twitter.com', 't.co']],
  ['google', ['google.']],
  ['bing', ['bing.com']],
  ['duckduckgo', ['duckduckgo.com']],
  ['reddit', ['reddit.com', 'redd.it']],
  ['discord', ['discord.com', 'discordapp.com']],
  ['telegram', ['telegram.me', 't.me']]
]);

export function normalizeAttributionValue(value, max = 80) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

export function normalizedHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isKnownHost(hostname, candidate) {
  return hostname === candidate || hostname.endsWith(`.${candidate}`) || candidate.endsWith('.') && hostname.includes(candidate);
}

export function sourceForReferrer(referrer, siteOrigin = '') {
  const hostname = normalizedHostname(referrer);
  if (!hostname) return null;
  try {
    if (siteOrigin && new URL(referrer).origin === new URL(siteOrigin).origin) return null;
  } catch {}
  for (const [source, hosts] of KNOWN_REFERRERS) {
    if (hosts.some(host => isKnownHost(hostname, host))) {
      return { source, medium: ['google', 'bing', 'duckduckgo'].includes(source) ? 'organic' : 'referral', referrer_host: hostname };
    }
  }
  return { source: hostname, medium: 'referral', referrer_host: hostname };
}

export function resolveAttribution({ url, referrer = '', siteOrigin = '' } = {}) {
  const landingUrl = new URL(url || '/', siteOrigin || 'https://anyways.media');
  const explicit = Object.fromEntries(TRACKING_PARAMETERS.map(name => [name, normalizeAttributionValue(landingUrl.searchParams.get(name))]));
  if (explicit.utm_source) {
    return {
      source: explicit.utm_source,
      medium: explicit.utm_medium || 'none',
      campaign: explicit.utm_campaign || null,
      content: explicit.utm_content || null,
      referrer_host: sourceForReferrer(referrer, siteOrigin)?.referrer_host || null
    };
  }
  const referrerAttribution = sourceForReferrer(referrer, siteOrigin);
  if (referrerAttribution) return { ...referrerAttribution, campaign: null, content: null };
  return { source: 'direct', medium: 'none', campaign: null, content: null, referrer_host: null };
}

export function createShareUrl(articleUrl, source, options = {}) {
  const url = new URL(articleUrl, options.baseUrl || 'https://anyways.media');
  for (const name of TRACKING_PARAMETERS) url.searchParams.delete(name);
  const normalizedSource = normalizeAttributionValue(source);
  if (!normalizedSource) throw new Error('A share source is required.');
  url.searchParams.set('utm_source', normalizedSource);
  url.searchParams.set('utm_medium', normalizeAttributionValue(options.medium || 'share') || 'share');
  url.searchParams.set('utm_campaign', normalizeAttributionValue(options.campaign || 'share') || 'share');
  const content = normalizeAttributionValue(options.content);
  if (content) url.searchParams.set('utm_content', content);
  return url.toString();
}

export function removeTrackingParameters(url) {
  const clean = new URL(url);
  let changed = false;
  for (const name of TRACKING_PARAMETERS) {
    if (clean.searchParams.has(name)) {
      clean.searchParams.delete(name);
      changed = true;
    }
  }
  return { changed, url: clean };
}
