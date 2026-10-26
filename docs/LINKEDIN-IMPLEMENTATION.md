> Technical design retained from the source candidate. Historical test/rollout statements below are not new verification; root `KNOWN_ISSUES.md` and `PROVENANCE.md` are authoritative for this handoff.

# StoryBank LinkedIn publishing implementation

Status: isolated source candidate, implemented and locally tested, not connected to a real LinkedIn member and not live-post tested. See `LINKEDIN-RUNNER-CANDIDATE.md` for the new owner-bound runner and gated scheduling UI, their verification boundaries and remaining activation work. Default configuration disables OAuth and publishing. No automatic scheduler is represented as working.

## What is implemented

- `/publishing`: connection readiness, explicit connection explanation, account/expiry display, exact-version review, public or first-degree-connections audience, text-only Publish now, cancellation and publication history.
- `/api/linkedin/{status,connect,callback,preview,publish,cancel,disconnect}`: authenticated, owner-scoped HTTP endpoints. Mutations require the expected site origin and workspace identity. Identity comes only from Sites’ authenticated server context.
- Official confidential-client authorization code flow with `openid profile w_member_social`. No email scope, passwords, browser-session cookies, creator-post scraping, organization posting, or refresh-token assumptions.
- Single-use OAuth state, browser binding, expiry, signed RS256 identity verification, exact live-discovery issuer, audience and nonce checks, and userinfo subject matching. New connection attempts, disconnect and privacy deletion invalidate in-flight callback completion.
- AES-256-GCM tokens bound to owner, connection generation and purpose. Tokens and client secrets never reach client responses or application logs. This is server-side encryption, not end-to-end encryption. The server operator can decrypt tokens with the production key.
- Immutable final snapshots bind exact approved Unicode text, author identity, connection generation, audience and time. Transport escapes LinkedIn’s little-text reserved characters without changing the intended text.
- D1-persisted jobs with atomic dispatch reservations, one attempt, idempotency keys, duplicate-content protection and recorded post URNs. Editing/revoking a source approval or reconnecting invalidates queued jobs. Source/connection mutation is blocked while sending.
- Network errors, 5xx responses, unexpected success or missing post identifiers become `unknown`. Expired dispatch leases also become unknown, never requeued. There is no blind retry or exactly-once delivery claim.
- Disconnect removes the local token and cancels unsent jobs. It does not claim to revoke LinkedIn’s own permission grant. Workspace-data deletion also clears connection credentials, pending authorization attempts and publication history; previously published posts and backups are unaffected.

## Deliberate limits

- Publishing is text-only. Media, organizations, comments, likes, analytics, creator feeds and AI generation are out of scope.
- StoryBank’s existing calendar remains a manual plan. Managed Sites’ scheduler/cron contract has not been established. Scheduled publication requests fail closed while `LINKEDIN_SCHEDULER_VERIFIED` is false. The candidate adds an authenticated one-job runner endpoint and gated scheduling review, but no deployed recurring trigger. A flag alone is insufficient: valid owner-bound runner configuration is also required. Do not set that flag merely to enable a button.
- The minimal scopes do not include the restricted member-post read permission. An ambiguous result cannot reliably be reconciled through the API. The user must inspect LinkedIn; the app does not retry it.
- Programmatic refresh is not assumed. The actual expiry is enforced; reconnect is required before expiry or after revocation. Key rotation also requires reconnecting unless a separately reviewed migration is added.
- Generic PKCE support at LinkedIn’s ordinary confidential web endpoint is unverified. Optional S256 support exists behind `LINKEDIN_PKCE_ENABLED`; it is off until tested for this app. Native-only PKCE endpoints are not substituted.
- A nonce is sent and strictly validated. If a real token omits it, connection fails closed; do not silently weaken validation. Provider compatibility must be established in the authorized live OAuth test.

## Integration status for this handoff

See [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) for the current verified status.
No deployment identity, production configuration, credentials, or member grants
are included. Use your own separately authorized configuration if developing
a real integration. Workspace sign-in and LinkedIn authorization are separate.
The intended route is `/api/linkedin/callback`; `/callback` belongs to Sites.
An authenticated real-browser round trip remains unverified.

