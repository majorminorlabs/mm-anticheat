import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { assertSmokeCandidatePayload, buildSmokeCandidateIdentity, SMOKE_CANDIDATE_IDENTITY_CONTRACT_VERSION } from '../src/pipeline/smoke-candidate-identity.mjs';

const source = (id, text, classification = 'primary') => ({ source_id: id, requested_url: `https://example.test/${id}`, canonical_url: `https://example.test/${id}`, title: id, publisher: id, classification, source_type: classification, independence_key: id, primary_source: classification === 'primary', accessible: true, ok: true, retained_text: text, capture_mode: 'approved_snapshot' });
const packageData = (overrides = {}) => ({
  assignment: { candidate_id: 'old-candidate', title: 'Smoke story', description: 'A retained story.', source_id: 'retained', published_at: null, commission: { brief: 'A brief.', section_id: 'taste', story_form: 'meanwhile', beats: ['food'], tags: [], source_urls: ['https://example.test/source-1'] }, classification: { primary_section: 'taste', story_form: 'meanwhile', recurring_beats: ['food'], tags: [], editorial_pitch: { accepted: true, headline: 'Smoke story', primary_section: 'taste', story_form: 'meanwhile', research_requirement: 'none', lens: 'A lens.', evidence_plan: [] } } },
  canonicalInventory: { schema_version: 'phase2-canonical-inventory-v2', sources: [source('source-1', 'One retained source.'), source('source-2', 'Two retained source.', 'original_reporting'), source('source-3', 'Three retained source.', 'original_reporting')] },
  evidenceInput: { required_claim_ledger: [{ claim_id: 'claim-1', claim: 'The retained package supports the story.', source_ids: ['source-1'], support_status: 'supported', requirement: 'required' }], optional_claim_ledger: [], draft_constraints: ['Keep the claim scoped.'] },
  ...overrides
});

test('canonical builder includes the retained assignment checksum before persistence', () => {
  const result = buildSmokeCandidateIdentity({ packageData: packageData(), candidateId: 'new-candidate' });
  assert.equal(result.identity.identity_contract_version, SMOKE_CANDIDATE_IDENTITY_CONTRACT_VERSION);
  assert.equal(result.checksums.declared.retained_assignment_sha256, result.checksums.runtime.retained_assignment_sha256);
  assert.equal(result.checksums.declared.readiness_inventory_sha256, result.checksums.runtime.readiness_inventory_sha256);
  assert.equal(result.checksums.declared.runtime_inventory_sha256, result.checksums.runtime.runtime_inventory_sha256);
});

test('missing retained assignment input fails before a candidate payload is returned', () => {
  assert.throws(() => buildSmokeCandidateIdentity({ packageData: packageData({ assignment: null }), candidateId: 'new-candidate' }), /retained assignment is required/);
});

test('assignment, taxonomy, claims, constraints, and source order changes alter the relevant identity', () => {
  const base = buildSmokeCandidateIdentity({ packageData: packageData(), candidateId: 'new-candidate' });
  const changedAssignment = buildSmokeCandidateIdentity({ packageData: packageData({ assignment: { ...packageData().assignment, commission: { ...packageData().assignment.commission, brief: 'Changed brief.' } } }), candidateId: 'new-candidate' });
  const changedTaxonomy = buildSmokeCandidateIdentity({ packageData: packageData({ assignment: { ...packageData().assignment, commission: { ...packageData().assignment.commission, section_id: 'builders' }, classification: { ...packageData().assignment.classification, primary_section: 'builders' } } }), candidateId: 'new-candidate' });
  const changedClaims = buildSmokeCandidateIdentity({ packageData: packageData({ evidenceInput: { ...packageData().evidenceInput, required_claim_ledger: [{ ...packageData().evidenceInput.required_claim_ledger[0], claim: 'Changed claim.' }] } }), candidateId: 'new-candidate' });
  const changedConstraints = buildSmokeCandidateIdentity({ packageData: packageData({ evidenceInput: { ...packageData().evidenceInput, draft_constraints: ['Changed constraint.'] } }), candidateId: 'new-candidate' });
  const reordered = buildSmokeCandidateIdentity({ packageData: packageData({ canonicalInventory: { ...packageData().canonicalInventory, sources: [...packageData().canonicalInventory.sources].reverse() } }), candidateId: 'new-candidate' });
  assert.notEqual(changedAssignment.identity.assignment_sha256, base.identity.assignment_sha256);
  assert.notEqual(changedTaxonomy.identity.taxonomy_sha256, base.identity.taxonomy_sha256);
  assert.notEqual(changedClaims.identity.claim_ledger_sha256, base.identity.claim_ledger_sha256);
  assert.notEqual(changedConstraints.identity.draft_constraints_sha256, base.identity.draft_constraints_sha256);
  assert.equal(reordered.identity.readiness_inventory_sha256, base.identity.readiness_inventory_sha256);
});

test('the failed smoke-candidate shape cannot pass when its assignment checksum is omitted', () => {
  const result = buildSmokeCandidateIdentity({ packageData: packageData(), candidateId: 'new-candidate' });
  const malformed = structuredClone(result.candidate);
  delete malformed.commission.assignment_checksum;
  assert.throws(() => assertSmokeCandidatePayload({ candidate: malformed, checksums: result.checksums.runtime }), /assignment_checksum/);
  assert.match(result.identity.assignment_sha256, /^[a-f0-9]{64}$/);
});

test('preflight never constructs a provider adapter', () => {
  const result = buildSmokeCandidateIdentity({ packageData: packageData(), candidateId: crypto.randomUUID() });
  assert.deepEqual(result.providerSetup, { constructed: false, terraCallsStarted: false, lunaCallsStarted: false, solCallsStarted: false });
});
