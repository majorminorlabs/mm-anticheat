import { normalizeUrl } from './acquisition.mjs';

const clean = value => String(value ?? '').trim();

function packetUrl(source) {
  return clean(source?.url || source?.canonical_url || source?.requested_url);
}

function normalizedPacketUrl(value) {
  try { return normalizeUrl(value); } catch { return clean(value); }
}

function duplicateIsExplicitlyCollapsed(source, previous) {
  const duplicateOf = clean(source?.duplicate_of || source?.duplicate_source_id);
  return Boolean(duplicateOf && previous?.source_id === duplicateOf);
}

/**
 * Bind review documents exclusively from a frozen packet. The packet URL is
 * authoritative for display and identity; retained documents only contribute
 * already-persisted text and provenance metadata. This function never fetches.
 */
export function bindFrozenPacketDocuments({ candidate, run, packet, retainedDocuments = [], requireContent = true } = {}) {
  if (!candidate?.id || !run?.id || !packet || !Array.isArray(packet.sources)) {
    throw new Error('Frozen packet, candidate, and run are required to bind review documents.');
  }
  const retainedById = new Map(retainedDocuments.map(document => [document.id, document]));
  const documents = [];
  const seenUrls = new Map();
  const collapsedSourceIds = [];

  for (const source of packet.sources) {
    const sourceId = clean(source?.source_id || source?.id);
    const displayUrl = packetUrl(source);
    if (!sourceId) throw new Error('Frozen packet source is missing source_id.');
    if (!displayUrl) throw new Error(`Frozen packet source ${sourceId} is missing a URL.`);
    const normalizedUrl = normalizedPacketUrl(displayUrl);
    const previous = seenUrls.get(normalizedUrl);
    if (previous) {
      if (duplicateIsExplicitlyCollapsed(source, previous)) {
        collapsedSourceIds.push(sourceId);
        continue;
      }
      throw new Error(`Frozen packet contains duplicate normalized URL ${normalizedUrl}.`);
    }
    seenUrls.set(normalizedUrl, source);
    const retained = retainedById.get(sourceId) || {};
    const content = clean(retained.content ?? retained.extraction?.text ?? retained.text);
    const accessible = source.accessible !== false && source.ok !== false;
    if (!accessible || (requireContent && !content)) throw new Error(`Frozen packet source ${sourceId} has no retained accessible text.`);
    const document = {
      id: sourceId,
      candidate_id: candidate.id,
      processing_run_id: run.id,
      discovery_id: retained.discovery_id || sourceId,
      // Keep the exact packet URL for displayed source links. The normalized
      // value is only used for duplicate detection and persistence matching.
      requested_url: displayUrl,
      url: displayUrl,
      canonical_url: displayUrl,
      normalized_url: normalizedUrl,
      title: source.title || retained.title || candidate.title || '',
      description: source.description || retained.description || '',
      author: source.author || retained.author || null,
      published_at: source.published_at || retained.published_at || null,
      publisher: source.publisher || retained.publisher || null,
      content,
      source_type: source.classification || source.source_type || retained.source_type || 'original_reporting',
      classification: source.classification || source.source_type || retained.classification || null,
      independence_key: source.independence_key || retained.independence_key || null,
      primary_source: source.primary_source === true,
      accessible: true,
      ok: true,
      raw_sha256: source.raw_sha256 || retained.raw_sha256 || null,
      retained_text_sha256: source.retained_text_sha256 || retained.retained_text_sha256 || null,
      retained_from_full_text_sha256: source.retained_from_full_text_sha256 || retained.retained_from_full_text_sha256 || null,
      retrieval_diagnostics: source.retrieval_diagnostics || retained.retrieval_diagnostics || null,
      capture_mode: source.capture_mode || 'frozen_evidence_packet',
      retrieval_timestamp: source.retrieval_diagnostics?.captured_at || retained.retrieval_timestamp || null,
      provenance: { ...(retained.provenance || {}), retrieval: 'frozen_evidence_packet', source_id: sourceId },
      extraction: retained.extraction || { ok: true, text: content, source: 'frozen_evidence_packet' },
      retention: { score: 1, reason: 'frozen_packet_source_identity' }
    };
    documents.push(document);
  }
  return { documents, collapsed_source_ids: collapsedSourceIds };
}

export function frozenPacketSourceLinks(packet = {}, documents = []) {
  const byId = new Map(documents.map(document => [document.id, document]));
  return (packet.sources || []).map(source => {
    const sourceId = clean(source?.source_id || source?.id);
    const document = byId.get(sourceId);
    return {
      source_id: sourceId,
      url: packetUrl(source),
      title: source.title || document?.title || sourceId,
      publisher: source.publisher || document?.publisher || null,
      classification: source.classification || source.source_type || document?.classification || null,
      claim_ids: [...new Set((packet.claims || []).filter(claim => (claim.source_ids || []).includes(sourceId)).map(claim => claim.claim_id))],
      evidence_ids: [...new Set((packet.claims || []).flatMap(claim => (claim.evidence || []).filter(evidence => evidence.source_id === sourceId).map(evidence => evidence.evidence_id)))]
    };
  });
}
