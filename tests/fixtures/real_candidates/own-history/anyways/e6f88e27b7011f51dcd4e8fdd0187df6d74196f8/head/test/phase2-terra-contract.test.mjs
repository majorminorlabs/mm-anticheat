import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildEvidencePacket, stableJson } from '../src/pipeline/evidence-packet.mjs';
import { assertPhase1Schema, PHASE1_SCHEMAS, PHASE1_SOURCE_ID_MAX_LENGTH, TERRA_EVIDENCE_CONTRACT_VERSION, TERRA_EVIDENCE_MAX_RANGE_CHARACTERS, TERRA_OUTPUT_EXAMPLE, TERRA_PROMPT_SCHEMA_CONTRACT, validatePhase1Schema } from '../src/pipeline/phase1-schemas.mjs';
import { validateTerraEvidenceOffsets } from '../src/pipeline/phase2-evidence.mjs';
import { terraPrompt } from '../src/pipeline/phase2-prompts.mjs';

const candidate = {
  title: 'A contract test',
  commission: { brief: 'Test the Terra output contract.', section_id: 'systems', story_form: 'systems', beats: [], tags: [] },
  classification: { primary_section: 'systems', story_form: 'systems' }
};
const packet = { version: 'pipeline-v1-source-inventory-offsets-v1', terra_evidence_contract_version: TERRA_EVIDENCE_CONTRACT_VERSION, checksum: 'inventory-checksum', sources: [], claims: [], claim_targets: [], required_facts: [], prohibited_claims: [], ledgers: { quotations: [], proper_names: [], numbers: [] }, unresolved_research_questions: [], blockers: [], totals: {} };

const validSourceId = 'source:1d01fdd20f83e9457143cd21b607606d30ec669638bc57f06ec982b780a62a06:057c4281b8acbc2a61d697b2';
const failedCase01OverlongSourceId = `${validSourceId}:${validSourceId.slice('source:'.length)}`;

function validTerra() {
  return {
    research_questions: [],
    selected_source_ids: [validSourceId],
    optional_source_ids: [],
    excluded_sources: [],
    claims: [{ claim_id: 'claim-1', claim: 'A supported claim.', source_ids: [validSourceId], evidence: [{ source_id: validSourceId, start_offset: 0, end_offset: 18, claim_ids: ['claim-1'], evidence_role: 'must_use', reason: 'Supports the claim.' }], confidence: 'high' }],
    required_facts: [],
    prohibited_claims: [],
    ledgers: { quotations: [], proper_names: [], numbers: [] },
    claim_targets: ['claim-1'],
    unresolved_research_questions: [],
    contradictions: [],
    freshness_risks: [],
    missing_evidence: [],
    blockers: [],
    draft_constraints: ['Attribute the claim to the retained source.'],
    ready_to_draft: true
  };
}

