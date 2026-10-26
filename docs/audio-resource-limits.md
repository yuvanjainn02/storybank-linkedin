> Technical design retained from the source candidate. Historical test/rollout statements below are not new verification; root `KNOWN_ISSUES.md` and `PROVENANCE.md` are authoritative for this handoff.

# Public-tester audio resource limits

This is a bounded tester safeguard, not internet-scale anti-abuse protection and not a claim about any provider's free or paid quotas. It does not cap platform request charges, playback/egress traffic, backups, network buffering before the application, or accounts created outside StoryBank. The public tester still needs platform-level access controls, monitoring and cost limits appropriate to its actual deployment.

## Defaults and configuration

Migration `0003_audio_resource_limits.sql` creates one durable configuration row in `storybank_audio_policy`. All Worker instances use that same row; clients cannot change it. The application has no configuration endpoint. Operators may change these positive integer limits through an authorized, reviewed database migration. Lowering a limit never deletes existing recordings: new reservations are denied until usage falls below it. Changing a rate limit does not reset counters.

| Scope | Stored/reserved bytes | Stored/reserved objects | Admitted upload attempts |
| --- | ---: | ---: | ---: |
| One authenticated owner | 52,428,800 (50 MiB) | 20 | 12 per fixed 600-second window |
| Entire bound project database | 524,288,000 (500 MiB) | 200 | 120 per fixed 600-second window |

One file remains limited to 10,485,760 bytes (10 MiB). A MiB is 1,048,576 bytes. Project means all owners sharing this D1 database and its audio bucket; separate databases do not coordinate budgets even if incorrectly pointed at the same bucket. Keep that binding pair isolated for the tester.

The fixed windows are UTC Unix-epoch multiples of 600 seconds, using the database clock, not a client timestamp. Fixed windows allow a burst on either side of a boundary; they are not a sliding-window rate limiter. Rate exhaustion returns HTTP 429 and `AUDIO_UPLOAD_RATE_LIMITED`. Owner and project storage exhaustion return HTTP 429 and `AUDIO_OWNER_QUOTA_REACHED` or `AUDIO_PROJECT_QUOTA_REACHED`. Denials do not read the request body in application code or issue an R2 put. Clients must not automatically retry unknown-outcome 503 responses.

Missing migration tables, missing required triggers, or a missing policy row fail closed for uploads. Existing read/delete behavior does not require a new upload reservation. Deploy the complete migration before the corresponding application. Both root and hosted migration files must remain identical. Existing recordings are counted directly, with no approximate counter backfill.

## Atomic reservation and accounting

Before the application consumes a body or calls R2, one metadata INSERT and its SQLite/D1 triggers check both owner and project byte/object budgets and attempt counters, then reserve the object and charge both attempt counters in the same statement transaction. A trigger failure rolls back all those effects. There is no process-local lock or non-atomic read-then-write quota decision.

A valid `Content-Length` reserves that exact number of bytes. The bounded reader rejects a longer body before storage; a shorter body is rejected as a length mismatch. Unknown length reserves the entire 10 MiB file maximum, then shrinks to the verified actual byte count before R2 is called. Thus an otherwise small upload with unknown length can be denied when less than 10 MiB is free. Empty, aborted, oversize and mismatched bodies release their reservation only while the original uploader knows it has never invoked R2. Their admitted attempts remain charged. Invalid MIME/encoding/advertised-size requests are rejected before reservation and are not charged.

All metadata rows count towards aggregate storage, including uploading, active, deleting, crashed, and uncertain outcomes. An unknown D1 acknowledgment may retain the reservation even though no R2 request was made. A failed release can also leave a charged incomplete reservation. No route erases these merely because they are old.

`storybank_audio_rate` contains operational metadata: authenticated owner IDs, counter window starts and attempt counts, not audio content or transcripts. Expired counters are opportunistically pruned on the next admitted upload, not guaranteed to disappear after ten minutes if traffic stops. There is at most one counter per owner plus a project counter; the number of current-window owner counters is bounded by admitted project attempts. Workspace/recording deletion does not refund attempts or erase current-window counters. No audio bytes, transcript, credentials or full request bodies are logged by this module.

## Conservative deletion and reconciliation

Deleting a completed recording first hides it, then confirms R2 deletion, then erases its metadata. Only removing that final metadata releases its bytes/object reservation. A failed or uncertain R2 delete leaves a hidden reservation that a later owner deletion can retry safely. A successful R2 deletion with failed metadata erasure likewise retains quota until cleanup succeeds.

An incomplete upload retains its hidden tombstone even after a successful R2 delete because a previously started put could still complete later. Once a running uploader confirms its put, the existing race-safe cleanup path can delete the late object and release metadata. A rejected or uncertain put never authorizes quota release, even if the immediate best-effort delete succeeded.

There is intentionally no age-based reservation expiry or automatic orphan reconciliation. A stuck incomplete row may consume budget indefinitely and block more uploads. Before any manual reconciliation, an operator must establish that no uploader or queued put can still write that key, then verify/delete the matching object, and only then remove the reservation. Age, an empty object listing, or one successful delete alone is insufficient evidence while a writer could still be running. This code does not claim backup erasure or guaranteed cleanup of objects written by unsupported external systems.

## Local verification

`node --test tests/hosted-audio.test.mjs` exercises the real migration SQL in SQLite and synthetic R2 responses, including simultaneous owner/project reservations, rate windows, rollback, unknown database/storage outcomes, conservative deletion, legacy records, account isolation and bounded body reads. These tests do not contact providers, create projects, provision credentials or deploy anything.

D1's statement/transaction behavior is documented at [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [D1 SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/). Provider behavior still requires authorized local-runtime/staging verification before a production readiness claim.
