#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { validateHermesStoryPackage } from '../src/pipeline/hermes-package.mjs';

const text = value => String(value || '').trim();

export function parseArgs(argv = []) {
  const [command = 'help', ...rest] = argv;
  const flags = {};
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function requiredEnv(name) {
  const value = text(process.env[name]);
  if (!value) throw new Error(name + ' is required.');
  return value;
}

function workerId(flags) {
  return text(flags.workerId || process.env.HERMES_WORKER_ID);
}

export function createHermesClient() {
  const url = requiredEnv('SUPABASE_URL');
  const anonKey = requiredEnv('SUPABASE_ANON_KEY');
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
}

async function signIn(client) {
  const email = requiredEnv('HERMES_EMAIL');
  const password = requiredEnv('HERMES_PASSWORD');
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error('Hermes Supabase sign-in failed: ' + error.message);
}

async function callRpc(client, name, parameters) {
  const { data, error } = await client.rpc(name, parameters);
  if (error) throw new Error(name + ' failed: ' + error.message);
  return data;
}

async function enrichProposal(client, proposal) {
  const eventResult = await client.from('source_events')
    .select('id,source_id,title,summary,canonical_url,author_name,published_at,discovered_at,raw_text,raw_payload,status')
    .eq('id', proposal.source_event_id)
    .maybeSingle();
  if (eventResult.error) throw new Error('Could not load the triggering source event: ' + eventResult.error.message);
  const sourceResult = eventResult.data?.source_id
    ? await client.from('source_registry')
      .select('id,name,source_type,handle_or_url,description,trust_level,editorial_fit,pipeline_role,primary_sections,topic_tags')
      .eq('id', eventResult.data.source_id)
      .maybeSingle()
    : { data: null, error: null };
  if (sourceResult.error) throw new Error('Could not load the source registry record: ' + sourceResult.error.message);
  return {
    proposal,
    triggering_event: eventResult.data || null,
    source: sourceResult.data || null
  };
}

export async function claimProposals({ client, flags = {} } = {}) {
  const proposals = await callRpc(client, 'claim_hermes_story_proposals', {
    ...(workerId(flags) ? { p_worker_id: workerId(flags) } : {}),
    p_limit: Math.min(5, Math.max(1, Number(flags.limit) || 1)),
    p_lease_seconds: Math.min(7200, Math.max(60, Number(flags.leaseSeconds) || 1800))
  });
  return Promise.all((Array.isArray(proposals) ? proposals : []).map(proposal => enrichProposal(client, proposal)));
}

export async function updateProposal({ client, flags = {} } = {}) {
  const proposalId = text(flags.proposalId);
  const status = text(flags.status);
  if (!proposalId || !status) throw new Error('--proposal-id and --status are required.');
  return callRpc(client, 'update_hermes_story_proposal', {
    p_proposal_id: proposalId,
    p_worker_id: workerId(flags),
    p_status: status,
    p_error: flags.error ? { message: text(flags.error) } : null
  });
}

export async function submitPackage({ client, flags = {} } = {}) {
  const proposalId = text(flags.proposalId);
  const packagePath = text(flags.packageFile || flags.package);
  if (!proposalId || !packagePath) throw new Error('--proposal-id and --package-file are required.');
  const packageValue = JSON.parse(await readFile(packagePath, 'utf8'));
  const validation = validateHermesStoryPackage(packageValue);
  if (!validation.valid) {
    throw new Error('Hermes package validation failed:\n' + validation.errors.map(error => '- ' + error).join('\n'));
  }
  return callRpc(client, 'submit_hermes_story_package', {
    p_proposal_id: proposalId,
    p_worker_id: workerId(flags),
    p_package: packageValue
  });
}

function usage() {
  return [
    'Hermes source proposal bridge',
    '',
    'Environment:',
    '  SUPABASE_URL, SUPABASE_ANON_KEY, HERMES_EMAIL, HERMES_PASSWORD',
    '  HERMES_WORKER_ID is optional; the Auth account remains the identity boundary.',
    '',
    'Commands:',
    '  claim [--limit 1] [--lease-seconds 1800]',
    '  update --proposal-id <uuid> --status writing|failed|rejected|cancelled [--error <text>]',
    '  submit --proposal-id <uuid> --package-file <path>',
    '',
    'The bridge never receives or uses the Supabase service-role key.'
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { command, flags } = parseArgs(argv);
  if (command === 'help' || command === '--help') {
    console.log(usage());
    return;
  }
  const client = createHermesClient();
  await signIn(client);
  const result = command === 'claim'
    ? await claimProposals({ client, flags })
    : command === 'update'
      ? await updateProposal({ client, flags })
      : command === 'submit'
        ? await submitPackage({ client, flags })
        : (() => { throw new Error('Unknown command: ' + command + '\n\n' + usage()); })();
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
