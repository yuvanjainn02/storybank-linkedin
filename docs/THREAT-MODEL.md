> Technical design retained from the source candidate. Historical test/rollout statements below are not new verification; root `KNOWN_ISSUES.md` and `PROVENANCE.md` are authoritative for this handoff.

# StoryBank local foundation threat model

Reviewed scope: the local server domain, SQLite persistence, session boundary, personal export and deletion APIs. This is a design and test inventory, not an independent security audit, production certification, penetration test or legal-compliance finding. The browser prototype is separate and is not authenticated by this server library.

## Security goals and trust boundaries

1. An authenticated writer's stories, approval snapshots, plans, profile versions, calibration facts, previews, feedback, creator references and proposed revisions are private to that writer in the selected workspace.
2. Workspace membership is necessary but is not permission to read another member's personal content. Even workspace owners cannot bypass this rule. The same person in two workspaces has separate personal data in each.
3. Identity comes from a trusted server session and current authoritative membership, never from a display name, creator name, browser account switch, request body, exported file, requested item ID or client-supplied owner selector.
4. Any material change to the approved payload invalidates approval. Local plans cannot publish, whether called through the queue-like interface or the direct publishing method.
5. Failed durable mutations do not commit partial domain state or audit changes. Restart does not revive cancelled plans or remove idempotency reservations.
6. Export and deletion must follow the same owner boundary as normal reads and writes, including derived copies and old versions.

Trusted components are the application process, context authority, identity-verification adapter, current-membership resolver, storage composition, clock, ID generator and local filesystem access controls. Request handlers must not accept these dependencies from request data. The storage/session facades are infrastructure-only and must never be returned to a browser or mapped directly to public routes.

SQLite uses aggregate JSON records, with owner enforcement in the domain layer. It does not provide independent database row-level security or normalized owner-scoped foreign keys. The process loads all aggregate records inside its transaction. A compromised application process, filesystem/DB administrator, malicious trusted identity adapter or stolen DB backup is outside the confidentiality boundary currently enforced here. Schema/record validation detects a class of corruption; it is not authentication of a maliciously rewritten database.

## Threats, present controls and remaining limits

| Threat | Present control | Remaining requirement before a public service |
| --- | --- | --- |
| Cross-user or cross-workspace item access | Tenant-qualified lookup plus authenticated creator check for stories, snapshots and jobs; user-qualified keys for profiles/calibrations/proposals; subject-scoped lists, audits and exports | Exercise these boundaries through actual network endpoints, object storage, caches, search, embeddings and worker contexts. No implicit collaboration bypass. |
| A workspace owner reads another writer's work | Role grants no personal-data read bypass. Integration revocation can invalidate all workspace plans, but only the affected writer sees their content-related audit records | Any future sharing/delegation must be explicit and separately authorized. Do not derive sharing from owner role. |
| Name/creator reference selects another person's writing profile | Owner comes only from context; profile and privacy selection APIs reject owner/tenant selectors | Resolve creator research separately; treat creator names and URLs as untrusted references rather than identity or permission. |
| Browser-forged identity or stale membership | Opaque authority-minted contexts, original-subject binding and live membership/session recheck | Deploy a verified OIDC adapter and authoritative membership service. Default sign-in rejects use. The library is not a complete login implementation. |
| Session theft, fixation or CSRF | Random opaque tokens, digest-only persistence, fixed expiry, rotation, secure HTTP-only SameSite cookie template; exact HTTPS origin and CSRF token required for JSON mutations; GET/HEAD contexts cannot mutate | Real HTTPS routes, correct cookie handling, CSP/XSS defenses, login/callback state/nonce/PKCE validation, rate limits, account recovery and session-store operations testing. An XSS-capable attacker is not stopped by CSRF alone. |
| Cross-user idempotency leaks or accidental duplicate plans | Request and approval-job reservations include authenticated tenant and user; exact planning request hash; one plan per approval | These are local planning invariants, not provider exactly-once guarantees. Durable provider delivery needs outbox/claim/reconciliation semantics. |
| Stale approval or cancellation is ignored | Fixed-schema approval hash, version checks, revocation and cancellation; due processor is owner-scoped and always blocked | Revalidate approval, current membership, media access, destination and connection generation immediately before any future dispatch. Define in-flight cancellation uncertainty. |
| Persistence loses acknowledged edits or partially erases data | Versioned/checksummed migrations; local SQLite transactions load, mutate and save aggregate state atomically; failure rolls back | Operational backups, restore drills, capacity limits, monitoring, migration/rollback rehearsals and scalable storage. Whole-state transactions serialize operations and are not a production scaling architecture. |
| Export mixes users or includes infrastructure secrets | Export derives tenant/user from authenticated context and returns detached personal records; no session tokens/provider credentials are included | Public export delivery must use private download authorization, size limits, retention and expiry. Avoid caching or logging export bodies. |
| Deletion leaves derived personal copies | `deleteOwnData` removes own stories, snapshots, profiles/all versions, calibrations/embedded feedback/previews, proposals, jobs and both reservation indexes in the current workspace | Audio/object storage, caches, search, model context, external exports, backups and future derived systems need their own tested deletion protocol. |
| Content leaks into audit | Events contain IDs, type, timestamps and allowlisted operational metadata, not story/profile/fact/feedback text or request keys. Visibility follows subject owner, not actor's workspace role | Logs, errors, traces and telemetry in a future host need separate redaction and access review. Audit is not a tamper-evident ledger. |
| Uploaded content or creator examples cause prompt injection | Current calibration is deterministic and has no model/tools. Strings cannot change identity, database scope or publishing permission | Future generation must keep source content inside untrusted data boundaries, use only authenticated owner's sources and never interpret examples as tool/system instructions. |
| Secret/provider credential exposure | No provider tokens are accepted or stored, OAuth is disabled and publishing fails closed | Separate minimal-scope grants, external KMS/envelope encryption, narrow service roles, rotation/revocation, verified destination and explicit publish consent. |

