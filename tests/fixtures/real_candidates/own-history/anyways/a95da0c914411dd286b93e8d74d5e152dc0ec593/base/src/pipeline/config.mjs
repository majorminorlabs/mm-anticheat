import { existsSync } from 'node:fs';
import path from 'node:path';

const bool = (value, fallback) => value === undefined ? fallback : /^(1|true|yes)$/i.test(value);
const positiveInt = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const codexExecutable = () => {
  if (process.env.ANYWAYS_CODEX_BIN) return process.env.ANYWAYS_CODEX_BIN;
  const candidates = [
    path.join(path.dirname(process.execPath), 'codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex'
  ];
  return candidates.find(existsSync) || 'codex';
};

export const RESEARCH_CONFIG = Object.freeze({
  paidUsageAllowed: bool(process.env.RESEARCH_PAID_USAGE_ALLOWED, false),
  maxSearchRequestsPerArticle: positiveInt(process.env.RESEARCH_MAX_SEARCH_REQUESTS_PER_ARTICLE, 40),
  maxSearchRequestsPerQuery: positiveInt(process.env.RESEARCH_MAX_SEARCH_REQUESTS_PER_QUERY, 3),
  maxSourcePagesPerArticle: positiveInt(process.env.RESEARCH_MAX_SOURCE_PAGES_PER_ARTICLE, 25),
  maxResultsPerSearch: positiveInt(process.env.RESEARCH_MAX_RESULTS_PER_SEARCH, 10),
  searchTimeoutMs: positiveInt(process.env.RESEARCH_SEARCH_TIMEOUT_MS, 15_000),
  minimumPrimarySources: positiveInt(process.env.RESEARCH_MINIMUM_PRIMARY_SOURCES, 2),
  minimumIndependentSources: positiveInt(process.env.RESEARCH_MINIMUM_INDEPENDENT_SOURCES, 3),
  minimumUsefulResultsBeforeEscalation: positiveInt(process.env.RESEARCH_MINIMUM_USEFUL_RESULTS_BEFORE_ESCALATION, 4),
  cacheSearchResults: bool(process.env.RESEARCH_CACHE_SEARCH_RESULTS, true),
  cacheFetchedPages: bool(process.env.RESEARCH_CACHE_FETCHED_PAGES, true),
  browserSearchEnabled: bool(process.env.RESEARCH_BROWSER_SEARCH_ENABLED, true),
  cacheFile: process.env.RESEARCH_CACHE_FILE || 'pipeline-state/research-cache.json',
  providerOrder: Object.freeze(['cache', 'direct', 'brave', 'exa', 'tavily', 'browser']),
  providerCostsUsd: Object.freeze({ brave: 0, exa: 0, tavily: 0, browser: 0 })
});

export const PIPELINE_CONFIG = Object.freeze({
  adapter: 'ollama',
  defaultModel: 'qwen3:14b',
  comparisonModels: Object.freeze(['mistral-small3.2:24b']),
  ollamaUrl: process.env.ANYWAYS_OLLAMA_URL || 'http://127.0.0.1:11434',
  codexExecutable: codexExecutable(),
  pitchModel: process.env.ANYWAYS_PITCH_MODEL || 'gpt-5.6-terra',
  pitchReasoningEffort: process.env.ANYWAYS_PITCH_REASONING_EFFORT || 'medium',
  pitchTimeoutMs: positiveInt(process.env.ANYWAYS_PITCH_TIMEOUT_MS, 600_000),
  localWriterModel: process.env.ANYWAYS_LOCAL_WRITER_MODEL || 'qwen3:14b',
  artifactDir: process.env.ANYWAYS_PIPELINE_ARTIFACT_DIR || 'pipeline-artifacts',
  requestTimeoutMs: 300_000,
  synthesis: Object.freeze({ sourceFacts: 2, normalizedFacts: 20, conflicts: 8, uncertainties: 8, missingEvidence: 8, excludedClaims: 8, sourcesPerFact: 5, sourceTokens: 520, conflictTokens: 1000, angleTokens: 900, sourceBatchChars: 2_800, recoverySourceChars: 1_500, sourceContextTokens: 1_100, sourceResponseTokens: 520 })
});
