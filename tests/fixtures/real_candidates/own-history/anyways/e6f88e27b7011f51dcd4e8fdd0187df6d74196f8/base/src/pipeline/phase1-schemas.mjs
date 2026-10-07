export const PHASE1_SOURCE_ID_MAX_LENGTH = 160;
export const TERRA_EVIDENCE_CONTRACT_VERSION = 'terra-evidence-offsets-v1';
export const TERRA_EVIDENCE_MAX_RANGE_CHARACTERS = 4_000;
export const TERRA_EVIDENCE_ROLES = Object.freeze(['must_use', 'supporting', 'context']);
const text = (maxLength = 4_000) => ({ type: 'string', minLength: 1, maxLength });
const id = text(PHASE1_SOURCE_ID_MAX_LENGTH);
const list = (items, maxItems = 32) => ({ type: 'array', maxItems, items });
const ids = (maxItems = 32, minItems = 0) => ({ type: 'array', minItems, maxItems, items: id });
const nonNegativeInteger = { type: 'integer', minimum: 0 };
const nullableNonNegativeInteger = { type: 'integer', minimum: 0, nullable: true };
const nullableNonNegativeNumber = { type: 'number', minimum: 0, nullable: true };

// This is the machine-readable contract printed in the Terra prompt. Keep
// the prompt-facing descriptions and the validator limits together so a
// contract change cannot silently leave the model with a different shape.
export const TERRA_PROMPT_SCHEMA_CONTRACT = Object.freeze({
  source_reference: {
    type: 'string',
    min_length: 1,
    max_length: PHASE1_SOURCE_ID_MAX_LENGTH,
    exact_inventory_id: true,
    note: 'Use one exact source_id from the supplied inventory; never concatenate, abbreviate, or invent IDs.'
  },
  claim: {
    type: 'object',
    additional_properties: false,
    required: ['claim_id', 'claim', 'source_ids', 'evidence', 'confidence'],
    source_ids: { type: 'array', min_items: 1, max_items: 8, items: 'source_reference' },
    evidence: {
      type: 'array', min_items: 1, max_items: 8,
      items: { $ref: 'terra_evidence_reference' }
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    qualification_note: { type: 'string', min_length: 1, max_length: 1_000, optional: true }
  },
  blocker: {
    type: 'object',
    additional_properties: false,
    required: ['blocker_id', 'question', 'reason', 'required_action'],
    optional: ['source_ids'],
    source_ids: { type: 'array', min_items: 0, max_items: 8, items: 'source_reference' },
    example: { blocker_id: 'blocker-1', question: 'What changed?', reason: 'The official record is missing.', required_action: 'Obtain the official record.', source_ids: ['source-id-from-inventory'] }
  },
  contradiction: {
    type: 'object',
    additional_properties: false,
    required: ['contradiction_id', 'claim_id', 'source_ids', 'description', 'resolution'],
    claim_id: 'claim_reference',
    source_ids: { type: 'array', min_items: 1, max_items: 8, items: 'source_reference' },
    description: { type: 'string', min_length: 1, max_length: 1_000 },
    resolution: { type: 'string', min_length: 1, max_length: 1_000 },
    example: { contradiction_id: 'contradiction-1', claim_id: 'claim-1', source_ids: ['source-id-from-inventory'], description: 'Two retained sources report different dates.', resolution: 'Use the enacted record and attribute the discrepancy.' }
  },
  freshness_risk: { type: 'string', min_length: 1, max_length: 1_000, example: 'The source may have changed since its publication date.' },
  missing_evidence: { type: 'string', min_length: 1, max_length: 1_000, example: 'Obtain the product terms before making a product-mechanics claim.' },
  terra_evidence_reference: {
    type: 'object', additional_properties: false,
    required: ['source_id', 'start_offset', 'end_offset', 'claim_ids', 'evidence_role', 'reason'],
    source_id: 'source_reference', start_offset: { type: 'integer', minimum: 0 }, end_offset: { type: 'integer', minimum: 1 },
    claim_ids: { type: 'array', min_items: 1, max_items: 20, items: { type: 'string', min_length: 1, max_length: PHASE1_SOURCE_ID_MAX_LENGTH } },
    evidence_role: { type: 'string', enum: TERRA_EVIDENCE_ROLES }, reason: { type: 'string', min_length: 1, max_length: 500 }
  },
  required_fact: {
    type: 'object', additional_properties: false, required: ['fact_id', 'text', 'source_ids'],
    source_ids: { type: 'array', min_items: 0, max_items: 8, items: 'source_reference' }
  }
});

export const TERRA_OUTPUT_EXAMPLE = Object.freeze({
  research_questions: [{ question_id: 'question-1', question: 'string', answerable: true }],
  selected_source_ids: ['source-id-from-inventory'],
  optional_source_ids: [],
  excluded_sources: [{ source_id: 'source-id-from-inventory', reason: 'string' }],
  claims: [{ claim_id: 'claim-1', claim: 'string', source_ids: ['source-id-from-inventory'], evidence: [{ source_id: 'source-id-from-inventory', start_offset: 120, end_offset: 284, claim_ids: ['claim-1'], evidence_role: 'must_use', reason: 'Supports the claim.' }], confidence: 'high', qualification_note: 'optional' }],
  required_facts: [{ fact_id: 'fact-1', text: 'string', source_ids: ['source-id-from-inventory'] }],
  prohibited_claims: [],
  ledgers: { quotations: [{ text: 'exact quote', speaker: 'name', source_id: 'source-id-from-inventory' }], proper_names: [{ name: 'Name', type: 'person', source_id: 'source-id-from-inventory' }], numbers: [{ value: '42', context: 'what it measures', source_id: 'source-id-from-inventory' }] },
  claim_targets: ['claim-1'],
  unresolved_research_questions: [],
  contradictions: [{ contradiction_id: 'contradiction-1', claim_id: 'claim-1', source_ids: ['source-id-from-inventory'], description: 'Two retained sources report different dates.', resolution: 'Use the enacted record and attribute the discrepancy.' }],
  freshness_risks: ['The source may have changed since publication.'],
  missing_evidence: ['Obtain the official record before making this claim.'],
  blockers: [],
  draft_constraints: ['Attribute product intentions to company materials.'],
  ready_to_draft: true
});

export const PHASE1_SCHEMAS = Object.freeze({
  claim_to_source_evidence: {
    type: 'object', additionalProperties: false,
    required: ['claim_id', 'claim', 'source_ids', 'evidence', 'confidence'],
    properties: {
      claim_id: id,
      claim: text(1_000),
      source_ids: ids(8, 1),
      evidence: { type: 'array', minItems: 1, maxItems: 8, items: {
        type: 'object', additionalProperties: false, required: ['source_id', 'excerpt'], properties: { source_id: id, excerpt: text(4_000) }
      } },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      qualification_note: { type: 'string', maxLength: 1_000 }
    }
  },

  research_blocker: {
    type: 'object', additionalProperties: false,
    required: ['blocker_id', 'question', 'reason', 'required_action'],
    properties: {
      blocker_id: id,
      question: text(600),
      reason: text(1_000),
      required_action: text(1_000),
      source_ids: ids(8)
    }
  },

  terra_contradiction: {
    type: 'object', additionalProperties: false,
    required: ['contradiction_id', 'claim_id', 'source_ids', 'description', 'resolution'],
    properties: {
      contradiction_id: id,
      claim_id: id,
      source_ids: ids(8, 1),
      description: text(1_000),
      resolution: text(1_000)
    }
  },

  terra_evidence_reference: {
    type: 'object', additionalProperties: false,
    required: ['source_id', 'start_offset', 'end_offset', 'claim_ids', 'evidence_role', 'reason'],
    properties: {
      source_id: id,
      start_offset: nonNegativeInteger,
      end_offset: { type: 'integer', minimum: 1 },
      claim_ids: ids(20, 1),
      evidence_role: { type: 'string', enum: TERRA_EVIDENCE_ROLES },
      reason: text(500)
    }
  },

  terra_research_evidence: {
    type: 'object', additionalProperties: false,
    required: ['research_questions', 'selected_source_ids', 'optional_source_ids', 'excluded_sources', 'claims', 'contradictions', 'freshness_risks', 'missing_evidence', 'blockers', 'draft_constraints', 'ready_to_draft'],
    properties: {
      research_questions: list({ type: 'object', additionalProperties: false, required: ['question_id', 'question', 'answerable'], properties: { question_id: id, question: text(600), answerable: { type: 'boolean' } } }, 16),
      selected_source_ids: ids(12),
      optional_source_ids: ids(12),
      excluded_sources: list({ type: 'object', additionalProperties: false, required: ['source_id', 'reason'], properties: { source_id: id, reason: text(500) } }, 32),
      claims: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['claim_id', 'claim', 'source_ids', 'evidence', 'confidence'], properties: {
        claim_id: id, claim: text(1_000), source_ids: ids(8, 1), evidence: { type: 'array', minItems: 1, maxItems: 8, items: { $ref: 'terra_evidence_reference' } }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, qualification_note: { type: 'string', maxLength: 1_000 }
      } } },
      required_facts: list({ type: 'object', additionalProperties: false, required: ['fact_id', 'text', 'source_ids'], properties: { fact_id: id, text: text(1_000), source_ids: ids(8) } }, 32),
      prohibited_claims: list(text(1_000), 24),
      ledgers: { type: 'object', additionalProperties: false, required: ['quotations', 'proper_names', 'numbers'], properties: {
        quotations: list({ type: 'object', additionalProperties: false, required: ['text', 'speaker', 'source_id'], properties: { text: text(2_000), speaker: text(300), source_id: id } }, 32),
        proper_names: list({ type: 'object', additionalProperties: false, required: ['name', 'type', 'source_id'], properties: { name: text(300), type: text(100), source_id: id } }, 64),
        numbers: list({ type: 'object', additionalProperties: false, required: ['value', 'context', 'source_id'], properties: { value: text(100), context: text(500), source_id: id } }, 64)
      } },
      claim_targets: ids(20),
      unresolved_research_questions: list(text(600), 16),
      contradictions: { type: 'array', maxItems: 12, items: { $ref: 'terra_contradiction' } },
      freshness_risks: list(text(1_000), 12),
      missing_evidence: list(text(1_000), 12),
      blockers: { type: 'array', maxItems: 12, items: { anyOf: [{ $ref: 'research_blocker' }, text(1_000)] } },
      draft_constraints: { type: 'array', minItems: 1, maxItems: 16, items: text(1_000) },
      ready_to_draft: { type: 'boolean' }
    }
  },

  luna_draft: {
    type: 'object', additionalProperties: false,
    required: ['headline', 'dek', 'body_markdown', 'claim_support', 'warnings'],
    properties: {
      headline: text(180), dek: text(300), body_markdown: text(32_000), section: text(120), lens: text(1_000),
      beats: ids(12), source_ids: ids(12),
      claim_support: { type: 'array', minItems: 1, maxItems: 20, items: { $ref: 'luna_claim_support' } },
      warnings: list(text(1_000), 16)
    }
  },

  luna_revision: {
    type: 'object', additionalProperties: false,
    required: ['headline', 'dek', 'body_markdown', 'claim_support', 'warnings', 'changed_claim_ids', 'revision_notes'],
    properties: {
      headline: text(180), dek: text(300), body_markdown: text(32_000), section: text(120), lens: text(1_000),
      beats: ids(12), source_ids: ids(12), changed_claim_ids: ids(20), revision_notes: list(text(600), 16),
      claim_support: { type: 'array', minItems: 1, maxItems: 20, items: { $ref: 'luna_claim_support' } },
      warnings: list(text(1_000), 16)
    }
  },

  luna_claim_support: {
    type: 'object', additionalProperties: false,
    required: ['claim_id', 'evidence_ids', 'article_anchor', 'treatment'],
    properties: {
      claim_id: id,
      evidence_ids: ids(32, 1),
      article_anchor: text(200),
      treatment: { type: 'string', enum: ['paraphrase', 'direct_quote', 'attributed_claim', 'context'] }
    }
  },

  sol_polish: {
    type: 'object', additionalProperties: false,
    required: ['headline', 'dek', 'body_markdown', 'changes', 'warnings'],
    properties: {
      headline: text(180),
      dek: text(300),
      body_markdown: text(32_000),
      changes: { type: 'array', maxItems: 64, items: {
        type: 'object', additionalProperties: false,
        required: ['location', 'before', 'after', 'reason'],
        properties: { location: text(120), before: text(2_000), after: text(2_000), reason: text(300) }
      } },
      warnings: list(text(1_000), 16)
    }
  },

  model_usage: {
    type: 'object', additionalProperties: false,
    required: ['provider', 'model', 'reasoning', 'stage', 'attempt', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'credits', 'estimated_cost_usd', 'wall_ms'],
    properties: {
      provider: { type: 'string', enum: ['codex', 'ollama', 'unknown'] },
      model: text(160),
      reasoning: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'none'] },
      stage: text(80),
      attempt: { type: 'integer', minimum: 1 },
      input_tokens: nullableNonNegativeInteger,
      cached_input_tokens: nullableNonNegativeInteger,
      output_tokens: nullableNonNegativeInteger,
      reasoning_output_tokens: nullableNonNegativeInteger,
      credits: nullableNonNegativeNumber,
      estimated_cost_usd: nullableNonNegativeNumber,
      wall_ms: nonNegativeInteger
    }
  },

});

