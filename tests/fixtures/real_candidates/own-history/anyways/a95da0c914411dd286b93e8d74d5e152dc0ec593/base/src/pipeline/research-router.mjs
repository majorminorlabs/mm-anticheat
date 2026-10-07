import fs from 'node:fs/promises';
import path from 'node:path';
import { RESEARCH_CONFIG } from './config.mjs';
import { normalizeUrl } from './acquisition.mjs';

const now = () => new Date().toISOString();
const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const words = value => new Set(clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(word => word.length > 2));
const domain = value => { try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };
const primaryDomain = value => /\.(gov|edu)$/i.test(domain(value)) || /(?:sec\.gov|justice\.gov|congress\.gov|who\.int|europa\.eu|arxiv\.org|nature\.com|nih\.gov)$/i.test(domain(value));
const ttlFor = type => type === 'news' ? 6 * 3600_000 : type === 'academic' ? 30 * 24 * 3600_000 : 7 * 24 * 3600_000;

export function normalizeSearchQuery(query = {}, config = RESEARCH_CONFIG) {
  return {
    text: clean(query.text).toLowerCase(), type: query.type || 'general',
    domains: [...new Set((query.domains || []).map(value => clean(value).toLowerCase()).filter(Boolean))].sort(),
    excludeDomains: [...new Set((query.excludeDomains || []).map(value => clean(value).toLowerCase()).filter(Boolean))].sort(),
    dateFrom: query.dateFrom || null, dateTo: query.dateTo || null,
    maxResults: Math.max(1, Math.min(Number(query.maxResults) || config.maxResultsPerSearch, config.maxResultsPerSearch))
  };
}
export function searchCacheKey(query, provider) { return JSON.stringify({ provider, ...normalizeSearchQuery(query) }); }
export function dedupeSearchResults(results = []) {
  const seen = new Set();
  return results.flatMap(item => { try { const url = normalizeUrl(item.url); if (seen.has(url)) return []; seen.add(url); return [{ ...item, title: clean(item.title), url, snippet: clean(item.snippet), provider: item.provider || 'unknown', sourceType: item.sourceType || null }]; } catch { return []; } });
}
export function scoreSearchCoverage(results = [], query = {}, config = RESEARCH_CONFIG) {
  const deduped = dedupeSearchResults(results); const queryWords = words(query.text); const domains = new Set(deduped.map(item => domain(item.url)).filter(Boolean));
  const relevant = deduped.filter(item => !queryWords.size || [...queryWords].some(word => words(`${item.title} ${item.snippet}`).has(word)));
  const primary = deduped.filter(item => primaryDomain(item.url));
  const reasons = [];
  if (relevant.length < config.minimumUsefulResultsBeforeEscalation) reasons.push('too_few_relevant_results');
  if (domains.size < config.minimumIndependentSources) reasons.push('too_few_independent_domains');
  if (query.type === 'primary' && primary.length < config.minimumPrimarySources) reasons.push('too_few_primary_sources');
  return { usefulResultCount: relevant.length, uniqueDomainCount: domains.size, primarySourceCount: primary.length, independentSourceCount: domains.size, shouldEscalate: reasons.length > 0, reasons };
}

