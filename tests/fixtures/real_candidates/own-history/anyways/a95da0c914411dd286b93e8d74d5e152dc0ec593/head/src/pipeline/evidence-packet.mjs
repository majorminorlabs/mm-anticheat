import crypto from 'node:crypto';

export const EVIDENCE_PACKET_LIMITS = Object.freeze({
  maxSources: 12,
  maxSourceExcerptCharacters: 4_000,
  maxTotalExcerptCharacters: 48_000,
  maxPacketCharacters: 64_000,
  maxEstimatedTokens: 16_000
});

export const SOURCE_CLASSIFICATIONS = Object.freeze([
  'primary',
  'original_reporting',
  'derivative_reporting',
  'commentary',
  'unusable'
]);

const CLASS_ORDER = new Map(SOURCE_CLASSIFICATIONS.map((value, index) => [value, index]));
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const characterCount = value => Array.from(String(value ?? '')).length;
const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function explicitClassification(record) {
  const value = String(record.classification || record.source_classification || record.source_type || record.kind || '').toLowerCase().replace(/[ -]+/g, '_');
  if (['primary', 'primary_source', 'primary_research', 'candidate_primary', 'official', 'first_party', 'documentary', 'filing', 'record', 'dataset', 'government'].includes(value)) return 'primary';
  if (['original', 'original_reporting', 'reported', 'news_reporting', 'journalism'].includes(value)) return 'original_reporting';
  if (['derivative', 'derivative_reporting', 'secondary', 'aggregator', 'syndicated', 'republished'].includes(value)) return 'derivative_reporting';
  if (['commentary', 'opinion', 'analysis', 'editorial', 'blog', 'social', 'podcast'].includes(value)) return 'commentary';
  return null;
}

export function classifySource(record = {}) {
  const text = record.excerpt ?? record.text ?? record.content ?? record.extracted_text ?? '';
  const unusable = record.usable === false
    || record.is_unusable === true
    || record.unusable === true
    || record.paywalled === true
    || record.ok === false
    || Boolean(record.error)
    || !String(text).trim();
  if (unusable) return 'unusable';
  if (record.is_primary === true || record.primary === true) return 'primary';
  if (record.is_original_reporting === true || record.original_reporting === true) return 'original_reporting';
  if (record.is_commentary === true || record.commentary === true) return 'commentary';
  return explicitClassification(record) || 'derivative_reporting';
}

function isExcludedGeneratedMaterial(record) {
  const values = [record.kind, record.role, record.source_type, record.classification, record.document_type]
    .filter(Boolean).map(value => String(value).toLowerCase().replace(/[ -]+/g, '_'));
  return record.is_reference === true
    || record.is_generated === true
    || record.is_prior_draft === true
    || values.some(value => ['reference', 'reference_article', 'prior_draft', 'generated_draft', 'draft', 'previous_draft'].includes(value));
}

function sourceText(record, { preserve = false } = {}) {
  const value = String(record.excerpt ?? record.text ?? record.content ?? record.extracted_text ?? '');
  return preserve ? value : value.replace(/\r\n?/g, '\n').trim();
}

function normalizeMetadata(record) {
  return {
    title: clean(record.title),
    url: clean(record.canonical_url || record.url),
    published_at: clean(record.published_at || record.publishedAt),
    author: clean(record.author)
  };
}

function normalizeList(values = []) {
  return Array.isArray(values) ? values : [];
}

function normalizeFact(value, index) {
  if (typeof value === 'string') return { fact_id: `fact-${hash(value).slice(0, 16)}`, text: clean(value), source_ids: [] };
  if (!value || typeof value !== 'object') return null;
  const text = clean(value.text || value.statement || value.fact || value.claim);
  if (!text) return null;
  return {
    fact_id: clean(value.fact_id || value.id) || `fact-${index + 1}-${hash(text).slice(0, 12)}`,
    text,
    source_ids: [...new Set(normalizeList(value.source_ids || value.sourceIds).map(clean).filter(Boolean))].sort()
  };
}

