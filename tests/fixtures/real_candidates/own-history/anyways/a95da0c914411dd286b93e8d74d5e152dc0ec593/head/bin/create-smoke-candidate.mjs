#!/usr/bin/env node
import crypto from 'node:crypto';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadState, saveState } from '../src/pipeline/state.mjs';
import { verifySmokeCandidatePackage } from '../src/pipeline/smoke-candidate-identity.mjs';

const packageRoot = path.resolve(process.argv[2] || 'pipeline-holdouts/phase2-v1-claim-complete-expanded-fixed-20260801');
const caseLabel = process.argv[3] || 'case-01';
const candidateId = crypto.createHash('sha256').update(`pipeline-v1-smoke-candidate:${packageRoot}:${caseLabel}:${crypto.randomUUID()}`).digest('hex');
const stateFile = process.env.ANYWAYS_PIPELINE_STATE_FILE || path.join(process.env.ANYWAYS_PIPELINE_STATE_DIR || 'pipeline-state', 'state.json');
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) throw new Error('Supabase service credentials are required to persist a smoke candidate.');
const verified = await verifySmokeCandidatePackage({ packageRoot, caseLabel, candidateId });
const state = await loadState(stateFile);
if (state.candidates.some(item => item.id === candidateId)) throw new Error(`Candidate ${candidateId} already exists.`);
verified.candidate.history = [{ at: new Date().toISOString(), actor: 'pipeline_v1_smoke_test', status: 'pitch_ready', note: 'Fresh publication-ineligible candidate built from the verified retained package.' }];
state.candidates.push(verified.candidate);
const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { error } = await client.rpc('sync_pipeline_discovery_candidates', { p_candidates: [verified.candidate] });
if (error) throw new Error(`Could not persist smoke candidate: ${error.message}`);
await saveState(stateFile, state);
console.log(JSON.stringify({
  ok: true,
  candidate_id: candidateId,
  state_file: stateFile,
  publication_ineligible: true,
  smoke_test: true,
  checksums: verified.checksums,
  identity: verified.identity,
  gates: { source: verified.sourceGate, packet: verified.packetPreflight },
  provider_setup: verified.providerSetup
}, null, 2));
