import assert from 'node:assert/strict';
import test from 'node:test';
import { ResearchRouter, createProviders, dedupeSearchResults, normalizeSearchQuery, scoreSearchCoverage } from '../src/pipeline/research-router.mjs';

const config = overrides => ({ paidUsageAllowed:false, maxSearchRequestsPerArticle:40, maxSearchRequestsPerQuery:3, maxSourcePagesPerArticle:25, maxResultsPerSearch:10, minimumPrimarySources:2, minimumIndependentSources:3, minimumUsefulResultsBeforeEscalation:4, cacheSearchResults:true, cacheFetchedPages:true, browserSearchEnabled:false, cacheFile:'unused', providerOrder:['cache','direct','brave','exa','tavily','browser'], providerCostsUsd:{ brave:0, exa:0, tavily:0, browser:0 }, ...overrides });
const result = (provider, suffix) => ({ title:`Result ${suffix}`, url:`https://${suffix}.example.test/article`, snippet:`Research ${suffix}`, provider });
class MemoryCache {
  constructor() { this.searches = new Map(); this.pages = new Map(); }
  async getSearch(key) { return this.searches.get(key) || null; }
  async putSearch(key, value) { this.searches.set(key, value); }
  async getPage(url) { return this.pages.get(url) || null; }
  async putPage(url, value) { this.pages.set(url, value); }
}
const fakeProvider = (id, fn) => ({ id, isAvailable: () => true, search: fn });

test('research router normalizes, deduplicates, and scores coverage deterministically', () => {
  assert.deepEqual(normalizeSearchQuery({ text:'  AI  newsletters ', domains:['Example.com','example.com'], maxResults:99 }), { text:'ai newsletters', type:'general', domains:['example.com'], excludeDomains:[], dateFrom:null, dateTo:null, maxResults:10 });
  const results = dedupeSearchResults([result('brave','one'), { ...result('exa','one'), url:'https://one.example.test/article?utm_source=x' }]);
  assert.equal(results.length, 1);
  assert.equal(scoreSearchCoverage(results, { text:'research one' }, config()).shouldEscalate, true);
});

test('research router checks cache first, escalates from weak Brave to Exa, and avoids Tavily after adequate coverage', async () => {
  const calls = []; const cache = new MemoryCache();
  const router = new ResearchRouter({ config:config(), cache, logger:() => {}, providers:{
    brave:fakeProvider('brave', async () => { calls.push('brave'); return [result('brave','one')]; }),
    exa:fakeProvider('exa', async () => { calls.push('exa'); return [result('exa','two'), result('exa','three'), result('exa','four')]; }),
    tavily:fakeProvider('tavily', async () => { calls.push('tavily'); return [result('tavily','five')]; }),
    browser:{ isAvailable:() => false, search:async () => [] }
  } });
  const first = await router.search({ text:'research', type:'news' }, { runId:'run-1' });
  assert.deepEqual(calls, ['brave','exa']); assert.equal(first.results.length, 4); assert.equal(first.coverage.shouldEscalate, false); assert.equal(first.usage.searchRequests, 2);
  const second = await router.search({ text:'research', type:'news' }, { runId:'run-2' });
  assert.deepEqual(calls, ['brave','exa']); assert.equal(second.usage.cachedSearches, 2);
});

test('research router enforces request and page budgets and quarantines quota/auth failures for a run', async () => {
  let braveCalls = 0, exaCalls = 0;
  const router = new ResearchRouter({ config:config({ maxSearchRequestsPerArticle:2, maxSourcePagesPerArticle:1 }), cache:new MemoryCache(), logger:() => {}, providers:{
    brave:fakeProvider('brave', async () => { braveCalls++; const error = new Error('unauthorized'); error.status = 401; throw error; }),
    exa:fakeProvider('exa', async () => { exaCalls++; return [result('exa','two')]; }), tavily:{isAvailable:()=>false,search:async()=>[]}, browser:{isAvailable:()=>false,search:async()=>[]}
  } });
  const searched = await router.search({ text:'test topic' }, { runId:'run-budget' });
  assert.equal(braveCalls, 1); assert.equal(exaCalls, 1); assert.match(searched.warnings.join(' '), /brave: HTTP 401/);
  const pages = await router.fetchPages([result('exa','two'), result('exa','three')], { runId:'run-budget', fetcher:async url => ({ ok:true, canonical_url:url, url, text:'evidence' }) });
  assert.equal(pages.pages.length, 1); assert.equal(pages.usage.pagesFetched, 1);
});

test('missing provider keys leave optional API providers unavailable without crashing', () => {
  const providers = createProviders({ env:{ RESEARCH_BROWSER_SEARCH_ENABLED:'false' }, fetchImpl:async () => { throw new Error('should not fetch'); } });
  assert.equal(providers.brave.isAvailable(), false); assert.equal(providers.exa.isAvailable(), false); assert.equal(providers.tavily.isAvailable(), false); assert.equal(providers.browser.isAvailable(), false);
});
