# Anyways architecture

Anyways has two runtime boundaries: a Cloudflare Worker that serves the web
application, and Supabase for persistent data and authentication. There is no
application server between the browser and Supabase.

## Request path

Cloudflare is configured with `assets.run_worker_first: true`, so every request
passes through `src/worker.mjs` before the static asset binding:

1. The Worker accepts `GET` and `HEAD`; other methods receive `405 Method Not
   Allowed`.
2. An existing file under `public/` is returned through the `ASSETS` binding.
3. If no file exists, only a recognized application route receives
   `public/index.html`.
4. A missing asset or any other path receives a real `404 Not Found`.

The recognized SPA routes are:

- `/`
- `/search`
- `/topics` and `/topics/:slug`
- `/sections/:slug`
- `/stories/:slug`
- `/newsroom`, `/newsroom/new`, and `/newsroom/:uuid`

The edge can validate a route's shape but cannot know whether a requested
Supabase record exists. A recognized story, topic, section, or newsroom UUID
therefore receives the shell; the client renders its not-found state after the
data lookup.

All Worker responses, including assets and errors, receive the same browser
security baseline. It includes a Content Security Policy restricted to the
self-hosted application, Google Fonts, HTTPS images, and Supabase HTTPS/WSS;
clickjacking, MIME sniffing, unnecessary browser capabilities, and cross-origin
window access are restricted. HSTS is sent for HTTPS requests.

HTML and `config.js` are not stored in the browser cache. Application code and
styles must revalidate, image assets use a bounded seven-day cache, and asset
ETags are preserved.

## Browser application

`src/app.mjs` is the readable client source. Esbuild bundles it and
`@supabase/supabase-js` into `public/app.js`; the production page does not load
its application code from a JavaScript CDN. `public/index.html`, the design
stylesheets, brand image, and editorial photographs are served as static
assets.

`public/config.js` supplies the Supabase URL and anon key. Both values are
necessarily public. The bundle never receives a service-role key and the Worker
does not proxy or elevate Supabase calls.

Public pages fetch the published story catalog and reference data from
Supabase. Search is a client-side substring filter over that fetched catalog.
The newsroom uses Supabase Auth email/password sessions and sends permitted
edits directly to PostgREST.

## Supabase

The timestamped files in `supabase/migrations/` define the deployed data model:

- profiles, sections, topics, stories, media metadata, sources, relationships,
  revisions, homepage settings, and search logs;
- deliberate separation between Supabase Auth accounts and administrator-
  provisioned newsroom profiles;
- RLS policies for public reads and role/ownership-based newsroom access; and
- database guards for contributor limits, publishing requirements,
  published-story invariants, timestamps, and published dates.

The newsroom update RPC locks the story, checks its expected revision, updates
the permitted fields, replaces topics, and validates the final record in one
transaction. Public source, topic, relationship, media, and author reads are
limited to records attached to currently published stories.

Postgres and RLS are the durable data and authorization layers. Browser role
checks improve the interface but do not replace the database policies.

The repository does not currently contain an automatic publishing job, so the
current editor does not offer scheduling as a new workflow choice. Existing
scheduled records remain readable by authorized editors and need an external
trusted process to advance them to `published`. Media records can point to
HTTPS or same-origin URLs; there is no upload service in the current client.

## Build and release boundary

`npm run build` first creates `public/app.js`, then asks Wrangler for a dry-run
deployment bundle in `dist/`. `npm run dev` builds the client once and starts
the local Worker. Only `wrangler deploy` changes Cloudflare state, and Cloudflare
deployment never applies the separate Supabase migrations.

The retired Node HTTP server, JSON store, in-memory sessions, container image,
request-driven scheduler, RSS generation, and sitemap generation are not part
of the active runtime.
