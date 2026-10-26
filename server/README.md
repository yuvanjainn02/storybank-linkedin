# Server foundation

See root README/KNOWN_ISSUES for current status.

- `repository.mjs`: owner-scoped domain and exact-version approval rules.
- `persistence.mjs`: durable SQLite composition.
- `hosted-d1.mjs`: owner-qualified D1 state and revision checks.
- `hosted-http.mjs`: origin checks and mandatory mutation workspace preconditions.
- `hosted-audio.mjs`: bounded private audio operations.
- `linkedin-*.mjs`: disabled-by-default provider, queue and runner.
- `session.mjs`: independent non-Sites session boundary, not an OIDC provider
  or replacement for Sites authentication.

Node 24+ is required for SQLite tests. Fixtures use fictional records and local
temporary DBs. SQLite-backed D1 tests are not live D1 verification. Due manual
plans never automatically post. No production data or provider secret is included.