## Export contract

`exportOwnData(context)` exports only the authenticated user's records in the context's selected workspace. It has no target-user or all-workspaces selector. The result includes:

- Existing stories and media identifier references, all retained approval snapshots, and all own planned/cancelled/blocked jobs, including metadata left by prior individual-story deletion.
- Own idempotency reservations, all writing-profile versions, creator references and applied guidance.
- Calibration facts, generated template previews, embedded feedback/edited examples, pending and applied revision proposals, and own audit metadata.
- Explicit limitations concerning audio objects, backups/remnants, downloaded copies and account/session lifecycle.

The approval-to-job map is an internal duplicate-prevention index; its relationships are already represented by exported job and approval IDs. It is deleted in full for the owner by personal deletion. Infrastructure membership, sessions, workspace integration control state and another writer's data are not part of the export.

A previously deleted story body or profile version is not reconstructable through this export. The export is a snapshot of live logical records, not forensic recovery or a copy of the raw database. Returned data is detached from stored state, so editing the result cannot mutate live records.

## Deletion contract and honest limits

`deleteOwnData(context)` is current-workspace personal-content deletion, not global account deletion. It requires a current editor/owner session and accepts no identity selector. It deletes actual modeled records and returns their counts. A viewer is still unable to mutate data; a production privacy-request workflow for a downgraded/removed member is not implemented.

The operation removes:

- Stories and their media-reference lists.
- All owner approval snapshots, including superseded/revoked ones.
- All owner jobs, including terminal jobs left after a story was removed.
- Idempotency and approval-job reservations, so erased reservations cannot resurrect an old plan.
- All owner writing-profile versions and creator-reference/guidance copies.
- Calibration facts, preview variants, embedded feedback/edited examples and pending/applied proposals.
- The owner's prior activity audit; one content-free deletion receipt remains, with tenant/subject/actor IDs, timestamp and counts. An actor identifier may remain in another subject's integration-revocation audit, because it records the administrative action rather than that actor's deleted writing content.

Other users' records, the same user's records in another workspace and workspace-wide integration-revocation state remain unchanged. Integration revocation is never undone by deletion. Repeating deletion is safe, but receipt timestamps/IDs and the removed audit-event count can change.

Important limits:

