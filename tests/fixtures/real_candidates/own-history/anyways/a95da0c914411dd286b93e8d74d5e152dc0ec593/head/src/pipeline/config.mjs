import { accessSync, constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const bool = (value, fallback) => value === undefined ? fallback : /^(1|true|yes)$/i.test(value);
const positiveInt = (value, fallback) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const executable = file => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const codexExecutable = () => {
  if (process.env.ANYWAYS_CODEX_BIN) {
    const configured = process.env.ANYWAYS_CODEX_BIN.trim();
    if (!path.isAbsolute(configured)) throw new Error('ANYWAYS_CODEX_BIN must be an absolute executable path.');
    return configured;
  }
  const candidates = [
    path.join(path.dirname(process.execPath), 'codex'),
    '/Applications/ChatGPT.app/Contents/Resources/codex'
  ];
  return candidates.find(candidate => existsSync(candidate) && executable(candidate)) || candidates[0];
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
  pipelineV1Enabled: bool(process.env.PIPELINE_V1_ENABLED, false),
  discoveryModel: process.env.ANYWAYS_DISCOVERY_MODEL || 'gpt-5.6-luna',
  discoveryReasoning: process.env.ANYWAYS_DISCOVERY_REASONING || 'high',
  researchModel: process.env.ANYWAYS_RESEARCH_MODEL || 'gpt-5.6-terra',
  researchReasoning: process.env.ANYWAYS_RESEARCH_REASONING || 'high',
  draftModel: process.env.ANYWAYS_DRAFT_MODEL || 'gpt-5.6-luna',
  draftReasoning: process.env.ANYWAYS_DRAFT_REASONING || 'high',
  polishModel: process.env.ANYWAYS_POLISH_MODEL || 'gpt-5.6-sol',
  polishReasoning: process.env.ANYWAYS_POLISH_REASONING || 'medium',
  pitchModel: process.env.ANYWAYS_DISCOVERY_MODEL || process.env.ANYWAYS_PITCH_MODEL || 'gpt-5.6-luna',
  pitchReasoningEffort: process.env.ANYWAYS_DISCOVERY_REASONING || process.env.ANYWAYS_PITCH_REASONING_EFFORT || 'high',
  pitchTimeoutMs: positiveInt(process.env.ANYWAYS_PITCH_TIMEOUT_MS, 600_000),
  localWriterModel: process.env.ANYWAYS_LOCAL_WRITER_MODEL || 'qwen3:14b',
  artifactDir: process.env.ANYWAYS_PIPELINE_ARTIFACT_DIR || 'pipeline-artifacts',
  requestTimeoutMs: 300_000,
  synthesis: Object.freeze({ sourceFacts: 2, normalizedFacts: 20, conflicts: 8, uncertainties: 8, missingEvidence: 8, excludedClaims: 8, sourcesPerFact: 5, sourceTokens: 520, conflictTokens: 1000, angleTokens: 900, sourceBatchChars: 2_800, recoverySourceChars: 1_500, sourceContextTokens: 1_100, sourceResponseTokens: 520 })
});

export const PRODUCTION_CODEX_PROVIDER = Object.freeze({
  id: 'codex',
  executable: codexExecutable(),
  authFile: process.env.ANYWAYS_CODEX_AUTH_FILE || path.join(os.homedir(), '.codex', 'auth.json'),
  expectedCliVersion: process.env.ANYWAYS_CODEX_CLI_VERSION || 'codex-cli 0.146.0',
  generationDeadlineMs: positiveInt(process.env.ANYWAYS_CODEX_GENERATION_DEADLINE_MS, 600_000),
  killGraceMs: positiveInt(process.env.ANYWAYS_CODEX_KILL_GRACE_MS, 2_000),
  creditUsd: positiveNumber(process.env.ANYWAYS_CODEX_CREDIT_USD, null)
});

export const PRODUCTION_MODELS = Object.freeze({
  discovery: Object.freeze({ provider: 'codex', model: PIPELINE_CONFIG.discoveryModel, reasoning: PIPELINE_CONFIG.discoveryReasoning, roles: Object.freeze(['discovery', 'pitch']) }),
  research: Object.freeze({ provider: 'codex', model: PIPELINE_CONFIG.researchModel, reasoning: PIPELINE_CONFIG.researchReasoning, roles: Object.freeze(['research', 'evidence_selection']) }),
  draft: Object.freeze({ provider: 'codex', model: PIPELINE_CONFIG.draftModel, reasoning: PIPELINE_CONFIG.draftReasoning, roles: Object.freeze(['article_draft']) }),
  polish: Object.freeze({ provider: 'codex', model: PIPELINE_CONFIG.polishModel, reasoning: PIPELINE_CONFIG.polishReasoning, roles: Object.freeze(['manual_copy_polish']) }),
  // Compatibility aliases for historical Phase 2 artifacts and tests.
  terraHigh: Object.freeze({ provider: 'codex', model: PIPELINE_CONFIG.researchModel, reasoning: PIPELINE_CONFIG.researchReasoning, roles: Object.freeze(['research_planning', 'evidence_selection']) }),
  lunaHigh: Object.freeze({ provider: 'codex', model: PIPELINE_CONFIG.draftModel, reasoning: PIPELINE_CONFIG.draftReasoning, roles: Object.freeze(['article_draft']) })
});

export const CODEX_CREDIT_RATES = Object.freeze({
  'gpt-5.6-terra': Object.freeze({ input: 50, cached_input: 5, output: 300 }),
  'gpt-5.6-luna': Object.freeze({ input: 5, cached_input: 0.5, output: 30 }),
  'gpt-5.6-sol': Object.freeze({ input: 5, cached_input: 0.5, output: 30 })
});
