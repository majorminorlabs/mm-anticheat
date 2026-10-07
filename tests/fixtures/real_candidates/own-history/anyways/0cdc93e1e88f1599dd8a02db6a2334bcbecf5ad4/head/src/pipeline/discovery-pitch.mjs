import {
  BEAT_ORDER,
  SECTION_ORDER,
  STORY_FORM_ORDER,
  canonicalBeatId,
  canonicalSectionId,
  canonicalStoryFormId
} from '../editorial.mjs';

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();

export function normalizeEditorialRejectionReason(reason = '') {
  const text = clean(reason);
  if (/parenting suggestion|parenting hack|reaction story.*executive/i.test(text)) {
    return 'The available reporting centers on one executive’s parenting suggestion and the reaction around it. We did not find enough evidence of a broader shift in behavior, culture, power, or systems to justify a full story.';
  }
  if (/executive-origin anecdote|personal commentary|one executive/i.test(text)) {
    return 'The available reporting centers on one executive’s personal anecdote. We did not find enough evidence of a broader shift in behavior, culture, power, or systems to justify a full story.';
  }
  if (!text) return 'The available reporting does not yet support a full Anyways story.';
  const normalized = text
    .replace(/\bThis is\b/gi, 'The available reporting is')
    .replace(/\bdoes not establish\b/gi, 'did not establish')
    .replace(/\bdoes not show\b/gi, 'did not show')
    .replace(/\bdoes not reveal\b/gi, 'did not reveal')
    .replace(/\bIt does not\b/gi, 'It did not')
    .replace(/\bthe lead\b/gi, 'the available reporting');
  return clean(normalized).slice(0, 320);
}

function sourceKey(source = {}) {
  if (source.is_placeholder || source.placeholder || /^about:blank$/i.test(clean(source.url || source.canonical_url || ''))) return null;
  const raw = source.canonical_url || source.normalized_url || source.url;
  if (raw) {
    try {
      const url = new URL(raw);
      if (/^(?:example\.(?:com|org|net)|localhost)$/i.test(url.hostname)) return null;
      url.search = '';
      url.hash = '';
      return `${url.protocol}//${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/, '') || '/'}`;
    } catch {
      const normalized = clean(raw).replace(/[?#].*$/, '').replace(/\/+$/, '');
      if (normalized) return normalized.toLowerCase();
    }
  }
  return source.id ? `source:${source.id}` : null;
}

export function distinctSourceCount(candidate = {}, sourceRows = []) {
  const keys = new Set((Array.isArray(sourceRows) ? sourceRows : []).map(sourceKey).filter(Boolean));
  if (candidate.canonical_url) {
    const leadKey = sourceKey({ url: candidate.canonical_url });
    if (leadKey) keys.add(leadKey);
  }
  return keys.size;
}

function sourceWarning(pitch, sourceCount) {
  if (sourceCount !== 1) return null;
  const text = clean(`${pitch.headline || ''} ${pitch.lens || ''} ${pitch.section_answer || ''} ${pitch.why_now || ''}`);
  if (pitch.research_requirement === 'required' || /\b(legal|law|court|government|politic|election|financial|bank|market|medical|health|doctor|investigat|contested|dispute|subpoena|leak)\b/i.test(text)) {
    return 'Source depth is thin. This pitch currently relies on one retained source.';
  }
  return null;
}

export function pitchRecord(candidate = {}, sourceCount = null) {
  const classification = candidate.classification || {};
  const pitch = classification.editorial_pitch || {};
  const lens = canonicalSectionId(pitch.primary_section || classification.primary_section || '');
  const section = canonicalStoryFormId(pitch.story_form || classification.story_form || '');
  const persistedBeats = Array.isArray(pitch.beats) && pitch.beats.length ? pitch.beats : classification.recurring_beats;
  const beats = [...new Set((Array.isArray(persistedBeats) ? persistedBeats : []).map(canonicalBeatId).filter(Boolean))];
  const retainedSourceCount = sourceCount === null ? distinctSourceCount(candidate) : Number(sourceCount || 0);
  const record = {
    headline: candidate.title || pitch.headline || 'Untitled pitch',
    pitch: pitch.reader_takeaway || pitch.section_answer || pitch.lens || classification.source_summary || '',
    why: pitch.why_now || '',
    lens,
    section,
    beats,
    sourceCount: retainedSourceCount,
    discoveryDate: candidate.created_at,
    accepted: pitch.accepted === true,
    sourceProposalId: classification.source_proposal_id || null
  };
  return { ...record, warnings: sourceWarning(pitch, retainedSourceCount) ? [sourceWarning(pitch, retainedSourceCount)] : [] };
}

export function editorReadyPitch(pitch = {}) {
  return Boolean(
    pitch.accepted
    && pitch.headline
    && pitch.pitch
    && pitch.why
    && SECTION_ORDER.includes(pitch.lens)
    && STORY_FORM_ORDER.includes(pitch.section)
    && pitch.beats?.length
    && pitch.beats.every(beat => BEAT_ORDER.includes(beat))
    && pitch.sourceCount > 0
  );
}

export function pitchInboxStatus(candidate = {}, pitch = {}) {
  const enrichment = candidate.classification?.discovery_enrichment || {};
  if (candidate.classification?.origin === 'source_graph_qwen') {
    if (candidate.status === 'pitch_ready' && editorReadyPitch(pitch)) return 'pitch';
    if (enrichment.status === 'queued') return 'queued';
    if (enrichment.status === 'writing') return 'generating';
    if (enrichment.status === 'failed') return 'failed';
    return null;
  }
  if (candidate.status === 'discovered' && enrichment.status === 'queued') return null;
  if (candidate.status === 'pitch_ready' && editorReadyPitch(pitch)) return 'pitch';
  if (candidate.status === 'discovered' && enrichment.status === 'processing') return 'processing';
  if (candidate.status === 'discovered' && !enrichment.status) return 'needs_attention';
  if (enrichment.status === 'failed' || (candidate.status === 'pitch_ready' && !editorReadyPitch(pitch))) return 'needs_attention';
  if (candidate.status === 'rejected' && enrichment.status === 'rejected') return 'passed';
  return null;
}

export function discoveryEnrichmentRetryable(candidate = {}) {
  if (!['discovered', 'rejected'].includes(candidate.status)) return false;
  const marker = candidate.classification?.discovery_enrichment;
  return !marker || ['failed', 'processing'].includes(marker.status);
}

export function pitchEnrichmentReason(candidate = {}) {
  return candidate.classification?.discovery_enrichment?.reason
    || candidate.classification?.discovery_enrichment?.last_error
    || candidate.classification?.editorial_pitch?.rejection_reason
    || (!candidate.classification?.discovery_enrichment ? 'This discovery record predates pitch enrichment.' : 'Pitch enrichment did not produce a commissionable editorial record.');
}
