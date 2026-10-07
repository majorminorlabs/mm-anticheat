#!/usr/bin/env node
import crypto from 'node:crypto';
import { verifySmokeCandidatePackage } from '../src/pipeline/smoke-candidate-identity.mjs';

const packageRoot = process.argv[2] || 'pipeline-holdouts/phase2-v1-claim-complete-expanded-fixed-20260801';
const caseLabel = process.argv[3] || 'case-01';
const candidateId = process.argv[4] || `preflight-${crypto.randomUUID()}`;

try {
  const result = await verifySmokeCandidatePackage({ packageRoot, caseLabel, candidateId });
  console.log(JSON.stringify({
    ok: true,
    provider_setup: result.providerSetup,
    candidate_id: result.candidate.id,
    checksums: result.checksums,
    identity: result.identity,
    gates: {
      source: result.sourceGate,
      packet: result.packetPreflight
    }
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, code: error.code || 'SMOKE_CANDIDATE_PREFLIGHT_FAILED', message: error.message, details: error.details || null }, null, 2));
  process.exitCode = 1;
}
