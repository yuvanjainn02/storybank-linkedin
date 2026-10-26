> Technical design retained from the source candidate. Historical test/rollout statements below are not new verification; root `KNOWN_ISSUES.md` and `PROVENANCE.md` are authoritative for this handoff.

# StoryBank security and production-readiness contract

## Status: a local foundation, not production-complete

The deployed browser-local prototype and the server foundation are separate. The server now has locally tested SQLite persistence, secure-session interfaces, an HTTP-independent request adapter, and a hosted D1 adapter. A supported Sites/Vinext candidate is under `hosted/`; its private rollout must be verified separately from local checks. It uses Sites-managed ChatGPT identity rather than the optional custom session module. No live model service, LinkedIn OAuth connection, dispatch queue or publishing adapter is active. This is not a production-complete account service.

No passwords are collected. OAuth begin/callback operations are disabled. No access tokens, refresh tokens, secrets, or API keys are required or saved. No LinkedIn post can be sent by this library. A plan is only a local planning record; it is not a live scheduled post. No flag or environment variable enables live publishing.

Tests cover domain invariants, local process restart, SQLite concurrent connections/worker races, rollback, sessions, request boundaries, and D1-contract concurrency using an asynchronous SQLite fake. These are not proof of live D1 behavior, hosted identity, production scale, provider delivery, backups, compliance or protection against a compromised application process.

## Implemented boundaries

### Verified contexts and tenants

- Every repository operation requires an explicit context minted by a context authority. A plain object or copied object with a tenant/user ID does not authenticate.
- Contexts are bound to an opaque session handle and original subject. The trusted synchronous resolver is consulted for every operation, so revoked membership, deleted sessions, and changed session subjects fail closed. It must be backed by authoritative infrastructure, not request bodies, headers claiming a user ID, display names, or browser storage.
- Role checks distinguish viewers, editors, and workspace owners. Only owners can revoke an integration. All repository lookup keys include the authenticated tenant ID. Unauthorized item IDs receive a workspace-local not-found response.
- Stories, approval snapshots, plans, audits, profiles, calibration facts, feedback and proposals are private to the authenticated writer in their workspace. The workspace-owner role does not bypass another writer’s personal-data boundary. The hosted adapter derives one personal workspace from the verified Sites visitor ID; it does not accept a client-selected identity or tenant.
- No browser identity switch, exported name, creator name, or client-provided `userId` establishes a different account identity. Creator references never select the profile owner.

### Approval and local plans

- Each approval has a fixed-schema SHA-256 snapshot binding tenant, story ID, revision, title, body, source, platform, destination, and media identifiers. Any future publish-relevant field must enter a new snapshot schema before it is usable.
- Approval hashes are immutable internal records. Revocation is separate metadata. Copies returned to callers cannot mutate stored records. Hashes demonstrate equality, not user authenticity or a cryptographic signature.
- Edits use optimistic revision checks; material changes revoke the current approval and cancel pending plans. No-op edits preserve it. New approval supersedes old approval. Revocation, deletion, and integration revocation cancel affected plans.
- Idempotency keys are tenant-and-user-scoped and bind the complete planning request. Reusing a key with a different request fails. A unique approval-to-job mapping prevents two request keys from generating two jobs for one approval. An idempotent retry returns the existing terminal status, not a revived job.
- Due processing is tenant-and-user-scoped, rechecks current approval, and always marks due plans blocked. `publishAttempts` remains zero. Direct publishing separately throws `INTEGRATION_DISABLED`. There is no publish callback injection or live provider implementation.
- The default in-memory constructor remains ephemeral. The SQLite adapter persists reservations and all domain state inside BEGIN IMMEDIATE transactions with complete aggregate load/save. It is correctness-first local storage, not production-scale RLS. The D1 adapter uses an owner-qualified row and atomic compare-and-set revision; only definite contention retries. Unknown write outcomes do not retry automatically.

### Personal writing profiles and calibration