test('Terra prompt prints the same source-reference and field contract used by the validator', () => {
  const prompt = terraPrompt({ candidate, sourceInventory: packet, researchQuestions: [] });
  assert.equal(PHASE1_SOURCE_ID_MAX_LENGTH, 160);
  assert.ok(prompt.includes(stableJson(TERRA_PROMPT_SCHEMA_CONTRACT)));
  assert.ok(prompt.includes(stableJson(TERRA_OUTPUT_EXAMPLE)));
  assert.deepEqual(Object.keys(TERRA_OUTPUT_EXAMPLE).sort(), Object.keys(PHASE1_SCHEMAS.terra_research_evidence.properties).sort());
  assert.match(prompt, new RegExp(`at most ${PHASE1_SOURCE_ID_MAX_LENGTH} characters`));
  assert.match(prompt, /freshness_risks and missing_evidence are arrays of non-empty strings, never objects/);
  assert.match(prompt, /Claims contain evidence references, not copied text/);
  assert.match(prompt, /exact UTF-8-decoded retained_text/);
  assert.match(prompt, /start_offset/);
  assert.match(prompt, /separate evidence records for separate spans/);
  assert.match(prompt, /Do not return excerpt/);
  assert.match(prompt, /draft_constraints/);
  assert.match(prompt, /optional enrichment in missing_evidence alone is non-blocking/);
  assert.match(prompt, /contradictions must be an array of structured objects/);
  assert.match(prompt, /contradiction_id, claim_id, source_ids, description, and resolution/);
  assert.doesNotMatch(prompt, /evidence objects containing source_id and excerpt/);
  assert.deepEqual(validatePhase1Schema('terra_research_evidence', validTerra()), []);
  assert.equal(PHASE1_SCHEMAS.terra_research_evidence.properties.claims.items.properties.source_ids.items.maxLength, PHASE1_SOURCE_ID_MAX_LENGTH);
  assert.equal(PHASE1_SCHEMAS.research_blocker.properties.source_ids.items.maxLength, PHASE1_SOURCE_ID_MAX_LENGTH);
  assert.equal(PHASE1_SCHEMAS.terra_research_evidence.properties.freshness_risks.items.maxLength, 1_000);
  assert.equal(PHASE1_SCHEMAS.terra_research_evidence.properties.missing_evidence.items.maxLength, 1_000);
});

const evidenceRecord = (sourceId, startOffset, endOffset, overrides = {}) => ({
  source_id: sourceId,
  start_offset: startOffset,
  end_offset: endOffset,
  claim_ids: ['claim-1'],
  evidence_role: 'must_use',
  reason: 'Supports the claim.',
  ...overrides
});

const sourceText = 'Line one 😀\r\nThe frozen form is what&#x27;s indexed.\nLine three.';
const source = { id: 'source-001', content: sourceText, source_type: 'primary' };
const baseTerra = (evidence = [evidenceRecord(source.id, 0, sourceText.length)]) => ({
  ...validTerra(),
  claims: [{ claim_id: 'claim-1', claim: 'A supported claim.', source_ids: [source.id], evidence, confidence: 'high' }],
  selected_source_ids: [source.id],
  claim_targets: ['claim-1']
});

test('a contiguous range succeeds and derives the exact excerpt and provenance', () => {
  const result = validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, 0, 9)]), [source]);
  const evidence = result.claims[0].evidence[0];
  assert.equal(evidence.excerpt, sourceText.slice(0, 9));
  assert.equal(evidence.range_length, 9);
  assert.equal(evidence.excerpt_sha256, crypto.createHash('sha256').update(sourceText.slice(0, 9)).digest('hex'));
  assert.equal(evidence.source_text_sha256, crypto.createHash('sha256').update(sourceText).digest('hex'));
  assert.equal(result.terra_evidence_contract_version, TERRA_EVIDENCE_CONTRACT_VERSION);
  assert.equal('excerpt' in baseTerra().claims[0].evidence[0], false);
});

test('the Terra schema has no model-authored excerpt field, making omitted text, joined ellipses, and HTML decoding impossible', () => {
  const withExcerpt = baseTerra([evidenceRecord(source.id, 0, 9, { excerpt: 'Line one...Line three.' })]);
  const errors = validatePhase1Schema('terra_research_evidence', withExcerpt);
  assert.ok(errors.some(error => error.includes('excerpt is not allowed')));
  const secondStart = sourceText.indexOf('The frozen');
  const separate = validateTerraEvidenceOffsets(baseTerra([
    evidenceRecord(source.id, 0, 8),
    evidenceRecord(source.id, secondStart, sourceText.length, { reason: 'Supports the second source span.' })
  ]), [source]);
  assert.equal(separate.claims[0].evidence.length, 2);
  assert.equal(separate.claims[0].evidence[1].excerpt, sourceText.slice(secondStart));
  assert.equal(separate.claims[0].evidence[1].excerpt.includes('...'), false);
  assert.equal(separate.claims[0].evidence[1].excerpt.includes('&#x27;'), true);
});

