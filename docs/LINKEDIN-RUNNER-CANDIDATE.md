> Technical design retained from the source candidate. Historical test/rollout statements below are not new verification; root `KNOWN_ISSUES.md` and `PROVENANCE.md` are authoritative for this handoff.

# LinkedIn scheduling candidate, 24 October 2026

This is an isolated source candidate, not a deployment, connected account, running timer, or successful LinkedIn post. It extends the reconstructed reviewed tester candidate. It has not been proven equivalent to current live source. The original private Site and tester runtime configuration are unchanged.

## What this closes

- Adds a server-only POST `/api/linkedin/runner` endpoint with separate bearer-capability authentication. Its configured owner is server-bound; requests cannot choose an owner, job, text, audience, time or provider URL.
- Provides a strictly read-only `{"mode":"dry-run"}` returning only aggregate queue counts and readiness. No decryption, lease recovery, provider access, private text or owner identifiers occur in this mode.
- Provides bounded `{"mode":"dispatch-one"}` for one due, explicitly confirmed scheduled job. It does not run a timer, send immediate jobs, or create/approve content. The caller must await completion. It never retries uncertain provider outcomes.
- Preserves signed-in per-user workspaces, encrypted provider tokens, exact-version confirmation, expiry checks, source/connection invalidation, atomic leases and a single in-flight post per owner.
- Cancels scheduled posts more than 15 minutes late rather than publishing stale content after an outage. The cutoff is checked in selection, atomic reservation and immediately before provider transmission.
- Adds owner-specific gated scheduling controls and an explicit final review of text, LinkedIn member, audience, local offset, timezone and UTC instant. Missing DST times are rejected; repeated wall times show an explicit offset. The existing content calendar remains a manual plan.
- Keeps every queued/sending job visible and cancellable alongside bounded recent history, even after more than 100 completed publications.
- Validates time/readiness before source mutation. Existing queued or sending publications must be handled explicitly before a replacement review; a failed form cannot silently cancel the old queue.

## Runtime contract, disabled until verified

Existing LinkedIn OAuth/publishing variables remain unchanged. Additional server-only variables:

| Variable | Purpose | Default |
| --- | --- | --- |
| `LINKEDIN_RUNNER_ENABLED` | Allows authenticated runner requests | false |
| `LINKEDIN_RUNNER_OWNER_ID` | Exact verified Sites user ID for the single launch owner | absent |
| `LINKEDIN_RUNNER_TOKEN_SHA256` | SHA-256 of a unique, cryptographically random 32-byte base64url bearer capability | absent |
| `LINKEDIN_SCHEDULER_VERIFIED` | Operator attestation after real unattended dry-run verification | false |

This candidate creates no real credential and stores no real secret. Generating/configuring persistent runner access requires its applicable action-time approval and a supported secure transfer. The plaintext capability belongs in the authorized runner's secret store, never source, prompts, logs, chat, browser bundles or a URL. The Site stores only its digest. Treat both configuration and operator-bound identity as server-only.

On an owner-private Site, the trusted caller also needs supported Sites service access to reach the Worker. That access alone supplies neither visitor identity nor LinkedIn consent, and it is NOT accepted as the runner capability. Do not weaken Site sharing to make it work. For a public demo the separate runner authentication remains mandatory, and scheduling is available only to the one configured owner. General multi-user recurring execution is not implemented.

The request uses exact configured HTTPS origin, no query, POST, JSON, service context without browser Origin, and `Authorization: Bearer <capability>`. Never put credentials in schedule instructions. Browser polling only refreshes status and never calls the runner.

## Remaining activation work

See [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md). A supported recurring caller,
secure secret handling, real OAuth verification, explicit posting approval and
real due-time execution evidence are all required before enabling scheduling.
A test fixture, configured flag or saved calendar plan is not delivery proof.

The direct integration remains text-only. No passwords, shared LinkedIn browser sessions, callback proxies, scraping or alternative provider credentials were added. The trial uses StoryBank’s own LinkedIn queue and runner; no Buffer account, API or multi-platform expansion is included.

## Verification boundaries

Synthetic tests exercise the real queue SQL and triggers through SQLite-backed D1 fixtures and stub the provider. UI tests execute the actual component with controlled synthetic responses; they are not browser screenshots or live OAuth evidence. Production source synchronization, secret setup, live callback, real LinkedIn post, recurring trigger, and public launch remain unverified.