- Personal preferences and creator name/bookmark references are versioned per tenant and authenticated user. Exports contain only that user’s selected version. Creator names/URLs are references, not claims that posts were inspected or techniques researched.
- Calibration produces 3–5 non-AI format previews from user-supplied facts. It does not invent experiences or use another user’s history. At creation it reads the latest personal profile version, not a shared default profile.
- Likes, dislikes, edit reasons, free feedback, and edited examples belong to one calibration owner. They cannot be appended/read/exported/applied by another user, including a teammate.
- Feedback proposes a reviewable profile revision. It never silently changes the active profile or trains a model. Explicit apply creates a new version. A changed profile or newer feedback rejects an outstanding stale proposal. Reset creates a new blank version; deletion is distinct from reset.
- Templates only implement a small formatting response to positive concise-format preferences. Saved/exported feedback is not a claim of full AI style learning. Provider-backed generation must be added and evaluated before claiming that behavior.

## Required authentication/OIDC contract before launch

1. Choose an audited OIDC client implementation and provider. Use authorization code flow with PKCE S256. Generate cryptographically random, single-use `state`, `nonce`, and PKCE verifier; bind them to the initiating server-side session, exact provider, intended tenant, fixed redirect URI, and short expiry. Store the verifier only server-side. Never accept a tenant/user identity from the callback query string as authenticated truth.
2. Validate callback state exactly and consume it atomically once. Reject mismatched, expired, missing, or replayed state. Exchange the code at the configured issuer’s verified HTTPS token endpoint with the matching verifier and fixed redirect URI. Do not allow open redirects or arbitrary issuer/endpoint input.
3. Validate ID token signature against trusted issuer keys with a strict allowed algorithm list. Validate exact issuer, audience/client ID, authorized party where required, expiry, issued-at, nonce, and appropriate clock-skew limits. Reject algorithm confusion, unsigned tokens, wrong issuer/audience, and token substitution. Handle key rotation without trusting attacker-controlled key locations.
4. Map the verified provider subject and issuer to an internal account. Obtain current workspace membership from the server database. Link accounts only through an explicit, authenticated, collision-safe flow. A matching email/display name is not sufficient to take over or merge accounts.
5. Mint short-lived opaque server sessions using secure, HTTP-only cookies and appropriate SameSite behavior. Rotate on sign-in/privilege changes, expire and revoke sessions, enforce origin/CSRF checks on all mutations, restrict CORS, and rate-limit auth flows. Revalidate membership on privileged requests and job execution.
6. Implement sign-out, session/device revocation, callback replay tests, auth interruption/retry tests, verified redirect allowlists, and defense against session fixation. Do not implement password collection in StoryBank.

## Required provider connection and token contract

- Authentication to StoryBank and authorization to a publishing provider are separate grants. Request the minimum supported scopes for the user’s explicit task and display the exact destination identity. Connection alone is not consent to publish all future drafts.
- Store provider credentials only server-side. Use envelope encryption with an external managed KMS and environment-separated keys. Persist ciphertext, key version, and minimal metadata; keep KMS access in narrow service IAM roles. Never place secrets or decrypted tokens in browser storage, source files, exported skills, client logs, analytics, queue payloads, or exception messages.
- Require verified account/tenant binding for every token retrieval. Handle expiration and refresh with atomic refresh coordination. Rotate keys and credentials, audit decryption access, and provide a tested credential-compromise procedure.
- Disconnection must prevent new work immediately, revoke/erase token grants where supported, cancel pending jobs, and stop workers before outbound dispatch. Maintain a connection generation/revocation epoch and compare it at claim and immediately before dispatch. A revoked grant must not be silently reconnected or revived by a retry.
- Implement only officially supported provider capabilities and scopes. No password-based social-account automation, unofficial cookie reuse, scraping-based publication, or claim that an API capability exists without verification.

## Required storage and durable queue contract