export class FileResearchCache {
  constructor(file = RESEARCH_CONFIG.cacheFile) { this.file = file; this.data = null; }
  async load() { if (this.data) return this.data; try { this.data = JSON.parse(await fs.readFile(this.file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; this.data = { searches: {}, pages: {} }; } this.data.searches ||= {}; this.data.pages ||= {}; return this.data; }
  async getSearch(key) { const data = await this.load(); const entry = data.searches[key]; return entry && Date.parse(entry.expires_at) > Date.now() ? entry : null; }
  async putSearch(key, entry) { const data = await this.load(); data.searches[key] = entry; await this.save(); }
  async getPage(url) { const data = await this.load(); const entry = data.pages[url]; return entry && Date.parse(entry.expires_at) > Date.now() ? entry : null; }
  async putPage(url, entry) { const data = await this.load(); data.pages[url] = entry; await this.save(); }
  async save() { await fs.mkdir(path.dirname(this.file), { recursive: true }); await fs.writeFile(this.file, JSON.stringify(this.data, null, 2)); }
}

async function fetchJson(url, options, fetchImpl, timeoutMs = RESEARCH_CONFIG.searchTimeoutMs) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { const response = await fetchImpl(url, { ...options, signal: controller.signal }); const body = await response.text(); let json; try { json = body ? JSON.parse(body) : {}; } catch { json = {}; }
    if (!response.ok) { const error = new Error(`HTTP ${response.status}`); error.status = response.status; error.body = json; throw error; }
    return json;
  } finally { clearTimeout(timer); }
}
const provider = (id, available, search) => ({ id, isAvailable: available, search });
export function createProviders({ fetchImpl = fetch, env = process.env, browserSearch } = {}) {
  const brave = provider('brave', () => Boolean(env.BRAVE_SEARCH_API_KEY), async query => {
    const params = new URLSearchParams({ q: query.text, count: String(query.maxResults) }); if (query.domains.length) params.set('site', query.domains.join(','));
    const data = await fetchJson(`https://api.search.brave.com/res/v1/web/search?${params}`, { headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_SEARCH_API_KEY } }, fetchImpl);
    return (data.web?.results || []).map((item, rank) => ({ title: item.title, url: item.url, snippet: item.description, publishedAt: item.age || null, provider: 'brave', rank: rank + 1 }));
  });
  const exa = provider('exa', () => Boolean(env.EXA_API_KEY), async query => {
    const data = await fetchJson('https://api.exa.ai/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.EXA_API_KEY }, body: JSON.stringify({ query: query.text, numResults: query.maxResults, includeDomains: query.domains.length ? query.domains : undefined, excludeDomains: query.excludeDomains.length ? query.excludeDomains : undefined, type: query.type === 'news' ? 'auto' : 'auto' }) }, fetchImpl);
    return (data.results || []).map((item, rank) => ({ title: item.title, url: item.url, snippet: item.text || item.highlights?.join(' ') || '', publishedAt: item.publishedDate || null, provider: 'exa', rank: rank + 1 }));
  });
  const tavily = provider('tavily', () => Boolean(env.TAVILY_API_KEY), async query => {
    const data = await fetchJson('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ api_key: env.TAVILY_API_KEY, query: query.text, max_results: query.maxResults, search_depth: 'basic', include_domains: query.domains, exclude_domains: query.excludeDomains, topic: query.type === 'news' ? 'news' : 'general' }) }, fetchImpl);
    return (data.results || []).map((item, rank) => ({ title: item.title, url: item.url, snippet: item.content || '', publishedAt: item.published_date || null, provider: 'tavily', rank: rank + 1 }));
  });
  // This deliberately stays a low-volume last resort. It uses a public HTML
  // result page only when no configured research API can provide coverage; it
  // is not a general-purpose scraping engine or a replacement for Playwright.
  const browser = provider('browser', () => Boolean(browserSearch) || env.RESEARCH_BROWSER_SEARCH_ENABLED !== 'false', async query => {
    if (browserSearch) return browserSearch(query);
    const response = await fetchImpl(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query.text }).toString()}`, { headers: { 'user-agent': 'AnywaysLocalResearch/1.0 (+local operator)' } });
    const html = await response.text(); if (!response.ok) { const error = new Error(`HTTP ${response.status}`); error.status = response.status; throw error; }
    return [...html.matchAll(/<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0, query.maxResults).map((match, rank) => { const raw = match[1].replace(/&amp;/g, '&'); try { const parsed = new URL(raw, 'https://html.duckduckgo.com'); return { title: clean(match[2].replace(/<[^>]+>/g, ' ')), url: parsed.searchParams.get('uddg') || parsed.href, snippet: '', provider: 'browser', rank: rank + 1 }; } catch { return null; } }).filter(Boolean);
  });
  return { brave, exa, tavily, browser };
}

export class ResearchRouter {
  constructor({ config = RESEARCH_CONFIG, cache = new FileResearchCache(config.cacheFile), providers = createProviders(), logger = console.info } = {}) {
    this.config = config; this.cache = cache; this.providers = providers; this.logger = logger; this.runs = new Map(); this.disabled = new Map();
    this.logger(`Research providers: cache: enabled; brave: ${providers.brave?.isAvailable() ? 'enabled' : 'disabled, missing API key'}; exa: ${providers.exa?.isAvailable() ? 'enabled' : 'disabled, missing API key'}; tavily: ${providers.tavily?.isAvailable() ? 'enabled' : 'disabled, missing API key'}; browser-search: ${config.browserSearchEnabled && providers.browser?.isAvailable() ? 'enabled' : 'disabled'}; firecrawl: disabled, optional`);
  }
  usage(runId = 'default') { if (!this.runs.has(runId)) this.runs.set(runId, { searchRequests: 0, cachedSearches: 0, pagesFetched: 0, providerUsage: {}, estimatedSearchCostUsd: 0, budgetReached: false, entries: [] }); return this.runs.get(runId); }
  summary(runId) { const usage = this.usage(runId); return { ...usage, providerUsage: { ...usage.providerUsage }, entries: [...usage.entries] }; }
  canSearch(usage) { if (usage.searchRequests >= this.config.maxSearchRequestsPerArticle) { usage.budgetReached = true; return false; } return true; }
  record(usage, providerId, resultCount, cached = false) { if (cached) usage.cachedSearches++; else { usage.searchRequests++; usage.providerUsage[providerId] = (usage.providerUsage[providerId] || 0) + 1; usage.estimatedSearchCostUsd += this.config.providerCostsUsd[providerId] || 0; } usage.entries.push({ provider: providerId, operation: 'search', requestCount: cached ? 0 : 1, resultCount, cached, timestamp: now(), estimatedCostUsd: cached ? 0 : this.config.providerCostsUsd[providerId] || 0 }); }
  async search(input, context = {}) {
    const query = normalizeSearchQuery(input, this.config); if (!query.text) throw new Error('Research search requires text.'); const runId = context.runId || context.storyId || 'default'; const usage = this.usage(runId); const warnings = []; const all = []; let requestsForQuery = 0;
    const direct = dedupeSearchResults(context.directResults || []).map(item => ({ ...item, provider: item.provider || 'direct' })); if (direct.length) { all.push(...direct); this.record(usage, 'direct', direct.length, true); }
    for (const providerId of this.config.providerOrder.filter(id => !['cache', 'direct'].includes(id))) {
      const coverage = scoreSearchCoverage(all, query, this.config); if (all.length && !coverage.shouldEscalate) break;
      if (requestsForQuery >= this.config.maxSearchRequestsPerQuery || !this.canSearch(usage)) break;
      if (providerId === 'browser' && !this.config.browserSearchEnabled) continue;
      const item = this.providers[providerId]; if (!item || !item.isAvailable() || this.disabled.get(`${runId}:${providerId}`)) continue;
      const key = searchCacheKey(query, providerId); const cached = this.config.cacheSearchResults ? await this.cache.getSearch(key) : null;
      if (cached) { all.push(...cached.results); this.record(usage, providerId, cached.results.length, true); continue; }
      let attempts = 0;
      while (attempts++ < 2) try {
        if (!this.canSearch(usage)) break;
        this.record(usage, providerId, 0); requestsForQuery++;
        const results = dedupeSearchResults(await item.search(query, context));
        usage.entries.at(-1).resultCount = results.length; all.push(...results); if (this.config.cacheSearchResults) await this.cache.putSearch(key, { results, created_at: now(), expires_at: new Date(Date.now() + ttlFor(query.type)).toISOString() });
        break;
      } catch (error) {
        const status = Number(error.status || 0); const permanent = status === 401 || status === 403 || status === 429; if (permanent || attempts === 2) { warnings.push(`${providerId}: ${status ? `HTTP ${status}` : error.message}`); if (permanent) this.disabled.set(`${runId}:${providerId}`, true); break; }
      }
    }
    const results = dedupeSearchResults(all).slice(0, query.maxResults * 3); const coverage = scoreSearchCoverage(results, query, this.config);
    if (usage.budgetReached) warnings.push('research search budget reached');
    return { query: query.text, results, coverage, warnings, usage: this.summary(runId) };
  }
  async fetchPages(results, { runId, fetcher, maxPages = this.config.maxSourcePagesPerArticle } = {}) {
    const usage = this.usage(runId); const pages = []; const warnings = [];
    for (const item of dedupeSearchResults(results)) {
      if (pages.length >= maxPages || usage.pagesFetched >= this.config.maxSourcePagesPerArticle) break;
      const cached = this.config.cacheFetchedPages ? await this.cache.getPage(item.url) : null;
      if (cached?.document?.ok) { pages.push({ ...cached.document, search_result: item, cached: true }); continue; }
      try { const document = await fetcher(item.url); usage.pagesFetched++; if (document.ok && document.text?.trim()) { pages.push({ ...document, search_result: item, cached: false }); if (this.config.cacheFetchedPages) await this.cache.putPage(item.url, { document, created_at: now(), expires_at: new Date(Date.now() + ttlFor('general')).toISOString() }); } else warnings.push(`${item.url}: ${document.error || 'unusable page'}`); } catch (error) { usage.pagesFetched++; warnings.push(`${item.url}: ${error.message}`); }
    }
    return { pages, warnings, usage: this.summary(runId) };
  }
}
