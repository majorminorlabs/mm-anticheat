export const PIPELINE_CONFIG = Object.freeze({
  adapter: 'ollama',
  defaultModel: 'qwen3:14b',
  comparisonModels: Object.freeze(['mistral-small3.2:24b']),
  ollamaUrl: process.env.ANYWAYS_OLLAMA_URL || 'http://127.0.0.1:11434',
  artifactDir: process.env.ANYWAYS_PIPELINE_ARTIFACT_DIR || 'pipeline-artifacts',
  requestTimeoutMs: 300_000,
  synthesis: Object.freeze({ sourceFacts: 4, normalizedFacts: 20, conflicts: 8, uncertainties: 8, missingEvidence: 8, excludedClaims: 8, sourcesPerFact: 5, sourceTokens: 520, conflictTokens: 1000, angleTokens: 900, sourceBatchChars: 2_800, recoverySourceChars: 1_500, sourceContextTokens: 1_100, sourceResponseTokens: 520 })
});
