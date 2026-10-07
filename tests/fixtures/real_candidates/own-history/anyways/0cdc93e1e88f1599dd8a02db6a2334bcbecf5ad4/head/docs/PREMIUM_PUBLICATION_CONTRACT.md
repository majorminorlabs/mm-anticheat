# Premium publication contract

The public edition has one anonymous read path. Published stories are read
through the explicit `published_stories` projection, public article sources
through `published_story_sources`, and corrections through
`published_story_corrections`. The public Worker never selects from the base
`stories` table for page data.

## Release order

1. Take the normal Supabase backup and apply the timestamped publication
   contract migration.
2. Run `npm run verify:schema` with the service-role key in the operator
   environment. The command is read-only and checks the publication schema
   version RPC.
3. Run `npm run audit:publication` to inspect the published story source gate.
4. Run `npm run build:client`, `npm run verify:public`, `npm test`,
   `npm run lint`, and the Wrangler dry-run build.
5. Publish the Worker only after the database contract and asset manifest pass.

The migration blocks new publication transitions unless a story has complete,
human-reviewed, healthy source records and a primary source. It does not
change the image-rights workflow or author identity policy. Those remain
separate release decisions.

## Public performance and privacy boundaries

Public list responses are bounded and omit article bodies. Article responses
contain only the allowlisted reader fields and bounded related/source records.
Fingerprinted assets are immutable; HTML and public API responses use short
stale-while-revalidate windows. The reader analytics endpoint is same-origin,
bounded, opt-out aware, rate limited, and retained for a defined period.