function schemaByRef(schema) {
  return schema?.$ref ? PHASE1_SCHEMAS[schema.$ref.replace(/^.*\//, '')] : schema;
}

export function validatePhase1Schema(nameOrSchema, value, path = '$') {
  const schema = schemaByRef(typeof nameOrSchema === 'string' ? PHASE1_SCHEMAS[nameOrSchema] : nameOrSchema);
  if (!schema) return [`${path} references an unknown Phase 1 schema`];
  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some(option => validatePhase1Schema(option, value, path).length === 0)) return [];
    return [`${path} does not match any permitted shape`];
  }
  if (schema.nullable && value === null) return [];
  if (schema.type === 'object') {
    if (!value || Array.isArray(value) || typeof value !== 'object') return [`${path} must be an object`];
    const errors = (schema.required || []).filter(key => !(key in value)).map(key => `${path}.${key} is required`);
    if (schema.additionalProperties === false) errors.push(...Object.keys(value).filter(key => !(key in (schema.properties || {}))).map(key => `${path}.${key} is not allowed`));
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) errors.push(...validatePhase1Schema(child, value[key], `${path}.${key}`));
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${path} must be an array`];
    const errors = [];
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    return errors.concat(...value.map((item, index) => validatePhase1Schema(schema.items, item, `${path}[${index}]`)));
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength !== undefined && value.trim().length < schema.minLength)) return [`${path} must be a non-empty string`];
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return [`${path} is too long`];
    if (schema.enum && !schema.enum.includes(value)) return [`${path} is not permitted`];
    return [];
  }
  if (schema.type === 'integer') {
    if (!Number.isInteger(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return [`${path} must be an integer in range`];
    return [];
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) return [`${path} must be a number in range`];
    return [];
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') return [`${path} must be boolean`];
  return [];
}

export function assertPhase1Schema(name, value) {
  const errors = validatePhase1Schema(name, value);
  if (errors.length) {
    const error = new Error(`Phase 1 ${name} schema validation failed: ${errors.join('; ')}`);
    error.code = 'PHASE1_SCHEMA_INVALID';
    error.details = { schema: name, errors };
    throw error;
  }
  return value;
}
