import { stableJson } from './evidence-packet.mjs';
import { PHASE1_SOURCE_ID_MAX_LENGTH, TERRA_EVIDENCE_CONTRACT_VERSION, TERRA_EVIDENCE_MAX_RANGE_CHARACTERS, TERRA_OUTPUT_EXAMPLE, TERRA_PROMPT_SCHEMA_CONTRACT } from './phase1-schemas.mjs';
import { deterministicClaimEvidenceSupportMatrix, supportMatrixExamples } from './luna-support.mjs';

const clean = value => String(value ?? '').trim();
const assignmentFor = candidate => ({
  brief: clean(candidate.commission?.brief || candidate.description || candidate.title),
  section: clean(candidate.commission?.section_id || candidate.classification?.primary_section || 'internet'),
  story_form: clean(candidate.commission?.story_form || candidate.classification?.story_form || 'meanwhile'),
  beats: candidate.commission?.beats || candidate.classification?.recurring_beats || [],
  tags: candidate.commission?.tags || candidate.classification?.tags || [],
  notes: clean(candidate.commission?.notes),
  title: clean(candidate.title)
});

const packetForModel = packet => ({
  version: packet.version,
  terra_evidence_contract_version: packet.terra_evidence_contract_version || null,
  frozen_evidence_packet_sha256: packet.frozen_evidence_packet_sha256 || null,
  sources: packet.sources,
  claims: packet.claims,
  claim_targets: packet.claim_targets,
  required_facts: packet.required_facts,
  prohibited_claims: packet.prohibited_claims,
  ledgers: packet.ledgers,
  unresolved_research_questions: packet.unresolved_research_questions,
  blockers: packet.blockers,
  draft_constraints: packet.draft_constraints || [],
  terra_summary: packet.terra_summary || null,
  totals: packet.totals
});

export function terraPrompt({ candidate, sourceInventory, researchQuestions = [] } = {}) {
  const assignment = assignmentFor(candidate);
  return [
    'You are Terra High, the research and evidence stage for an editorial pipeline.',
    'Return one JSON object only. Do not use Markdown fences. Do not browse, call tools, or invent sources.',
    'Use only the system-fetched source inventory below. Assess sources, select evidence, and decide whether drafting is safe.',
    'Blockers are publication blockers, not every desirable reporting improvement. Use a blocker only for an unsupported required claim, unverifiable central assertion, material conflict, unavailable mandatory source or source class, unsatisfiable story-form requirement, speculative causal framing, or legal, safety, fairness, or attribution concern. Put useful but nonessential gaps in missing_evidence. Include every required field, including ledgers, claim targets, and draft_constraints.',
    `The output contract below is authoritative and matches the fail-closed validator. This run uses Terra evidence contract ${TERRA_EVIDENCE_CONTRACT_VERSION}. Every source reference is one exact source_id from the inventory and must be a non-empty string of at most ${PHASE1_SOURCE_ID_MAX_LENGTH} characters. Never concatenate, abbreviate, normalize, repair, or invent source IDs.`,
    'blockers must be an array of structured objects, never strings. Each blocker object has exactly these fields: required blocker_id, question, reason, required_action; optional source_ids as a non-null array of exact source IDs. There are no blocker enums and no nullable blocker fields. Use blockers: [] when there is no blocker. A valid blocker example is {"blocker_id":"blocker-1","question":"What changed?","reason":"The official record is missing.","required_action":"Obtain the official record.","source_ids":["source-id-from-inventory"]}.',
    'contradictions must be an array of structured objects, never strings. Use contradictions: [] when no retained sources materially conflict. Each contradiction object must contain exactly contradiction_id, claim_id, source_ids, description, and resolution. contradiction_id and claim_id must be exact IDs from the supplied ledgers; source_ids must be a nonempty array of exact inventory IDs. Description and resolution must be concise nonempty strings. A contradiction is publication-relevant only when it affects a required claim; resolve it using the retained evidence or make it a blocker when publication cannot proceed. Valid example: {"contradiction_id":"contradiction-1","claim_id":"claim-1","source_ids":["source-id-from-inventory"],"description":"Two retained sources report different dates.","resolution":"Use the enacted record and attribute the discrepancy."}.',
    `freshness_risks and missing_evidence are arrays of non-empty strings, never objects. Claims contain evidence references, not copied text. Each evidence record must contain source_id, zero-based start_offset, end_offset, claim_ids, evidence_role, and a concise reason. Offsets are JavaScript string indices into the exact UTF-8-decoded retained_text supplied below: start inclusive and end exclusive. The exact retained_text representation is authoritative: do not normalize whitespace, convert newlines, decode HTML entities, apply Unicode normalization, insert ellipses, join spans, or quote/return excerpt text. Each range must be one contiguous span, start >= 0, end > start, end <= retained_text.length, contain at least one non-whitespace character, and be at most ${TERRA_EVIDENCE_MAX_RANGE_CHARACTERS} characters. Use separate evidence records for separate spans. Valid example: {"source_id":"source-001","start_offset":120,"end_offset":284,"claim_ids":["claim-001"],"evidence_role":"must_use","reason":"Supports the claim."}. Do not return excerpt, excerpt_sha256, source_text_sha256, or other derived evidence fields. draft_constraints must be a nonempty array of concise strings defining the maximum defensible scope. Set ready_to_draft to false for publication blockers or unanswered required questions; optional enrichment in missing_evidence alone is non-blocking.`,
    'Do not emit Markdown, commentary, a repaired second attempt, or a second JSON object. Return the one object matching this contract exactly.',
    'TERRA VALIDATOR CONTRACT', stableJson(TERRA_PROMPT_SCHEMA_CONTRACT),
    'ASSIGNMENT', stableJson(assignment),
    'RESEARCH QUESTIONS', stableJson(researchQuestions),
    'SYSTEM-FETCHED SOURCE INVENTORY (retained_text is exact and must be indexed without alteration)', stableJson(packetForModel(sourceInventory)),
    'OUTPUT SCHEMA EXAMPLE (replace placeholders only with exact inventory IDs and offsets; never add excerpt text)', stableJson(TERRA_OUTPUT_EXAMPLE)
  ].join('\n\n');
}

