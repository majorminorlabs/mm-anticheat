#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';

export function summarizeQueue(rows) {
  const queuedCount = rows.filter(row => row.status === 'queued').length;
  const activeCount = rows.filter(row => ['claimed', 'running'].includes(row.status)).length;
  return {
    idle: queuedCount === 0 && activeCount === 0,
    active_count: activeCount,
    queued_count: queuedCount
  };
}

export async function probeQueue({
  supabaseUrl = process.env.SUPABASE_URL,
  serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
} = {}) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client
    .from('pipeline_jobs')
    .select('id,status')
    .in('status', ['queued', 'claimed', 'running']);
  if (error) throw new Error(`Queue probe failed: ${error.message}`);
  return summarizeQueue(data || []);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  probeQueue()
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
