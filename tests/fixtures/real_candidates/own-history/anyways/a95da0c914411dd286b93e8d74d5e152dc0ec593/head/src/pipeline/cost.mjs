import { CODEX_CREDIT_RATES, PRODUCTION_CODEX_PROVIDER } from './config.mjs';

const integer = value => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : 0;

export function calculateCodexUsage({ model, reasoning = 'none', stage, usage = {}, wallMs = 0, attempt = 1, creditUsd = PRODUCTION_CODEX_PROVIDER.creditUsd } = {}) {
  const rates = CODEX_CREDIT_RATES[model];
  const inputTokens = integer(usage.input_tokens);
  const cachedInputTokens = Math.min(inputTokens, integer(usage.cached_input_tokens));
  const outputTokens = integer(usage.output_tokens);
  const reasoningOutputTokens = integer(usage.reasoning_output_tokens);
  const credits = rates
    ? ((inputTokens - cachedInputTokens) * rates.input + cachedInputTokens * rates.cached_input + outputTokens * rates.output) / 1_000_000
    : null;
  return {
    provider: 'codex',
    model: String(model || 'unknown'),
    reasoning,
    stage: String(stage || 'generation'),
    attempt,
    input_tokens: inputTokens,
    cached_input_tokens: cachedInputTokens,
    output_tokens: outputTokens,
    reasoning_output_tokens: reasoningOutputTokens,
    credits,
    estimated_cost_usd: credits === null || creditUsd === null ? null : credits * creditUsd,
    wall_ms: Math.max(0, Math.round(Number(wallMs) || 0))
  };
}
