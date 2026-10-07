import crypto from 'node:crypto';
import { STORY_FORM_BY_ID } from '../editorial.mjs';
import { classifySource } from './evidence-packet.mjs';

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const hash = value => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const sourceText = source => String(source?.content ?? source?.extracted_text ?? source?.text ?? source?.excerpt ?? '').trim();
const sourceUrl = source => clean(source?.canonical_url || source?.url);

// These are deliberately explicit per-form contracts. The accessible-source
// floor follows editorial doctrine; independent and primary floors encode the
// evidence language without imposing one universal rule on every form.
export const PHASE2_SOURCE_REQUIREMENTS = Object.freeze({
  meanwhile: Object.freeze({ minimumAccessibleSources: 3, minimumIndependentSources: 2, minimumPrimarySources: 0 }),
  'while-youre-here': Object.freeze({ minimumAccessibleSources: 5, minimumIndependentSources: 3, minimumPrimarySources: 0 }),
  'worth-your-time': Object.freeze({ minimumAccessibleSources: 6, minimumIndependentSources: 4, minimumPrimarySources: 1 }),
  receipts: Object.freeze({ minimumAccessibleSources: 10, minimumIndependentSources: 6, minimumPrimarySources: 2 }),
  anyways: Object.freeze({ minimumAccessibleSources: 10, minimumIndependentSources: 6, minimumPrimarySources: 1 }),
  'we-read-it': Object.freeze({ minimumAccessibleSources: 6, minimumIndependentSources: 4, minimumPrimarySources: 1 }),
  builders: Object.freeze({ minimumAccessibleSources: 6, minimumIndependentSources: 4, minimumPrimarySources: 1 }),
  systems: Object.freeze({ minimumAccessibleSources: 10, minimumIndependentSources: 6, minimumPrimarySources: 2 })
});

function formRequirements(candidate) {
  const formId = candidate?.commission?.story_form || candidate?.classification?.story_form || 'meanwhile';
  const form = STORY_FORM_BY_ID[formId] || STORY_FORM_BY_ID.meanwhile;
  return { formId: form.id, ...PHASE2_SOURCE_REQUIREMENTS[form.id] };
}

function sourceForCounting(document) {
  const record = document?.record && typeof document.record === 'object' ? document.record : {};
  return { ...record, ...document, content: document?.content ?? record.content, source_type: document?.source_type ?? record.source_type };
}

function explicitCoverageKey(source) {
  const provenance = source.provenance || {};
  const value = source.independence_key
    || source.source_group_id
    || source.original_source_url
    || source.syndicated_from
    || provenance.independence_key
    || provenance.source_group_id
    || provenance.original_source_url
    || provenance.syndicated_from;
  return clean(value).toLowerCase() || null;
}

function coverageKey(source) {
  const explicit = explicitCoverageKey(source);
  if (explicit) return `group:${explicit}`;
  const text = sourceText(source).replace(/\s+/g, ' ').toLowerCase();
  if (text) return `text:${hash(text)}`;
  return `url:${sourceUrl(source).toLowerCase()}`;
}

function diagnosticLabel(diagnostic) {
  const status = diagnostic.status === null || diagnostic.status === undefined ? '' : ` HTTP ${diagnostic.status}`;
  return `${diagnostic.url || diagnostic.source_id || 'commissioned source'}${status}${diagnostic.error ? ` (${diagnostic.error})` : ''}`;
}

const urlKey = value => clean(value).toLowerCase();
const arrayOf = value => Array.isArray(value) ? value : [];

function explicitMandatorySourceUrls(candidate, mandatorySourceUrls) {
  return new Set([
    ...arrayOf(candidate?.commission?.mandatory_source_urls),
    ...arrayOf(candidate?.commission?.required_source_urls),
    ...arrayOf(mandatorySourceUrls)
  ].map(urlKey).filter(Boolean));
}

function explicitMandatorySourceIds(candidate) {
  return new Set([
    ...arrayOf(candidate?.commission?.mandatory_source_ids),
    ...arrayOf(candidate?.commission?.required_source_ids)
  ].map(clean).filter(Boolean));
}

function requiredClaimSpecs(candidate, requiredClaims) {
  return [
    ...arrayOf(candidate?.commission?.required_claims),
    ...arrayOf(candidate?.commission?.required_claim_sources),
    ...arrayOf(requiredClaims)
  ].filter(item => item && typeof item === 'object');
}