test('Unicode, CRLF, and HTML entity representation remain stable under JavaScript offsets', () => {
  const start = sourceText.indexOf('😀');
  const end = sourceText.indexOf('Line three');
  const result = validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, start, end)]), [source]);
  assert.equal(result.claims[0].evidence[0].excerpt, sourceText.slice(start, end));
  assert.equal(result.claims[0].evidence[0].excerpt.includes('\r\n'), true);
  assert.equal(result.claims[0].evidence[0].excerpt.includes('what&#x27;s'), true);
  assert.equal(result.claims[0].evidence[0].excerpt.includes("what's"), false);
});

const invalidRangeCases = [
  ['invalid source ID', evidenceRecord('missing-source', 0, 1), /unknown source ID/],
  ['negative start', evidenceRecord(source.id, -1, 1), /negative start_offset/],
  ['end beyond source length', evidenceRecord(source.id, 0, sourceText.length + 1), /beyond the frozen source text/],
  ['reversed range', evidenceRecord(source.id, 4, 3), /reversed or zero-length/],
  ['zero-length range', evidenceRecord(source.id, 4, 4), /reversed or zero-length/],
  ['blank range', evidenceRecord(source.id, sourceText.indexOf(' '), sourceText.indexOf(' ') + 1), /blank range/],
  ['overlong range', evidenceRecord(source.id, 0, sourceText.length), /exceeds the/]
];

for (const [label, evidence, pattern] of invalidRangeCases) {
  test(`invalid Terra evidence range fails closed: ${label}`, () => {
    const maxExcerptCharacters = label === 'overlong range' ? 8 : TERRA_EVIDENCE_MAX_RANGE_CHARACTERS;
    assert.throws(() => validateTerraEvidenceOffsets(baseTerra([evidence]), [source], { maxExcerptCharacters }), error => error.code === 'PHASE2_SCHEMA_INVALID' && pattern.test(error.message));
  });
}

test('invalid claim references, role, reason, and surrogate boundaries fail closed', () => {
  assert.throws(() => validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, 0, 1, { claim_ids: ['missing-claim'] })]), [source]), /nonexistent claim ID/);
  assert.throws(() => validateTerraEvidenceOffsets({ ...baseTerra(), claim_targets: ['missing-claim'] }, [source]), /claim_targets references a nonexistent claim ID/);
  assert.throws(() => validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, 0, 1, { evidence_role: 'quote' })]), [source]), /invalid evidence_role/);
  assert.throws(() => validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, 0, 1, { reason: '' })]), [source]), /invalid reason/);
  const emojiStart = sourceText.indexOf('😀');
  assert.throws(() => validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, emojiStart, emojiStart + 1)]), [source]), /surrogate pair/);
});

test('structured contradictions validate and retain exact claim and source provenance', () => {
  const terra = baseTerra();
  terra.contradictions = [{
    contradiction_id: 'contradiction-1',
    claim_id: 'claim-1',
    source_ids: [source.id],
    description: 'The retained records report different dates.',
    resolution: 'Use the enacted record and state the discrepancy.'
  }];
  assert.deepEqual(validatePhase1Schema('terra_research_evidence', terra), []);
  assert.equal(validateTerraEvidenceOffsets(terra, [source]).contradictions[0].claim_id, 'claim-1');
});

test('the retained failed model contradiction shape is rejected closed until all five fields are present', () => {
  const failedModelShape = baseTerra();
  failedModelShape.contradictions = [{ claim_id: 'claim-1', reason: 'The retained sources disagree.', source_ids: [source.id] }];
  const errors = validatePhase1Schema('terra_research_evidence', failedModelShape);
  assert.ok(errors.some(error => error.includes('contradiction_id is required')));
  assert.ok(errors.some(error => error.includes('description is required')));
  assert.ok(errors.some(error => error.includes('resolution is required')));
  assert.throws(() => assertPhase1Schema('terra_research_evidence', failedModelShape), error => error.code === 'PHASE1_SCHEMA_INVALID');
});

