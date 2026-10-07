# Anyways

Anyways is an editorial publication for curious people who want to understand
what is shaping culture before everyone else catches up.

## Run the publication

This repository now includes the first working publication and newsroom.

```sh
npm run seed
npm run dev
```

Open `http://localhost:3000`; the local newsroom is at
`http://localhost:3000/newsroom` (anonymous visitors are redirected to sign in).

## Newsroom demo accounts

Run `npm run seed` to reset the local demo data and accounts. Every seed account
uses the development-only password `anyways-demo`:

- Contributor: `maya@anyways.test` (or `jon@anyways.test`)
- Editor: `editor@anyways.test`
- Admin: `admin@anyways.test`

## Create and submit a story

1. Sign in at `http://localhost:3000/signin` and open the newsroom.
2. Click **New Story** from the newsroom overview, the Stories list, or the
   signed-in newsroom navigation.
3. Enter a title, dek, section, at least one topic, responsible editor, body,
   and primary source, then click **Create story**. The slug and SEO fields can
   be left blank and are filled from the title and dek.
4. On the saved story, choose **review** as the status and click **Save story**
   to submit it for editorial review.
5. Sign in as the editor or admin and open
   `http://localhost:3000/newsroom/review` to find the submission. Contributors
   can create and submit their own stories, but cannot publish them directly.

Commands: `npm run dev`, `npm start`, `npm run seed`, `npm test`, and `npm run lint`.
The app has no required environment variables. `wrangler deploy` deploys the existing
Node application through a Cloudflare Container Worker. It is suitable for evaluation;
before production editorial use, replace the JSON store and in-memory sessions with
managed persistent services (for example D1/R2 and a production auth provider), since
container filesystem/session state can be replaced when an instance is restarted.

See [architecture](docs/ARCHITECTURE.md) and the [company documentation](docs/README.md).
The visual language (The Annotated Edition) is documented in
[docs/design/anyways-design.md](docs/design/anyways-design.md).