export function lunaDraftPrompt({ candidate, packet } = {}) {
  const assignment = assignmentFor(candidate);
  const supportMatrix = deterministicClaimEvidenceSupportMatrix(packet);
  const examples = supportMatrixExamples(supportMatrix);
  return [
    'You are Luna High, the drafting stage for an editorial pipeline.',
    'Return one JSON object only. Do not use Markdown fences. Write a complete article in body_markdown.',
    'Use only the frozen evidence packet below. Do not browse, call tools, use outside references, or rely on a prior draft.',
    'Every material claim must map to a claim record and evidence_id from this packet. Do not add unsupported names, numbers, or quotations.',
    'The packet excerpts are authoritative and already frozen. Cite them with evidence_id only; never return excerpt text, source_text, excerpt checksums, or copied evidence objects.',
    'Do not infer claim coverage from excerpt prose. Use the support matrix below as the complete allow-list. For each claim_support entry, every evidence_id must be a subset of the listed evidence IDs for that exact claim. Evidence listed for another claim cannot be reused.',
    'Use treatment only as paraphrase, direct_quote, attributed_claim, or context. For direct_quote, reproduce only an exact contiguous substring of the cited packet excerpt. Do not use ellipses, HTML entity decoding, whitespace normalization, or punctuation repair.',
    'ASSIGNMENT', stableJson(assignment),
    'FROZEN EVIDENCE PACKET', stableJson(packetForModel(packet)),
    'CLAIM-TO-EVIDENCE SUPPORT MATRIX (authoritative; required claims only)', stableJson(supportMatrix),
    'VALID MAPPING EXAMPLE', stableJson(examples.valid),
    'INVALID MAPPING EXAMPLE (evidence belongs to another claim and must be rejected)', stableJson(examples.invalid),
    'Draft constraints are part of the frozen packet. Obey every constraint and do not expand beyond the maximum defensible scope.',
    'OUTPUT SCHEMA', stableJson({ headline: 'string', dek: 'string', body_markdown: '# Headline\n\n*Dek*\n\nArticle body.', section: assignment.section, lens: 'string', beats: assignment.beats, claim_support: [{ claim_id: 'claim-1', evidence_ids: ['evidence-001'], article_anchor: 'paragraph-1', treatment: 'paraphrase' }], warnings: [] })
  ].join('\n\n');
}

export function lunaRevisionPrompt({ candidate, packet, draft, findings, instructions = '' } = {}) {
  const supportMatrix = deterministicClaimEvidenceSupportMatrix(packet);
  const examples = supportMatrixExamples(supportMatrix);
  return [
    'You are Luna High revising a source-backed article after deterministic review.',
    'Return one JSON object only. Do not use Markdown fences. Return the complete revised article, not a patch.',
    'Use the same frozen evidence packet. Do not browse, call tools, add unsupported material, or change unaffected content.',
    'Correct blocking factual findings first, then required editorial fixes. Preserve accurate claims and retain source-backed claim_support mappings.',
    'Return only evidence_id references. Never return excerpt text, source_text, excerpt checksums, or copied evidence objects.',
    'Do not infer claim coverage from excerpt prose. Use the support matrix below as the complete allow-list. For each claim_support entry, every evidence_id must be a subset of the listed evidence IDs for that exact claim. Evidence listed for another claim cannot be reused.',
    'Use the exact same frozen_evidence_packet_sha256, evidence IDs, claim ledger, and draft constraints supplied to Draft.',
    'ASSIGNMENT', stableJson(assignmentFor(candidate)),
    'FROZEN EVIDENCE PACKET', stableJson(packetForModel(packet)),
    'CLAIM-TO-EVIDENCE SUPPORT MATRIX (authoritative; required claims only)', stableJson(supportMatrix),
    'VALID MAPPING EXAMPLE', stableJson(examples.valid),
    'INVALID MAPPING EXAMPLE (evidence belongs to another claim and must be rejected)', stableJson(examples.invalid),
    'Draft constraints are identical to the Draft stage. Preserve them and do not expand beyond the maximum defensible scope.',
    'DRAFT TO REVISE', stableJson(draft),
    'DETERMINISTIC FINDINGS', stableJson(findings),
    'EDITORIAL INSTRUCTIONS', clean(instructions) || 'Resolve the findings and return the cleanest supported article.',
    'OUTPUT SCHEMA', stableJson({ headline: draft.headline, dek: draft.dek, body_markdown: draft.body_markdown, section: draft.section, lens: draft.lens, beats: draft.beats, source_ids: draft.source_ids, changed_claim_ids: [], revision_notes: [], claim_support: draft.claim_support || [], warnings: [] })
  ].join('\n\n');
}

export function parseStrictJson(raw, stage) {
  if (typeof raw !== 'string' || !raw.trim()) {
    const error = new Error(`${stage} returned no content.`); error.code = 'PHASE2_EMPTY_RESPONSE'; throw error;
  }
  try { return JSON.parse(raw); }
  catch (cause) {
    const error = new Error(`${stage} returned invalid JSON: ${cause.message}`); error.code = 'PHASE2_INVALID_JSON'; error.details = { stage, raw_response: raw }; throw error;
  }
}
