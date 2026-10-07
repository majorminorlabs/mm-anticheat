const baseUrl = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const serviceKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const expected = String(process.env.EXPECTED_PUBLICATION_SCHEMA_VERSION || 'premium-publication-contract-v1');

if (!baseUrl || !serviceKey) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for the read-only public schema check.');
  process.exit(2);
}

const response = await fetch(`${baseUrl}/rest/v1/rpc/get_publication_schema_version`, {
  method: 'POST',
  headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' },
  body: '{}'
});
const payload = await response.text();
let version = payload;
try { version = JSON.parse(payload); } catch {}
if (!response.ok) {
  console.error(`Public schema check failed (${response.status}).`);
  process.exit(1);
}
if (version !== expected) {
  console.error(`Public schema version mismatch: expected ${expected}, received ${String(version)}.`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, publication_schema_version: version }));
