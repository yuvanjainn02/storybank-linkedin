# Hosted application

Supported Sites/Vinext/Cloudflare Worker source. Read the root README and known
issues first. Install locked dependencies with `npm run install:ci`.
`npm run db:local` uses `wrangler.local.jsonc`, `--local` and
`.wrangler/state`, never production storage. `npm run dev` defaults to portable
loopback preview with synthetic sign-in. Run checks/build from the root.

Managed identity owns real sign-in. Never trust public identity headers or use
the mock as production authentication. Hosting configs are unassigned binding
placeholders; no live identity, credentials or runtime data is included.