function blocker(blockerId, question, reason, requiredAction, sourceIds = []) {
  return { blocker_id: blockerId, question, reason, required_action: requiredAction, ...(sourceIds.length ? { source_ids: sourceIds } : {}) };
}

function authorizedOverride(value) {
  return Boolean(value?.approved === true
    && clean(value.actor)
    && clean(value.reason)
    && clean(value.approved_at || value.approvedAt)
    && clean(value.authorization_id || value.authorizationId));
}

export function sourceSufficiencyGate({ candidate, documents = [], fetchDiagnostics = [], override = null, mandatorySourceUrls = [], requiredClaims = [] } = {}) {
  const requirements = formRequirements(candidate);
  const mandatoryUrls = explicitMandatorySourceUrls(candidate, mandatorySourceUrls);
  const mandatoryIds = explicitMandatorySourceIds(candidate);
  const seenIds = new Set();
  const counted = [];
  for (const document of Array.isArray(documents) ? documents : []) {
    const source = sourceForCounting(document);
    const id = clean(document?.id || document?.source_id || source.id);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const classification = classifySource(source);
    const textAvailable = Boolean(sourceText(source));
    if (classification === 'unusable' || !textAvailable) continue;
    counted.push({ id, classification, coverage_key: coverageKey(source), url: sourceUrl(source) });
  }

  const independentKeys = new Set(counted.map(source => source.coverage_key));
  const primarySources = counted.filter(source => source.classification === 'primary');
  const missing = [];
  const failureCategories = new Set();
  if (counted.length < requirements.minimumAccessibleSources) {
    failureCategories.add('thresholds_not_met');
    missing.push(blocker(
      'source-count',
      `Does the commissioned ${requirements.formId} story have enough accessible source artifacts?`,
      `Only ${counted.length} accessible extracted or approved-snapshot sources are available; ${requirements.minimumAccessibleSources} are required for ${requirements.formId}.`,
      `Obtain ${requirements.minimumAccessibleSources - counted.length} more accessible source artifact(s) through the approved retrieval policy. A URL or snippet alone is insufficient.`,
      counted.map(source => source.id)
    ));
  }
  if (independentKeys.size < requirements.minimumIndependentSources) {
    failureCategories.add('thresholds_not_met');
    missing.push(blocker(
      'independent-source-count',
      `Are the sources independent enough to support the ${requirements.formId} story?`,
      `Only ${independentKeys.size} independent coverage group(s) remain after duplicate and syndicated coverage is collapsed; ${requirements.minimumIndependentSources} are required.`,
      'Obtain independently reported or first-party source material. Multiple derivative articles from one original report count as one coverage group.',
      counted.map(source => source.id)
    ));
  }
  if (primarySources.length < requirements.minimumPrimarySources) {
    failureCategories.add('thresholds_not_met');
    missing.push(blocker(
      'primary-source-availability',
      `Is the required primary or first-party source material available for the ${requirements.formId} story?`,
      `Only ${primarySources.length} primary or first-party source artifact(s) are available; ${requirements.minimumPrimarySources} are required.`,
      `Obtain ${requirements.minimumPrimarySources - primarySources.length} primary or first-party retained document(s) through the approved retrieval policy.`,
      primarySources.map(source => source.id)
    ));
  }

  const inaccessible = [];
  const mandatoryInaccessible = [];
  const optionalInaccessible = [];
  const warnings = [];
  for (const diagnostic of Array.isArray(fetchDiagnostics) ? fetchDiagnostics : []) {
    if (diagnostic.duplicate || diagnostic.accessible === true) continue;
    if (diagnostic.accessible == null && diagnostic.ok === true && diagnostic.extraction_status !== 'empty' && diagnostic.extraction_status !== 'failed') continue;
    const sourceId = clean(diagnostic.source_id);
    const sourceUrl = urlKey(diagnostic.url || diagnostic.canonical_url);
    const mandatory = diagnostic.mandatory === true
      || diagnostic.required === true
      || mandatoryIds.has(sourceId)
      || mandatoryUrls.has(sourceUrl);
    const record = {
      source_id: diagnostic.source_id || null,
      url: diagnostic.url || null,
      status: diagnostic.status ?? diagnostic.http_status ?? null,
      error: diagnostic.error || diagnostic.extraction_error || 'inaccessible_source',
      extraction_status: diagnostic.extraction_status || null,
      access_mode: diagnostic.access_mode || 'unavailable',
      category: mandatory ? 'mandatory_source_unavailable' : 'optional_source_unavailable'
    };
    inaccessible.push(record);
    if (mandatory) mandatoryInaccessible.push(record);
    else {
      optionalInaccessible.push(record);
      warnings.push({ ...record, warning: `${diagnosticLabel(diagnostic)} was unavailable but is optional because usable source thresholds are evaluated from retained artifacts.` });
    }
  }
  for (const diagnostic of mandatoryInaccessible) {
    failureCategories.add('mandatory_source_unavailable');
    missing.push(blocker(
      `mandatory-source-unavailable-${hash(diagnostic.url || diagnostic.source_id).slice(0, 12)}`,
      `Can the commissioned source ${diagnostic.url || diagnostic.source_id || 'artifact'} be used as evidence?`,
      `${diagnosticLabel(diagnostic)} was not usable as extracted text or an approved stored snapshot.`,
      'Provide an approved stored snapshot, approved archived document, or retained primary-document content for this source before research can begin.',
      diagnostic.source_id ? [diagnostic.source_id] : []
    ));
  }

  const countedUrls = new Set(counted.map(source => urlKey(source.url)).filter(Boolean));
  const countedSourceIds = new Set(counted.map(source => clean(source.id)).filter(Boolean));
  for (const spec of requiredClaimSpecs(candidate, requiredClaims)) {
    const claimId = clean(spec.claim_id || spec.id || spec.claim || 'required-claim');
    const sourceUrls = [
      ...arrayOf(spec.source_urls),
      ...arrayOf(spec.required_source_urls),
      ...arrayOf(spec.mandatory_source_urls)
    ].map(urlKey).filter(Boolean);
    const sourceIds = [
      ...arrayOf(spec.source_ids),
      ...arrayOf(spec.required_source_ids),
      ...arrayOf(spec.mandatory_source_ids)
    ].map(clean).filter(Boolean);
    if (!sourceUrls.length && !sourceIds.length) continue;
    const supported = sourceUrls.some(url => countedUrls.has(url)) || sourceIds.some(id => countedSourceIds.has(id));
    if (supported) continue;
    failureCategories.add('required_claim_unsupported');
    const unavailable = [...sourceUrls, ...sourceIds].join(', ');
    missing.push(blocker(
      `required-claim-unsupported-${hash(claimId).slice(0, 12)}`,
      `Can the required claim ${claimId} be supported by retained evidence?`,
      `No usable retained source remains for required claim ${claimId}; its specified source support is unavailable (${unavailable}).`,
      'Retain the uniquely supporting source or revise the required claim assignment before research can begin.',
      sourceIds
    ));
  }

  const validOverride = authorizedOverride(override);
  const overridden = missing.length > 0 && validOverride;
  return {
    ok: missing.length === 0 || overridden,
    overridden,
    override: validOverride ? {
      approved: true,
      actor: clean(override.actor),
      reason: clean(override.reason),
      approved_at: clean(override.approved_at || override.approvedAt),
      authorization_id: clean(override.authorization_id || override.authorizationId)
    } : null,
    requirements,
    counts: {
      accessible: counted.length,
      independent: independentKeys.size,
      primary: primarySources.length,
      inaccessible: inaccessible.length,
      derivative: counted.filter(source => source.classification === 'derivative_reporting').length,
      duplicate_or_syndicated_groups: counted.length - independentKeys.size
    },
    sources: counted,
    inaccessible,
    mandatory_inaccessible: mandatoryInaccessible,
    optional_inaccessible: optionalInaccessible,
    warnings,
    missing,
    failure_categories: [...failureCategories],
    status: missing.length && !overridden ? 'research_blocked' : 'ready_for_terra',
    code: missing.length && !overridden ? 'PHASE2_SOURCE_INSUFFICIENT' : null,
    human_override_required: missing.length > 0,
    automatic_override: false
  };
}

export function sourceGateBlockers(result) {
  return (result?.missing || []).map(item => ({
    blocker_id: item.blocker_id,
    question: item.question,
    reason: item.reason,
    required_action: item.required_action,
    ...(item.source_ids?.length ? { source_ids: item.source_ids } : {})
  }));
}