test('contradictions fail closed when claim or source references are not supplied', () => {
  const unknownClaim = baseTerra();
  unknownClaim.contradictions = [{ contradiction_id: 'contradiction-1', claim_id: 'missing-claim', source_ids: [source.id], description: 'Conflict.', resolution: 'Resolve it.' }];
  assert.throws(() => validateTerraEvidenceOffsets(unknownClaim, [source]), /contradiction.*nonexistent claim ID/);
  const unknownSource = baseTerra();
  unknownSource.contradictions = [{ contradiction_id: 'contradiction-1', claim_id: 'claim-1', source_ids: ['missing-source'], description: 'Conflict.', resolution: 'Resolve it.' }];
  assert.throws(() => validateTerraEvidenceOffsets(unknownSource, [source]), /contradiction.*unknown source/);
  const missingField = baseTerra();
  missingField.contradictions = [{ contradiction_id: 'contradiction-1', claim_id: 'claim-1', source_ids: [source.id], description: 'Conflict.' }];
  assert.ok(validatePhase1Schema('terra_research_evidence', missingField).some(error => error.includes('resolution is required')));
});

test('the frozen evidence packet contains only deterministic derived evidence and preserves the packet checksum for Draft and Revision', () => {
  const terra = validateTerraEvidenceOffsets(baseTerra([evidenceRecord(source.id, 0, 9)]), [source]);
  const packet = buildEvidencePacket({
    sources: [source],
    claims: terra.claims,
    includeSourceExcerpts: false,
    includeRetainedText: true,
    preserveSourceText: true,
    preserveDerivedEvidence: true,
    limits: { maxPacketCharacters: 64_000 }
  });
  assert.equal(packet.claims[0].evidence[0].excerpt, sourceText.slice(0, 9));
  assert.equal(packet.claims[0].evidence[0].range_length, 9);
  assert.equal(packet.claims[0].evidence[0].excerpt_sha256, crypto.createHash('sha256').update(sourceText.slice(0, 9)).digest('hex'));
  assert.equal(packet.sources[0].retained_text, sourceText);
  assert.equal(packet.sources[0].source_text_sha256, crypto.createHash('sha256').update(sourceText).digest('hex'));
  assert.equal('excerpt' in packet.sources[0], false);
  assert.match(packet.frozen_evidence_packet_sha256, /^[a-f0-9]{64}$/);
  assert.equal(packet.claims[0].evidence[0].source_text_sha256, crypto.createHash('sha256').update(packet.sources[0].retained_text).digest('hex'));
});

test('the retained Case01 Terra shape fails closed without normalization or repair', () => {
  const invalid = validTerra();
  invalid.claims[0].source_ids = [validSourceId, failedCase01OverlongSourceId];
  invalid.ledgers.proper_names = [{ name: 'TAKE IT DOWN Act', type: 'federal law', source_id: failedCase01OverlongSourceId }];
  invalid.freshness_risks = [{ reason: 'The litigation may have changed.', source_ids: [validSourceId] }];
  invalid.missing_evidence = [{ question: 'What is missing?', reason: 'The retained record does not answer it.' }];
  assert.ok(failedCase01OverlongSourceId.length > PHASE1_SOURCE_ID_MAX_LENGTH);
  const errors = validatePhase1Schema('terra_research_evidence', invalid);
  assert.ok(errors.includes('$.claims[0].source_ids[1] is too long'));
  assert.ok(errors.includes('$.ledgers.proper_names[0].source_id is too long'));
  assert.ok(errors.includes('$.freshness_risks[0] must be a non-empty string'));
  assert.ok(errors.includes('$.missing_evidence[0] must be a non-empty string'));
  assert.throws(() => assertPhase1Schema('terra_research_evidence', invalid), error => error.code === 'PHASE1_SCHEMA_INVALID');
});