- No server-side audio object storage or audio metadata model exists. Story media IDs are references only. Counting/removing those references does not prove erasure of recordings. Browser IndexedDB recordings have a separate lifecycle, and the server does not control them. Do not report an audio-object deletion count.
- SQLite logical deletion is not cryptographic erasure. `secure_delete` is a mitigation, not proof that data has disappeared from WAL/journal files, snapshots, free storage blocks, filesystem copies or backups. Storage-at-rest encryption and key-destruction guarantees are not implemented.
- There is no backup-retention policy, legal-hold policy, deletion-tombstone service or restore-time deletion replay. Restoring an older backup can restore previously removed data. These must be designed and tested before promising durable erasure beyond live logical records.
- Downloaded skill files/exports, third-party copies, published provider content and separately stored media are outside this API's control.
- This operation does not disable an account, remove memberships, revoke sessions, revoke provider grants or delete all workspaces. A global account-deletion coordinator must first block new authenticated work, revoke/reconcile sessions and grants, define cross-workspace authority, stop/reconcile in-flight work and remove dependent data with a durable completion record. That coordinator is not implemented.
- Personal-profile reset intentionally retains prior versions. Individual profile or calibration deletion has a narrower scope than full personal deletion. Do not present reset as erasure or assume that deleting a calibration removes already-applied profile guidance.

## Evidence and release gates

`server/test/privacy.test.mjs` covers same-tenant access denial even for owners, separate workspaces for the same subject, private idempotency/due processing, comprehensive export contents, detached copies, forged identity selectors, complete personal-data cascades and counts, terminal orphan-job cleanup, safe repetition/key reuse, content-free audit and workspace-wide revocation without personal-data disclosure.

The security/session/durable suites cover the complementary approval, authorization, session and persistence contracts, including restart and rollback where specified by their tests. Test success is not proof of a secure deployed service.

Before exposing this library to real users: implement and independently review actual authentication/network boundaries, verified endpoint composition, rate/body-size limits, secure rendering, private media storage and upload scanning, operational audit/logging policy, encrypted storage/secret management, backups and restore erasure, full account lifecycle, monitoring/incident response and production concurrency/load behavior. Keep live publishing, OAuth and model-provider sharing disabled until their separate contracts are implemented and authorized.

## Hosted v0.2 candidate addendum

The current source also contains a supported Sites/Vinext app. Server helpers consume only Sites-managed visitor identity. The D1 adapter derives a personal workspace from that stable visitor ID, qualifies reads/writes by owner and workspace, validates all persisted relationships, and uses atomic revision compare-and-set. It retries confirmed contention only, not ambiguous writes. The entire personal aggregate is currently capped at 1,000,000 UTF-8 bytes; it is not a high-scale relational design. The custom Node sessions are an alternative local boundary, not the hosted authentication implementation.

Private audio lives in a separate D1 metadata table and R2 namespace. Object keys never reach clients. Requests require owner authorization, a MIME allowlist, a streamed 10 MiB bound and same-origin mutation checks. Authenticated playback supports bounded single ranges and no-store responses. Upload reservations precede R2 writes; deletion tombstones precede object deletion. In-flight/uncertain uploads retain hidden cleanup records rather than falsely claiming erasure. Failed tombstone writes cannot guarantee hiding. No cross-D1/R2 transaction exists. A new upload after a cleanup snapshot is not included; prevent concurrent activity during a user-requested clearing operation. Quotas, abandoned-upload reconciliation, backup retention and operational monitoring remain release gates.

The hosted full-delete route clears writing data, then attempts audio cleanup and returns 202 with explicit pending state when completion is not confirmed. A text export is not a full account archive: recordings are downloaded separately. Neither operation revokes managed account access or erases external copies. The retained `/legacy/index.html` prototype still has its browser-local workspace; it is neither uploaded nor deleted by the new server controls.

Approval schema v2 binds both the original editor text and its exact plain export. New approval rejects empty output, more than 3,000 characters, and unresolved placeholder markers. A material edit invalidates approval and plans. Equivalent plain content cannot have two active plans for the same writer/destination/media. Old unreleased v1 approval aggregates are not silently upgraded or reset; they fail validation and require an explicit migration before reuse.

Local real-runtime smoke tests exercise the supported loopback mock identity, actual local D1/R2 emulators and process restart. They are stronger than the contract fake but still do not prove real ChatGPT sign-in, live cloud access control, production concurrency or a multi-customer release. Public access and external providers remain disabled.