- Use a transactional database with tenant IDs on every row, composite foreign keys, least-privilege application roles, and database row-level security or an equivalent tested enforcement layer. Profile/feedback keys must additionally contain the authenticated user ID. Scope search indexes, caches, object storage paths, embeddings, model context, background jobs, and exports by the same boundary.
- Use database-enforced uniqueness for idempotency reservations and approval-to-dispatch constraints. Store the approval snapshot hash, destination identity, connection generation, explicit schedule consent, and approved payload version with each durable job. Use an outbox transaction to enqueue only committed work.
- Workers require renewable leases, atomic claims, bounded retries with jitter, heartbeat/lease expiry, dead-letter handling, and cancellation checks. Revalidate membership, scope, approval snapshot, destination, media access, due time, and integration revocation immediately before an outbound side effect. No cross-tenant service account bypass.
- Handle the race between cancellation/revocation and a provider request. A cancellation cannot undo a request already accepted by the provider; report that uncertainty honestly. Use provider idempotency keys and reconcile ambiguous timeouts before retrying. Never promise exactly-once delivery when the provider does not offer it.
- Do not automatically retry a local blocked plan after enabling a future integration. Require a new explicit approval/scheduling action under the real integration contract.

## Required deletion and data lifecycle contract

- Individual story deletion removes story text and approval snapshots while preserving terminal job/audit metadata. Profile/calibration deletion retains its documented narrower scope. deleteOwnData deletes all modeled personal records in the selected workspace, including history, feedback, reservations and prior personal audit, retaining one content-free receipt. SQLite/D1 adapters commit that logical change durably; they do not claim forensic, backup, external-copy or global-account erasure. See THREAT-MODEL.md.
- Before launch, define retention and deletion for stories, profile versions, creator examples, calibration drafts/feedback, derived summaries, model context/embeddings, media, exports, caches, search indexes, queue payloads, provider tokens, logs, and backups. A user’s reset must not be mislabeled complete deletion.
- Account/workspace deletion must revoke sessions and provider grants, prevent new jobs, cancel/reconcile in-flight work, remove primary/derived records, and track completion. Define backup expiry and legal-hold exceptions transparently. Restore procedures must replay deletion tombstones so backups cannot silently resurrect deleted data.
- Verify authorization for export/deletion and ensure exports never mix users or tenants. Tell users that copies they already downloaded are outside server deletion control.

## Required AI and content handling contract

- Keep one versioned writing profile per account/workspace. Assemble generation inputs from that authenticated owner’s selected/latest version and authorized facts only. Do not reuse another user’s prompt, retrieval result, examples, cache, or hidden feedback history.
- Treat creator pages, uploaded examples, draft text, and feedback as untrusted content, not operational instructions. Use structured data boundaries. Such text cannot grant tools, account permissions, publication authority, or access to other users’ records.
- Disclose model provider and material data sharing before enabling generation. Configure retention and training terms, redact unnecessary personal information, and do not send credentials or unrelated private data. Store provenance for factual claims and flag missing facts rather than inventing them.
- Evaluate how feedback changes drafts, preserve original evidence, show proposed style changes, and support review/version/reset. Do not claim full style learning from saving a feedback string or extracting a few keywords.

## Operational launch checklist

Add a threat model and external security review; HTTPS, secure headers and CSP; output encoding; body-size and upload limits; malicious file scanning and private media storage; request/schema validation; CSRF/origin protections; rate limits; dependency/SBOM updates; secret scanning; structured redacted logs; monitoring/alerts; backup and restore drills; migration/rollback tests; accessibility and interrupted-flow QA; supported timezone/DST handling; and load/concurrency tests. Test actual tenant/user isolation at the API, storage, cache, queue, export, and generation layers. Keep publishing disabled until these contracts are implemented and verified.

## Locally implemented session and request adapters

The optional Node session boundary has default-deny identity verification, 32-byte random opaque sessions, SHA-256 token/CSRF digests, fixed expiry, rotation, sign-out and own-session revocation. Mutation requests require the exact configured HTTPS origin, synchronizer CSRF token and JSON. GET/HEAD contexts cannot call mutating domain operations. An injected verification callback is a trusted integration point, not an implemented OIDC verifier. No real credential or account session was created during tests.

The hosted candidate instead uses the documented Sites-managed getChatGPTUser helper. It does not implement or override platform sign-in/callback routes. API mutations require the fixed Site origin, same-origin fetch metadata when present, a custom request header and bounded JSON streaming; APIs return no-store responses and no CORS grant. The platform’s identity headers must be supplied by its trusted dispatch, not a standalone public Node server. Identity-less service bypass access is not a user identity and is rejected for personal records.

References used for the local boundary design: [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), and [Cloudflare D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/).
