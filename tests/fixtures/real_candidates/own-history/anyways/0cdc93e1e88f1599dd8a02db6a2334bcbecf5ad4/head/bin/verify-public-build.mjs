import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root));
const manifest = JSON.parse(await read('public/assets/asset-manifest.json'));
const index = (await read('public/index.html')).toString('utf8');

const required = [manifest.public, manifest.newsroom, manifest.entry, manifest.css.public, manifest.css.newsroom, manifest.fx, manifest.font];
for (const asset of required) {
  if (!asset?.filename || !asset.filename.startsWith('/assets/')) throw new Error('Asset manifest contains an invalid filename.');
  await stat(new URL(`public${asset.filename}`, root));
  if (!index.includes(asset.filename) && asset !== manifest.public && asset !== manifest.newsroom && asset !== manifest.css.newsroom) {
    throw new Error(`Generated index is missing ${asset.filename}.`);
  }
}

const publicBundle = await read(`public${manifest.public.filename}`);
for (const bundle of [manifest.public, manifest.newsroom]) if (bundle.map) await stat(new URL(`public${bundle.map}`, root));
const publicGzipBytes = gzipSync(publicBundle).byteLength;
if (publicGzipBytes > manifest.budgets.public_initial_gzip_limit || !manifest.budgets.public_initial_js_ok) {
  throw new Error(`Public initial JavaScript exceeds the gzip budget (${publicGzipBytes} bytes).`);
}
const publicSource = publicBundle.toString('utf8');
if (/createClient|@supabase|SUPABASE|pipeline\//i.test(publicSource)) {
  throw new Error('Public bundle contains newsroom/database implementation markers.');
}
if (index.includes('site.webmanifest') || /fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(index)) {
  throw new Error('Public shell still references a removed external/PWA asset.');
}

console.log(JSON.stringify({
  ok: true,
  release: manifest.release,
  public_gzip_bytes: publicGzipBytes,
  public_gzip_limit: manifest.budgets.public_initial_gzip_limit,
  public_asset: manifest.public.filename,
  newsroom_asset: manifest.newsroom.filename
}));