function normalizeClaim(value) {
  if (typeof value === 'string') return clean(value);
  if (!value || typeof value !== 'object') return '';
  return clean(value.text || value.claim || value.statement);
}

function normalizeClaimRecord(value, index, { preserveDerivedEvidence = false } = {}) {
  if (!value || typeof value !== 'object') return null;
  const claim = normalizeClaim(value);
  if (!claim) return null;
  const evidence = normalizeList(value.evidence).map(item => {
    if (!item || typeof item !== 'object') return null;
    const normalized = {
      source_id: clean(item.source_id || item.sourceId),
      excerpt: preserveDerivedEvidence ? String(item.excerpt ?? '') : clean(item.excerpt || item.quote)
    };
    if (preserveDerivedEvidence) Object.assign(normalized, {
      start_offset: item.start_offset,
      end_offset: item.end_offset,
      range_length: item.range_length,
      excerpt_sha256: clean(item.excerpt_sha256),
      source_text_sha256: clean(item.source_text_sha256),
      claim_ids: normalizeList(item.claim_ids).map(clean).filter(Boolean),
      evidence_role: clean(item.evidence_role),
      reason: clean(item.reason)
    });
    return normalized;
  }).filter(item => item?.source_id && item.excerpt);
  return {
    claim_id: clean(value.claim_id || value.id) || `claim-${index + 1}-${hash(claim).slice(0, 12)}`,
    claim,
    source_ids: [...new Set(normalizeList(value.source_ids || value.sourceIds).map(clean).filter(Boolean))].sort(),
    evidence,
    confidence: clean(value.confidence),
    qualification_note: clean(value.qualification_note || value.qualificationNote)
  };
}

function normalizeLedger(values, fields) {
  const output = [];
  const seen = new Set();
  for (const value of normalizeList(values)) {
    const item = typeof value === 'string' ? { text: clean(value) } : value && typeof value === 'object' ? value : null;
    if (!item) continue;
    const normalized = Object.fromEntries(fields.map(field => [field, clean(item[field] || item[field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())])]));
    if (!Object.values(normalized).some(Boolean)) continue;
    const key = stableJson(normalized);
    if (!seen.has(key)) { seen.add(key); output.push(normalized); }
  }
  return output.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
}

function limitError(limitName, configuredLimit, actual, unit, contributions, preflight = null) {
  let cumulative = 0;
  let exceededBy = null;
  for (const contribution of contributions) {
    cumulative += contribution.amount;
    if (!exceededBy && cumulative > configuredLimit) exceededBy = { ...contribution, cumulative };
  }
  const error = new Error(`Evidence packet ${limitName} exceeded: ${actual} ${unit} > ${configuredLimit} ${unit}.`);
  error.code = 'EVIDENCE_PACKET_LIMIT_EXCEEDED';
  error.details = {
    limit_name: limitName,
    configured_limit: configuredLimit,
    actual,
    unit,
    contributions: contributions.map((item, index) => ({ ...item, cumulative: contributions.slice(0, index + 1).reduce((sum, current) => sum + current.amount, 0) })),
    exceeded_by: exceededBy || contributions.at(-1) || null,
    ...(preflight ? { preflight } : {})
  };
  return error;
}

function duplicateSourceIdError(sourceId) {
  const error = new Error(`Evidence packet received conflicting records for stable source ID ${sourceId}.`);
  error.code = 'EVIDENCE_PACKET_SOURCE_ID_CONFLICT';
  error.details = { source_id: sourceId };
  return error;
}

