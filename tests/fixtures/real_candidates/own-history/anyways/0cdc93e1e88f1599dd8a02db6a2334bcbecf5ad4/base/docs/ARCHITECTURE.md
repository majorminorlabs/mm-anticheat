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
- `/topics` and `/topics/:slug` (recurring beat hubs)
- `/sections/:slug`
- `/stories/:slug`
- `/newsroom`, `/newsroom/pitches`, `/newsroom/stories`,
  `/newsroom/published`, `/newsroom/settings`, `/newsroom/new`,
  `/newsroom/analytics`, `/newsroom/assignment`, `/newsroom/review`,
  `/newsroom/pipeline`, and `/newsroom/:uuid`

`/newsroom/review` is the canonical editor-facing discovery surface. It stores
Coverage Focus separately from Primary Lens, Story Form, Beat, and Topic before
the batch queue starts. `/newsroom/pitches` exposes the same discovery
configuration alongside the pitch inbox. `/newsroom/pipeline` remains an
operator surface; its raw discovery control accepts the same Coverage Focus.

The edge can validate a route's shape but cannot know whether a requested
Supabase record exists. A recognized story, beat, section, or newsroom UUID
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

`src/article-renderer.mjs` is the single article presentation boundary. The
public story route and the newsroom's full-screen Article Preview both call
that renderer. Preview passes the current form values and unsaved presentation
state into a responsive iframe, so desktop and mobile modes use the same
stylesheets and breakpoints as the live route without saving or publishing.
The presentation document stores the approved opening composition, optional
accent override, hero crop and focal point, dedicated Detour fields, and inline
image placement and metadata.

Newsroom members can batch-upload up to 12 AVIF, JPEG, PNG, or WebP files of up
to 10 MB each to the public `story-media` Supabase Storage bucket before an
article has been saved. Object writes are restricted to a folder named for the
authenticated user. The batch shares one recorded publication-rights decision,
while every photo receives its own alt text, caption, credit, and placement
choice. Each upload creates a normal `media` row. One photo can become the hero;
body selections open in Article Preview for exact position and width.

## Supabase

The timestamped files in `supabase/migrations/` define the deployed data model:

- profiles, canonical lenses, optional sections, recurring beats, topics, stories, media metadata, sources, relationships,
  revisions, homepage settings, and search logs;
- deliberate separation between Supabase Auth accounts and administrator-
  provisioned newsroom profiles;
- RLS policies for public reads and role/ownership-based newsroom access; and
- database guards for contributor limits, publishing requirements,
  published-story invariants, timestamps, and published dates.

The newsroom update RPC locks the story, checks its expected revision, updates
the permitted fields, replaces beats and topics, and validates the final record in one
transaction. Public source, beat, topic, relationship, media, and author reads are
limited to records attached to currently published stories.

Postgres and RLS are the durable data and authorization layers. Browser role
checks improve the interface but do not replace the database policies.

Approved articles use the existing `fact_check` database state as the explicit
On Deck state in the newsroom. Editors can publish them immediately or set a
future release time. A Cloudflare Cron Trigger runs once per minute and calls
the service-role-only `publish_due_stories` RPC; the database publishing guards
still reject an incomplete story.

Pipeline image candidates are shown during review and Article Preview. Only
candidates marked `verified_reusable` or `official_press_asset` can cross the
approval boundary. Other candidates remain available as clearly warned,
preview-only hero or inline-image choices. Both the client and the save RPC
block approval while a used candidate lacks a publishable rights decision.

## Local writer controller

Editors work from four primary newsroom surfaces: Pitches, Stories, Published,
and Settings. A pitch is commissioned from a small assignment dialog that
selects one of the fixed writer options and a Brief, Standard, or Feature
length. The dialog still submits the existing `process_candidate` queue job;
the writer and length are assignment metadata consumed by the existing
controller and Phase 2 orchestration.

The existing pipeline also remains available through its compatibility routes.
A commission contains a focused brief, one fixed primary lens, one optional
story form, controlled beats, flexible topics, public source URLs, supporting
notes, and queue priority. Discovery batches additionally persist their
requested Coverage Focus. Missing API focus values retain the compatibility
behavior of `all`; the newsroom UI defaults to All Web3 sources. Discovery
reads only eligible Web3 Source Graph feeds at run time, never staged X accounts
or unactivated feeds.

The UI derives one editorial status without writing a replacement backend
state. Its precedence is: published, scheduled, archived, failed execution,
unresolved verification or review blockers, active writer job, ready review
handoff, saved draft, commissioned assignment, then pitch. Models and workers
never choose or update this value.

The Worker validates the request and uses its server-held service credential
to call the protected queue RPC. The browser never receives that credential
and never contacts the Mac Studio.

The separate loopback-only Anyways Controller claims the durable job from
Supabase, obtains the heavy-model lease, and invokes the fixed Pipeline V1
adapter. The adapter fingerprints the structured request into a retained
candidate, acquires bounded source evidence, freezes the evidence packet, runs
Luna High Draft, and synchronizes the review package into the Newsroom review
tables. The editor's primary lens remains fixed; selected sections, beats, and
topics are retained alongside any justified additions. The job can produce only
an AI Review package. Optional Sol polish, approval, On Deck, scheduling, and
publishing remain separate human-controlled steps.

## Build and release boundary

`npm run build` first creates `public/app.js`, then asks Wrangler for a dry-run
deployment bundle in `dist/`. `npm run dev` builds the client once and starts
the local Worker. Only `wrangler deploy` changes Cloudflare state, and Cloudflare
deployment never applies the separate Supabase migrations.

The retired Node HTTP server, JSON store, in-memory sessions, container image,
request-driven scheduler, RSS generation, and sitemap generation are not part
of the active runtime.
