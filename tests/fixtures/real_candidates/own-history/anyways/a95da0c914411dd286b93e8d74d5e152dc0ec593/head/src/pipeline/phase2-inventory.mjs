import crypto from 'node:crypto';
import { stableJson } from './evidence-packet.mjs';

// This is the only Phase 2 inventory identity contract. Do not add fields to
// the canonical representation without incrementing this version.
export const PHASE2_INVENTORY_CONTRACT_VERSION = 'phase2-inventory-v2';
export const PHASE2_CANONICAL_INVENTORY_VERSION = PHASE2_INVENTORY_CONTRACT_VERSION;

const stringValue = value => String(value ?? '');
const nullableString = value => {
  if (value === null || value === undefined) return null;
  const result = stringValue(value).trim();
  return result || null;
};
const retainedText = source => stringValue(source?.retained_text ?? source?.text ?? source?.content ?? source?.extracted_text);
const sha256 = value => crypto.createHash('sha256').update(stringValue(value), 'utf8').digest('hex');

function sourceRecordForCanonicalInventory(source = {}) {
  const text = retainedText(source);
  const sourceId = nullableString(source.source_id ?? source.id ?? source.sourceId);
  return {
    source_id: sourceId,
    requested_url: nullableString(source.requested_url ?? source.url ?? source.requestedUrl),
    canonical_url: nullableString(source.canonical_url ?? source.canonicalUrl ?? source.url),
    title: nullableString(source.title),
    publisher: nullableString(source.publisher),
    published_at: nullableString(source.published_at ?? source.publishedAt),
    classification: nullableString(source.classification ?? source.source_classification ?? source.source_type ?? source.kind),
    independence_key: nullableString(source.independence_key ?? source.coverage_key ?? source.source_group_id ?? source.publisher),
    primary_source: source.primary_source === true || source.primary === true || source.is_primary === true,
    accessible: source.accessible !== false && source.ok !== false && !source.error,
    retained_text: text,
    // This is derived from the exact retained string, never copied from a
    // caller-provided declaration that could identify a different text.
    retained_text_sha256: sha256(text),
    retained_text_characters: text.length,
    raw_sha256: source.raw_sha256 ?? null,
    retained_from_full_text_sha256: source.retained_from_full_text_sha256 ?? null,
    capture_mode: source.capture_mode ?? null
  };
}

function inventoryInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Phase 2 inventory must be an object.');
  const sources = input.sources ?? input.inventory ?? [];
  if (!Array.isArray(sources)) throw new TypeError('Phase 2 inventory sources must be an array.');
  return {
    candidateId: input.candidate_id ?? input.candidateId ?? null,
    assignmentSha256: input.assignment_sha256 ?? input.assignmentSha256 ?? input.assignment_checksum ?? null,
    sources
  };
}

/**
 * Convert a readiness or runtime source inventory to the one canonical,
 * immutable identity representation. Generated fields, diagnostics, paths,
 * timestamps, provider metadata, and packet fields are intentionally absent.
 * retained_text is copied exactly; it is never trimmed, decoded, collapsed,
 * normalized, or newline-converted.
 */
export function canonicalizePhase2Inventory(input = {}) {
  const { candidateId, assignmentSha256, sources } = inventoryInput(input);
  const normalized = sources.map(sourceRecordForCanonicalInventory);
  if (normalized.some(source => !source.source_id)) throw new Error('Canonical inventory source is missing source_id.');
  const ids = new Set();
  for (const source of normalized) {
    if (ids.has(source.source_id)) throw new Error(`Canonical inventory contains duplicate source_id ${source.source_id}.`);
    ids.add(source.source_id);
  }
  normalized.sort((left, right) => left.source_id.localeCompare(right.source_id));
  return {
    inventory_contract_version: PHASE2_INVENTORY_CONTRACT_VERSION,
    candidate_id: nullableString(candidateId),
    assignment_sha256: nullableString(assignmentSha256),
    sources: normalized
  };
}

/** Serialize the canonical object as compact deterministic UTF-8 JSON. */
export function serializePhase2Inventory(input = {}) {
  return stableJson(canonicalizePhase2Inventory(input));
}

/** Hash only the canonical inventory serialization, never a derived packet. */
export function hashPhase2Inventory(input = {}) {
  return sha256(serializePhase2Inventory(input));
}

// Compatibility names delegate to the single implementation. They contain no
// alternate serialization logic and remain temporarily available to callers
// that have not yet migrated to the explicit API names.
export const canonicalInventory = canonicalizePhase2Inventory;
export const canonicalInventorySha256 = hashPhase2Inventory;

export function inventoryFromReadiness(readinessInventory = {}) {
  return canonicalizePhase2Inventory(readinessInventory);
}

export function inventoryFromRuntime({ candidateId = null, assignmentSha256 = null, documents = [], sources = [] } = {}) {
  const records = sources.length ? sources : documents.map(document => ({
    source_id: document.id ?? document.source_id,
    requested_url: document.requested_url ?? document.url,
    canonical_url: document.canonical_url ?? document.url,
    title: document.title,
    publisher: document.publisher,
    published_at: document.published_at,
    classification: document.classification ?? document.source_type,
    source_type: document.source_type,
    independence_key: document.independence_key,
    primary_source: document.primary_source,
    accessible: document.accessible,
    ok: document.ok,
    retained_text: document.content ?? document.text,
    retained_text_sha256: document.retained_text_sha256,
    raw_sha256: document.raw_sha256,
    retained_from_full_text_sha256: document.retained_from_full_text_sha256,
    capture_mode: document.capture_mode
  }));
  return canonicalizePhase2Inventory({ candidateId, assignmentSha256, sources: records });
}

export function assertInventoryChecksum({ expected, actual, label = 'inventory' } = {}) {
  if (!expected || !actual || expected !== actual) {
    const error = new Error(`${label} canonical checksum mismatch.`);
    error.code = 'PHASE2_INVENTORY_CHECKSUM_MISMATCH';
    error.details = { label, expected: expected || null, actual: actual || null };
    throw error;
  }
  return true;
}

/**
 * Recompute both sides of the readiness/runtime identity contract. This is
 * used before provider setup and by offline audits; it deliberately does not
 * construct or import a provider adapter.
 */
export function verifyPhase2InventoryIdentity({ candidateId = null, assignmentSha256 = null, readinessInventory = {}, runtimeInventory = {}, expectedReadinessSha256 = null } = {}) {
  const readiness = canonicalizePhase2Inventory({ candidateId, assignmentSha256, sources: readinessInventory.sources || readinessInventory.inventory || [] });
  const runtime = canonicalizePhase2Inventory({ candidateId, assignmentSha256, sources: runtimeInventory.sources || runtimeInventory.inventory || [] });
  const readinessInventorySha256 = hashPhase2Inventory(readiness);
  const runtimeInventorySha256 = hashPhase2Inventory(runtime);
  if (expectedReadinessSha256) assertInventoryChecksum({ expected: expectedReadinessSha256, actual: readinessInventorySha256, label: 'readiness inventory' });
  assertInventoryChecksum({ expected: readinessInventorySha256, actual: runtimeInventorySha256, label: 'runtime inventory' });
  return { readiness, runtime, readinessInventorySha256, runtimeInventorySha256 };
}