export function buildEvidencePacket({
  sources = [],
  claims = [],
  requiredFacts = [],
  prohibitedClaims = [],
  ledgers = {},
  unresolvedResearchQuestions = [],
  blockers = [],
  draftConstraints = [],
  limits = EVIDENCE_PACKET_LIMITS,
  preserveSourceText = false,
  includeRetainedText = false,
  includeSourceExcerpts = true,
  preserveDerivedEvidence = false
} = {}) {
  if (!Array.isArray(sources)) throw new Error('Evidence packet sources must be an array.');
  const configured = { ...EVIDENCE_PACKET_LIMITS, ...limits };
  const byId = new Map();
  const excludedSources = [];
  for (const [index, record] of sources.entries()) {
    const sourceId = clean(record?.id || record?.source_id || record?.sourceId);
    if (!sourceId) throw new Error(`Evidence packet source at index ${index} is missing a stable source ID.`);
    const text = sourceText(record, { preserve: preserveSourceText });
    const fingerprint = hash(stableJson({ text, metadata: normalizeMetadata(record), classification: classifySource(record) }));
    if (byId.has(sourceId)) {
      if (byId.get(sourceId).fingerprint !== fingerprint) throw duplicateSourceIdError(sourceId);
      continue;
    }
    const classification = classifySource(record);
    const normalized = { record, sourceId, text, classification, fingerprint, metadata: normalizeMetadata(record) };
    byId.set(sourceId, normalized);
    if (isExcludedGeneratedMaterial(record)) {
      excludedSources.push({ source_id: sourceId, reason: 'reference_or_prior_generated_material' });
    } else if (classification === 'unusable') {
      excludedSources.push({ source_id: sourceId, reason: clean(record.error) || 'source_unusable' });
    }
  }

  const usable = [...byId.values()]
    .filter(item => !excludedSources.some(excluded => excluded.source_id === item.sourceId))
    .sort((left, right) => CLASS_ORDER.get(left.classification) - CLASS_ORDER.get(right.classification) || left.sourceId.localeCompare(right.sourceId));
  if (usable.length > configured.maxSources) {
    throw limitError('source_count', configured.maxSources, usable.length, 'sources', usable.map(item => ({ source_id: item.sourceId, field: 'source', amount: 1 })));
  }

  const packetSources = [];
  const textOwners = new Map();
  const metadataOwners = new Map();
  const excerptContributions = [];
  let totalExcerptCharacters = 0;
  for (const item of usable) {
    const boundedExcerpt = preserveSourceText ? item.text.slice(0, configured.maxSourceExcerptCharacters) : Array.from(item.text).slice(0, configured.maxSourceExcerptCharacters).join('');
    const excerptHash = hash(item.text);
    const textOwner = textOwners.get(excerptHash);
    const metadataKey = stableJson(item.metadata);
    const metadataOwner = metadataOwners.get(metadataKey);
    const entry = { source_id: item.sourceId, classification: item.classification };
    if (includeRetainedText) Object.assign(entry, { retained_text: item.text, source_text_sha256: hash(item.text), retained_text_characters: item.text.length });
    if (metadataOwner) entry.metadata_ref = metadataOwner;
    else {
      Object.assign(entry, Object.fromEntries(Object.entries(item.metadata).filter(([, value]) => value)));
      metadataOwners.set(metadataKey, item.sourceId);
    }
    if (textOwner) {
      entry.duplicate_of = textOwner;
    } else {
      const amount = characterCount(boundedExcerpt);
      excerptContributions.push({ source_id: item.sourceId, field: 'excerpt', amount });
      totalExcerptCharacters += amount;
      if (totalExcerptCharacters > configured.maxTotalExcerptCharacters) {
        throw limitError('total_excerpt_characters', configured.maxTotalExcerptCharacters, totalExcerptCharacters, 'characters', excerptContributions);
      }
      textOwners.set(excerptHash, item.sourceId);
      if (includeSourceExcerpts) {
        entry.excerpt = boundedExcerpt;
        entry.excerpt_characters = amount;
        if (boundedExcerpt.length < item.text.length) entry.excerpt_truncated = true;
      }
    }
    packetSources.push(entry);
  }

  const factInputs = [
    ...normalizeList(requiredFacts),
    ...usable.flatMap(item => normalizeList(item.record.required_facts || item.record.requiredFacts || item.record.facts))
  ];
  const facts = [];
  const factKeys = new Set();
  for (const [index, value] of factInputs.entries()) {
    const fact = normalizeFact(value, index);
    if (!fact || factKeys.has(fact.fact_id)) continue;
    factKeys.add(fact.fact_id);
    facts.push(fact);
  }
  facts.sort((left, right) => left.fact_id.localeCompare(right.fact_id));

  const prohibited = [...new Set([
    ...normalizeList(prohibitedClaims).map(normalizeClaim),
    ...usable.flatMap(item => normalizeList(item.record.prohibited_claims || item.record.prohibitedClaims).map(normalizeClaim))
  ].filter(Boolean))].sort();
  const questionValues = [...new Set([
    ...normalizeList(unresolvedResearchQuestions).map(normalizeClaim),
    ...usable.flatMap(item => normalizeList(item.record.unresolved_research_questions || item.record.unresolvedQuestions).map(normalizeClaim))
  ].filter(Boolean))].sort();
  const blockerValues = [...new Set([
    ...normalizeList(blockers).map(normalizeClaim),
    ...usable.flatMap(item => normalizeList(item.record.blockers).map(normalizeClaim))
  ].filter(Boolean))].sort();
  const draftConstraintValues = [...new Set(normalizeList(draftConstraints).map(clean).filter(Boolean))].sort();
  const normalizedLedgers = {
    quotations: normalizeLedger([
      ...normalizeList(ledgers.quotations || ledgers.quotes),
      ...usable.flatMap(item => normalizeList(item.record.quotations || item.record.quotes))
    ], ['text', 'speaker', 'source_id']),
    proper_names: normalizeLedger([
      ...normalizeList(ledgers.proper_names || ledgers.properNames),
      ...usable.flatMap(item => normalizeList(item.record.proper_names || item.record.properNames))
    ], ['name', 'type', 'source_id']),
    numbers: normalizeLedger([
      ...normalizeList(ledgers.numbers),
      ...usable.flatMap(item => normalizeList(item.record.numbers))
    ], ['value', 'context', 'source_id'])
  };

  const normalizedClaims = [];
  const claimKeys = new Set();
  for (const [index, value] of normalizeList(claims).entries()) {
    const claim = normalizeClaimRecord(value, index, { preserveDerivedEvidence });
    if (!claim || claimKeys.has(claim.claim_id)) continue;
    claimKeys.add(claim.claim_id);
    normalizedClaims.push(claim);
  }
  normalizedClaims.sort((left, right) => left.claim_id.localeCompare(right.claim_id));

  // Evidence IDs are derived after Terra offset validation. They are stable
  // within the frozen packet and are the only evidence handles Luna may cite.
  if (preserveDerivedEvidence) {
    let evidenceNumber = 0;
    for (const claim of normalizedClaims) {
      claim.evidence = claim.evidence.map(evidence => ({
        evidence_id: `evidence-${String(++evidenceNumber).padStart(3, '0')}`,
        ...evidence
      }));
    }
  }

  const payload = {
    version: 'phase1-evidence-packet-v1',
    sources: packetSources,
    excluded_sources: excludedSources.sort((left, right) => left.source_id.localeCompare(right.source_id)),
    claims: normalizedClaims,
    claim_targets: normalizedClaims.map(claim => claim.claim_id),
    required_facts: facts,
    prohibited_claims: prohibited,
    ledgers: normalizedLedgers,
    unresolved_research_questions: questionValues,
    blockers: blockerValues,
    draft_constraints: draftConstraintValues
  };
  const serialized = stableJson(payload);
  const packetCharacters = characterCount(serialized);
  const metadataPayload = {
    sources: packetSources.map(source => Object.fromEntries(Object.entries(source).filter(([key]) => ['source_id', 'classification', 'title', 'url', 'published_at', 'author', 'metadata_ref'].includes(key)))),
    excluded_sources: payload.excluded_sources
  };
  const ledgerPayload = {
    claims: normalizedClaims,
    claim_targets: payload.claim_targets,
    required_facts: facts,
    prohibited_claims: prohibited,
    ledgers: normalizedLedgers,
    unresolved_research_questions: questionValues,
    blockers: blockerValues,
    draft_constraints: draftConstraintValues
  };
  const packetContributions = [
    ...packetSources.map(source => ({ source_id: source.source_id, field: 'source_entry', amount: characterCount(stableJson(source)) })),
    { source_id: null, field: 'facts_and_constraints', amount: characterCount(stableJson(ledgerPayload)) }
  ];
  const estimatedTokens = Math.ceil(packetCharacters / 4);
  const preflight = {
    source_count: packetSources.length,
    retained_source_text_characters: usable.reduce((total, item) => total + characterCount(item.text), 0),
    serialized_inventory_characters: packetCharacters,
    estimated_tokens: estimatedTokens,
    per_source_contribution: packetSources.map(source => ({ source_id: source.source_id, characters: characterCount(stableJson(source)) })).sort((left, right) => right.characters - left.characters || left.source_id.localeCompare(right.source_id)),
    metadata_contribution: { characters: characterCount(stableJson(metadataPayload)), fields: ['source metadata', 'excluded source metadata'] },
    ledger_contribution: { characters: characterCount(stableJson(ledgerPayload)), fields: ['claims', 'claim_targets', 'required_facts', 'prohibited_claims', 'ledgers', 'unresolved_research_questions', 'blockers', 'draft_constraints'] },
    configured_limits: {
      maxSources: configured.maxSources,
      maxSourceExcerptCharacters: configured.maxSourceExcerptCharacters,
      maxTotalExcerptCharacters: configured.maxTotalExcerptCharacters,
      maxPacketCharacters: configured.maxPacketCharacters,
      maxEstimatedTokens: configured.maxEstimatedTokens
    }
  };
  preflight.largest_contributors = [
    ...preflight.per_source_contribution.map(item => ({ kind: 'source', source_id: item.source_id, characters: item.characters })),
    { kind: 'metadata', source_id: null, characters: preflight.metadata_contribution.characters },
    { kind: 'ledger', source_id: null, characters: preflight.ledger_contribution.characters }
  ].sort((left, right) => right.characters - left.characters || String(left.source_id || left.kind).localeCompare(String(right.source_id || right.kind))).slice(0, 5);
  if (packetCharacters > configured.maxPacketCharacters) throw limitError('packet_characters', configured.maxPacketCharacters, packetCharacters, 'characters', packetContributions, preflight);
  if (estimatedTokens > configured.maxEstimatedTokens) throw limitError('estimated_tokens', configured.maxEstimatedTokens, estimatedTokens, 'tokens', packetContributions.map(item => ({ ...item, amount: Math.ceil(item.amount / 4) })), preflight);

  const checksum = hash(serialized);
  return {
    ...payload,
    totals: {
      source_count: packetSources.length,
      excluded_source_count: payload.excluded_sources.length,
      excerpt_characters: totalExcerptCharacters,
      packet_characters: packetCharacters,
      estimated_tokens: estimatedTokens
    },
    diagnostics: {
      deterministic_order: packetSources.map(source => source.source_id),
      deduplicated_source_text_count: packetSources.filter(source => source.duplicate_of).length,
      deduplicated_metadata_count: packetSources.filter(source => source.metadata_ref).length,
      truncated_source_count: packetSources.filter(source => source.excerpt_truncated).length,
      contributions: packetContributions,
      preflight
    },
    checksum,
    frozen_evidence_packet_sha256: preserveDerivedEvidence ? checksum : null
  };
}

export function preflightEvidencePacket(options = {}) {
  const packet = buildEvidencePacket(options);
  return { ...packet.diagnostics.preflight, packet };
}
