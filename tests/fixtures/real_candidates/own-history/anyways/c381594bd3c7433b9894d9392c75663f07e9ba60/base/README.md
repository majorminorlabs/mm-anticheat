# Anyways

Anyways is an editorial publication for curious people who want to understand
what is shaping culture before everyone else catches up.

## Runtime

The site is a static single-page application served by a Cloudflare Worker.
The browser bundle talks directly to Supabase over HTTPS/WSS for Postgres data
and Auth. Supabase Row Level Security (RLS), not a browser-held secret, is the
authorization boundary for the public edition and newsroom.

- `src/app.mjs` is bundled into the self-hosted `public/app.js`.
- `src/worker.mjs` serves assets, applies response security headers, and falls
  back to `public/index.html` only for recognized application routes.
- `public/config.js` contains the public Supabase project URL and anon key.
- `supabase/migrations/` is the source of truth for schema, RLS, profiles, and
  workflow guards.

Never put a Supabase service-role key or another privileged credential in
`public/`; every file in that directory is delivered to visitors.

## Local development

Use Node.js 22 or newer. Install dependencies and start the Worker development
server:

```sh
npm install
npm run dev
```

Wrangler prints the local URL (normally `http://localhost:8787`). The `dev`
command creates the browser bundle once before starting Wrangler. Rerun the
command after changing `src/app.mjs`.

Useful checks:

```sh
npm run lint
npm test
npm run build
```

`npm run build` bundles the client and performs a Wrangler deployment dry run
into the ignored `dist/` directory. It does not deploy the site.

## Supabase setup

Apply the SQL files in `supabase/migrations/` in timestamp order, either with
the Supabase CLI or through a controlled database migration workflow. Take a
database backup before applying a production migration. Auth accounts and
newsroom membership are deliberately separate: provision a matching `profiles`
row from a trusted administration surface, and promote editor or administrator
roles only there. Public Auth signup should remain disabled in the Supabase
project settings; the database does not auto-enroll new Auth users.

`supabase/seed.sql` is optional sample content for an initialized development
project. It expects its referenced owner account to exist before it runs.
Cloudflare builds and deployments do not apply Supabase migrations or seed data.

Open `/newsroom` to sign in with a Supabase Auth newsroom account. There are no
repository-defined demo passwords or in-memory sessions.

## Deployment

After the checks pass, `npx wrangler deploy` publishes the Worker and the
contents of `public/`. Database migrations are a separate operation. The Worker
serves only `GET` and `HEAD`, gives missing assets and unknown paths real 404
responses, and sends the SPA shell only for the routes documented in
[the architecture](docs/ARCHITECTURE.md).

Apply and verify database migrations before publishing a client bundle that
depends on a new RPC or policy. In particular, the newsroom save flow requires
the hardening migration and the editorial-taxonomy migration that define
`save_story` for sections, beats, and tags.

See the [company documentation](docs/README.md) and the
[Anyways design language](docs/design/anyways-design.md).
