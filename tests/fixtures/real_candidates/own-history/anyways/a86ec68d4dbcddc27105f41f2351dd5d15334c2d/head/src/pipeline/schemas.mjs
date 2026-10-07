import { BEAT_ORDER, SECTION_ORDER } from '../editorial.mjs';

const string = { type: 'string', minLength: 1 };
const bounded = maxLength => ({ type: 'string', minLength: 1, maxLength });
const strings = { type: 'array', items: string };
const sourceIds = { type: 'array', minItems: 1, items: string };
const confidence = { type: 'string', enum: ['high', 'medium', 'low'] };

export const STAGE_SCHEMAS = Object.freeze({
  scout: { type: 'object', additionalProperties: false, required: ['candidates'], properties: { candidates: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['headline', 'why_now', 'source_urls'], properties: { headline: string, why_now: string, source_urls: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^https?://' } } } } } } },
  classification: { type: 'object', additionalProperties: false, required: ['primary_section', 'recurring_beats', 'tags', 'reader_consequence', 'what_this_allows_people_to_become', 'fit_score', 'decision', 'reasoning', 'uncertainty'], properties: { primary_section: { type: 'string', enum: SECTION_ORDER }, recurring_beats: { type: 'array', items: { type: 'string', enum: BEAT_ORDER } }, tags: strings, reader_consequence: string, what_this_allows_people_to_become: string, fit_score: { type: 'integer', minimum: 0, maximum: 100 }, decision: { type: 'string', enum: ['proceed', 'watch', 'reject'] }, reasoning: string, uncertainty: { type: 'string' } } },
  ranking: { type: 'object', additionalProperties: false, required: ['ranked', 'rejections'], properties: { ranked: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', additionalProperties: false, required: ['candidate_id', 'rank', 'reason'], properties: { candidate_id: string, rank: { type: 'integer', minimum: 1, maximum: 5 }, reason: string } } }, rejections: strings } },
  research_plan: { type: 'object', additionalProperties: false, required: ['central_question', 'primary_sources_needed', 'secondary_sources_needed', 'search_queries', 'timeline', 'entities', 'competing_interpretations', 'missing_evidence', 'stop_conditions'], properties: { central_question: string, primary_sources_needed: strings, secondary_sources_needed: strings, search_queries: strings, timeline: strings, entities: strings, competing_interpretations: strings, missing_evidence: strings, stop_conditions: strings } },
  source_extraction: { type: 'object', additionalProperties: false, required: ['source_id', 'relevant', 'relevance_score', 'retention_reason', 'facts', 'dates', 'entities', 'claims', 'warnings'], properties: { source_id: string, relevant: { type: 'boolean' }, relevance_score: { type: 'integer', minimum: 0, maximum: 100 }, retention_reason: string, facts: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['fact_id', 'statement', 'support', 'confidence'], properties: { fact_id: string, statement: string, support: string, confidence } } }, dates: { type: 'array', maxItems: 4, items: string }, entities: { type: 'array', maxItems: 6, items: string }, claims: { type: 'array', maxItems: 4, items: string }, warnings: { type: 'array', maxItems: 4, items: string } } },
  conflict_analysis: { type: 'object', additionalProperties: false, required: ['supported_facts', 'conflicts', 'uncertainties', 'missing_evidence', 'excluded_claims'], properties: { supported_facts: { type: 'array', maxItems: 20, items: string }, conflicts: { type: 'array', maxItems: 8, items: string }, uncertainties: { type: 'array', maxItems: 8, items: string }, missing_evidence: { type: 'array', maxItems: 8, items: string }, excluded_claims: { type: 'array', maxItems: 8, items: string } } },
  editorial_angle: { type: 'object', additionalProperties: false, required: ['central_question', 'recommended_angle', 'sufficiency'], properties: { central_question: string, recommended_angle: string, sufficiency: { type: 'string', enum: ['sufficient', 'insufficient'] } } },
  synthesis: { type: 'object', additionalProperties: false, required: ['supported_facts', 'uncertain_facts', 'conflicting_claims', 'timeline', 'claim_to_source', 'missing_evidence', 'exclude_from_article', 'suggested_angle'], properties: { supported_facts: strings, uncertain_facts: strings, conflicting_claims: strings, timeline: strings, claim_to_source: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['claim', 'source_ids'], properties: { claim: string, source_ids: sourceIds } } }, missing_evidence: strings, exclude_from_article: strings, suggested_angle: string } },
  draft: { type: 'object', additionalProperties: false, required: ['headline', 'dek', 'body_markdown', 'claim_to_source'], properties: { headline: string, dek: string, body_markdown: string, claim_to_source: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['claim', 'source_ids'], properties: { claim: string, source_ids: sourceIds } } } } },
  verification: { type: 'object', additionalProperties: false, required: ['claims', 'can_advance'], properties: { claims: { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['claim', 'status', 'source_ids', 'note'], properties: { claim: string, status: { type: 'string', enum: ['supported', 'partially_supported', 'unsupported', 'contradicted', 'opinion', 'time_sensitive', 'requires_human_review'] }, source_ids: { type: 'array', items: string }, note: string } } }, can_advance: { type: 'boolean' } } },
  proofreading: { type: 'object', additionalProperties: false, required: ['issues', 'minimal_edit', 'improved_edit', 'change_log'], properties: { issues: strings, minimal_edit: string, improved_edit: string, change_log: strings } },
  slop: { type: 'object', additionalProperties: false, required: ['revised_body', 'changes', 'warnings'], properties: { revised_body: bounded(9000), changes: { type: 'array', maxItems: 3, items: { type: 'object', additionalProperties: false, required: ['type', 'summary'], properties: { type: bounded(32), summary: bounded(160) } } }, warnings: { type: 'array', maxItems: 3, items: bounded(160) } } }
});

export function validateSchema(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') return [`${path} must be an object`];
    const errors = schema.required.filter(key => !(key in value)).map(key => `${path}.${key} is required`);
    if (schema.additionalProperties === false) errors.push(...Object.keys(value).filter(key => !(key in schema.properties)).map(key => `${path}.${key} is not allowed`));
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validateSchema(child, value[key], `${path}.${key}`));
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const errors = []; if (schema.minItems && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`); if (schema.maxItems && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    return errors.concat(...value.map((item, i) => validateSchema(schema.items, item, `${path}[${i}]`)));
  }
  if (schema.type === 'string') { if (typeof value !== 'string' || (schema.minLength && value.trim().length < schema.minLength)) return [`${path} must be a non-empty string`]; if (schema.maxLength && value.length > schema.maxLength) return [`${path} is too long`]; if (schema.enum && !schema.enum.includes(value)) return [`${path} is not permitted`]; if (schema.pattern && !(new RegExp(schema.pattern).test(value))) return [`${path} has an invalid format`]; }
  if (schema.type === 'integer' && (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum)) return [`${path} must be an integer in range`];
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path} must be boolean`];
  return [];
}
