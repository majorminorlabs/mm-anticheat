# Anyways

Anyways is an editorial publication for curious people who want to understand
what is shaping culture before everyone else catches up.

## Run the publication

This repository now includes the first working publication and newsroom.

```sh
npm run seed
npm run dev
```

Open `http://localhost:3000`. The newsroom seed accounts are `admin@anyways.test`,
`editor@anyways.test`, `maya@anyways.test`, and `jon@anyways.test`; each uses
the development-only password `anyways-demo`.

Commands: `npm run dev`, `npm start`, `npm run seed`, `npm test`, and `npm run lint`.
The app has no required environment variables. Production should set `PORT`, replace
the JSON store with a managed database, provide a real authentication provider, and
run an authenticated scheduler request regularly for due stories.

See [architecture](docs/ARCHITECTURE.md) and the [company documentation](docs/README.md).