## Production configuration

Store production values in Sites runtime environment variables, then deploy the saved source version to apply the environment revision. Preserve owner-only access. Never use a browser-visible `NEXT_PUBLIC_` variable for these values.

| Variable | Secret | Initial setting |
| --- | --- | --- |
| `LINKEDIN_CLIENT_ID` | No | Exact existing app client ID |
| `LINKEDIN_CLIENT_SECRET` | Yes | Existing app secret, via an approved secure transfer |
| `LINKEDIN_TOKEN_KEY` | Yes | Cryptographically random 32 bytes encoded as standard base64 |
| `LINKEDIN_OAUTH_ENABLED` | No | `false` until callback and secret setup are ready |
| `LINKEDIN_PUBLISHING_ENABLED` | No | `false` until member connection is verified and a test publication is approved |
| `LINKEDIN_API_VERSION` | No | `202610`, verified October 23, 2026 |
| `LINKEDIN_PKCE_ENABLED` | No | `false` unless this application’s endpoint support is verified |
| `LINKEDIN_SCHEDULER_VERIFIED` | No | `false`; no supported recurring runner is configured |

The Sites environment-variable API supports secret values with `is_secret: true`, but it is not itself a password/secret-entry handoff. A secure, authorized transfer path must be established before entering credentials for persistent use. Generated test secrets in the automated tests are synthetic and unrelated to production.

## Safe live verification sequence

1. Resolve the redirect-entry issue using supported LinkedIn/Sites configuration. Do not substitute Postman, a callback proxy, a browser session, shared passwords or public Site access as an improvised bypass.
2. Deploy the combined source, including migration `0002_linkedin_publishing.sql`, privately through the approved source route. Verify migrations and `/publishing` readiness.
3. Securely configure the approved existing app secret and generated encryption key. Enable only OAuth and redeploy.
4. In the owner’s signed-in StoryBank browser, start Connect. Check the LinkedIn application, exact minimal scopes and identity. Obtain action-time consent for the actual persistent grant.
5. Verify state/cookie round-trip, nonce, signed identity, matching userinfo subject, correct displayed member, scopes, expiry and token redaction. Test denial, replay, disconnect and reconnect. Do not call these tests successful merely because synthetic tests pass.
6. Prepare one short test post. Obtain explicit approval of its exact text, destination account and audience. Enable posting only for this approved test, then publish through the final review screen. Record the returned URN and inspect the real post. Deletion of the test post is a separate action, not assumed authorization.
7. Test editing/cancellation without posting extra content. An ambiguous live result stops testing until the user checks LinkedIn; never repeat the POST to see what happens.
8. Add unattended scheduling only after a real supported recurring runner, authenticated dispatch, process lifetime and due-time execution have been verified. Keep it visibly unavailable otherwise.

## Test evidence and interpretation

- Node tests use generated keys, synthetic identities/tokens and injected provider responses. SQLite executes the real schema, SQL constraints and triggers. These tests are not live LinkedIn or live D1 tests.
- A full synthetic HTTP OAuth round-trip verifies signed nonce, token exchange, identity binding, persistence and replay rejection.
- Concurrency tests cover simultaneous connection attempts, disconnect/new-attempt cancellation of callbacks, source-edit/send races, duplicate dispatch and delayed reservation responses after lease expiry.
- Local Wrangler successfully applies all three migrations, including the new tables and triggers. Production migrations remain unverified until deployment.
- Type checking, syntax checks and production bundling are run on the combined onboarding/editor and integration source.
- Browser UI validation and real callback/posting results must be reported separately from these automated checks.

## Official references

- [Live OIDC discovery](https://www.linkedin.com/oauth/.well-known/openid-configuration)
- [LinkedIn OIDC](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)
- [Authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [Share on LinkedIn permissions](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin)
- [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-10)
- [Little text syntax](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format?view=li-lms-2026-10)
- [API versioning](https://learn.microsoft.com/en-us/linkedin/marketing/versioning)
- [Refresh-token availability](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)
