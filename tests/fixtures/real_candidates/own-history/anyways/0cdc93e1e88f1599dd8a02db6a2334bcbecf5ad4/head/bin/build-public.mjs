import { readFile, writeFile, mkdir, unlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const publicDir = new URL('../public/', import.meta.url);
const assetDir = new URL('../public/assets/', import.meta.url);
const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const text = bytes => Buffer.from(bytes).toString('utf8');
const bytes = value => Buffer.isBuffer(value) ? value : Buffer.from(value);

await mkdir(assetDir, { recursive: true });
for (const filename of await readdir(assetDir)) {
  if (/^(?:public|newsroom|entry|fx|design|LeagueGothic-Italic)\.[a-f0-9]{12}\.(?:js|js\.map|css|woff2)$/i.test(filename)) {
    await unlink(new URL(filename, assetDir));
  }
}

async function bundle(name, entry) {
  const temporary = new URL(`../public/assets/.${name}.bundle.js`, import.meta.url);
  await build({
    entryPoints: [new URL(entry, root).pathname],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile: temporary.pathname,
    sourcemap: 'external',
    legalComments: 'none'
  });
  const bundleBytes = await readFile(temporary);
  const mapTemporary = new URL(`../public/assets/.${name}.bundle.js.map`, import.meta.url);
  const hash = hashBytes(bundleBytes);
  const filename = `${name}.${hash}.js`;
  const mapFilename = `${filename}.map`;
  const mapBytes = await readFile(mapTemporary);
  const rewritten = text(bundleBytes).replace(`//# sourceMappingURL=.${name}.bundle.js.map`, `//# sourceMappingURL=${mapFilename}`);
  await writeFile(new URL(filename, assetDir), rewritten);
  await writeFile(new URL(mapFilename, assetDir), mapBytes);
  await unlink(temporary);
  await unlink(mapTemporary);
  return { filename: `/assets/${filename}`, map: `/assets/${mapFilename}`, bytes: bundleBytes.byteLength, gzip_bytes: gzipSync(bundleBytes).byteLength };
}

async function copyAsset(name, sourceBytes, extension = path.extname(name).slice(1)) {
  const hash = hashBytes(sourceBytes);
  const filename = `${path.basename(name, path.extname(name))}.${hash}.${extension}`;
  await writeFile(new URL(filename, assetDir), sourceBytes);
  return { filename: `/assets/${filename}`, bytes: sourceBytes.byteLength, gzip_bytes: gzipSync(sourceBytes).byteLength };
}

const font = await readFile(new URL('../public/design/LeagueGothic-Italic.woff2', import.meta.url));
const fontAsset = await copyAsset('LeagueGothic-Italic.woff2', font, 'woff2');
const publicCssSource = await readFile(new URL('../public/design/public.css', import.meta.url), 'utf8');
const publicCss = Buffer.from(publicCssSource.replace(/\/design\/LeagueGothic-Italic\.woff2(?:\?[^"') ]*)?/g, fontAsset.filename));
const publicCssAsset = await copyAsset('public.css', publicCss, 'css');
const designCssAsset = await copyAsset('design.css', await readFile(new URL('../public/design/design.css', import.meta.url)), 'css');
const fxAsset = await copyAsset('fx.js', await readFile(new URL('../public/fx.js', import.meta.url)), 'js');
const publicBundle = await bundle('public', 'src/public-app.mjs');
const newsroomBundle = await bundle('newsroom', 'src/newsroom-entry.mjs');

const entrySource = `const newsroom = location.pathname.startsWith('/newsroom');
const newsroomCss = ${JSON.stringify(designCssAsset.filename)};
const cssLink = document.querySelector('link[data-public-css]');
if (newsroom) {
  document.body.classList.remove('public-site');
  document.body.classList.add('newsroom-site');
  if (cssLink) cssLink.disabled = true;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = newsroomCss;
  document.head.append(link);
}
await import(newsroom ? ${JSON.stringify(newsroomBundle.filename)} : ${JSON.stringify(publicBundle.filename)}).catch(error => {
  console.error('Anyways application failed to start', error);
  const app = document.querySelector('#app');
  if (app) app.innerHTML = '<div class="lost"><p class="mono">[ interference ]</p><h1>The desk is temporarily unavailable.</h1><p>Reload to try again.</p></div>';
});
`;
const entryBytes = Buffer.from(entrySource);
const entryAsset = await copyAsset('entry.js', entryBytes, 'js');

const indexUrl = new URL('../public/index.html', import.meta.url);
let index = await readFile(indexUrl, 'utf8');
index = index
  .replace(/href="\/assets\/public(?:\.[a-f0-9]{8,})?\.css"(?:\s+data-public-css)?/i, `href="${publicCssAsset.filename}" data-public-css`)
  .replace(/href="\/assets\/LeagueGothic-Italic(?:\.[a-f0-9]{8,})?\.woff2"/i, `href="${fontAsset.filename}"`)
  .replace(/src="\/assets\/fx(?:\.[a-f0-9]{8,})?\.js"/i, `src="${fxAsset.filename}"`)
  .replace(/src="\/assets\/entry(?:\.[a-f0-9]{8,})?\.js"/i, `src="${entryAsset.filename}"`);
await writeFile(indexUrl, index);

const manifest = {
  release: `public-${hashBytes(Buffer.from(JSON.stringify({ publicBundle, newsroomBundle, publicCssAsset, designCssAsset, fxAsset, fontAsset })))}`,
  generated_at: new Date().toISOString(),
  public: publicBundle,
  newsroom: newsroomBundle,
  entry: entryAsset,
  css: { public: publicCssAsset, newsroom: designCssAsset },
  fx: fxAsset,
  font: fontAsset,
  budgets: { public_initial_gzip_bytes: publicBundle.gzip_bytes, public_initial_gzip_limit: 75 * 1024, public_initial_js_ok: publicBundle.gzip_bytes <= 75 * 1024 }
};
await writeFile(new URL('asset-manifest.json', assetDir), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(new URL('../public/asset-manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
if (!manifest.budgets.public_initial_js_ok) throw new Error(`Public initial bundle exceeds 75 KB gzip: ${manifest.budgets.public_initial_gzip_bytes}`);
