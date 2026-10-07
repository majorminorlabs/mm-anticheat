import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PHASE2_INVENTORY_CONTRACT_VERSION, canonicalizePhase2Inventory, hashPhase2Inventory, serializePhase2Inventory, verifyPhase2InventoryIdentity } from '../src/pipeline/phase2-inventory.mjs';

const hash = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const sourceText = 'Exact HTML &#x27; entity.\r\nUnicode: café 🧭.';
const source = { source_id: 'source-002', requested_url: 'https://example.test/requested', canonical_url: 'https://example.test/canonical', title: 'Frozen source', publisher: 'Publisher', published_at: '2026-08-01', classification: 'primary', independence_key: 'publisher', primary_source: true, accessible: true, ok: true, text: sourceText, capture_mode: 'approved_snapshot' };
const inventory = { candidate_id: 'candidate-1', assignment_sha256: 'a'.repeat(64), sources: [source] };

test('canonical inventory preserves exact retained text and uses the explicit version', () => {
  const canonical = canonicalizePhase2Inventory(inventory);
  assert.equal(canonical.inventory_contract_version, PHASE2_INVENTORY_CONTRACT_VERSION);
  assert.equal(canonical.sources[0].retained_text, sourceText);
  assert.equal(canonical.sources[0].retained_text_characters, sourceText.length);
  assert.equal(canonical.sources[0].retained_text_sha256, hash(sourceText));
  assert.match(serializePhase2Inventory(inventory), /"inventory_contract_version":"phase2-inventory-v2"/);
});

test('source order and caller object key order do not alter identity', () => {
  const second = { ...source, source_id: 'source-001', text: 'Second source.' };
  const firstHash = hashPhase2Inventory({ ...inventory, sources: [source, second] });
  const reordered = { sources: [second, source], assignment_sha256: inventory.assignment_sha256, candidate_id: inventory.candidate_id };
  assert.equal(hashPhase2Inventory(reordered), firstHash);
});

test('runtime metadata is excluded but retained-text mutation changes identity', () => {
  const baseline = hashPhase2Inventory(inventory);
  const withRuntimeFields = hashPhase2Inventory({ ...inventory, run_id: 'runtime', generated_at: 'now', packet_checksum: 'derived', sources: [{ ...source, retrieval_diagnostics: { fetched_at: 'now', attempt: 4 }, runtime_only: true }] });
  assert.equal(withRuntimeFields, baseline);
  assert.notEqual(hashPhase2Inventory({ ...inventory, sources: [{ ...source, text: `${sourceText}!` }] }), baseline);
});

test('version is part of the serialized identity', () => {
  const serialized = serializePhase2Inventory(inventory);
  assert.notEqual(hash(serialized), hash(serialized.replace(PHASE2_INVENTORY_CONTRACT_VERSION, 'phase2-inventory-v3')));
});

test('duplicate source IDs fail closed and readiness/runtime identity must match', () => {
  assert.throws(() => canonicalizePhase2Inventory({ ...inventory, sources: [source, source] }), /duplicate source_id/);
  const result = verifyPhase2InventoryIdentity({ candidateId: inventory.candidate_id, assignmentSha256: inventory.assignment_sha256, readinessInventory: inventory, runtimeInventory: inventory, expectedReadinessSha256: hashPhase2Inventory(inventory) });
  assert.equal(result.readinessInventorySha256, result.runtimeInventorySha256);
  assert.throws(() => verifyPhase2InventoryIdentity({ candidateId: inventory.candidate_id, assignmentSha256: inventory.assignment_sha256, readinessInventory: inventory, runtimeInventory: { ...inventory, sources: [{ ...source, text: 'mutated' }] }, expectedReadinessSha256: hashPhase2Inventory(inventory) }), error => error.code === 'PHASE2_INVENTORY_CHECKSUM_MISMATCH');
});

test('regenerated three-candidate package has one shared identity and provider-free preflight', async () => {
  const root = path.resolve('pipeline-holdouts/phase2-v1-claim-complete-expanded-fixed-20260801');
  const report = JSON.parse(await fs.readFile(path.join(root, 'readiness-report.json'), 'utf8'));
  const preflight = JSON.parse(await fs.readFile(path.join(root, 'preflight', 'pre-provider-report.json'), 'utf8'));
  assert.deepEqual(report.canonical_case_map, { 'case-01': '2d07ce92c3335935f5eaa33575956c84b77d164658b2a6d823e300f91702abfe', 'case-02': '1d01fdd20f83e9457143cd21b607606d30ec669638bc57f06ec982b780a62a06', 'case-03': '9bd11ec670afb1465268d6d83df32b20ceaf8316b124664d3578e2a37e82fb06' });
  assert.equal(report.planning_only, true);
  assert.equal(report.provider_calls_started, false);
  assert.equal(report.final_holdout_execution_started, false);
  assert.equal(preflight.provider_setup.provider_construction_count, 0);
  assert.equal(preflight.provider_setup.terra_calls_started, false);
  assert.equal(preflight.provider_setup.luna_calls_started, false);
  for (const candidate of report.candidates) {
    assert.equal(candidate.readiness_inventory_sha256, candidate.runtime_inventory_sha256, candidate.canonical_case_label);
    assert.match(candidate.claim_ledger_sha256, /^[a-f0-9]{64}$/);
    assert.match(candidate.draft_constraints_sha256, /^[a-f0-9]{64}$/);
  }
});
