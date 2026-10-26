# Known issues and unfinished verification

Status recorded 26 October 2026. This is a source candidate, not proof that all
features are ready.

## Integration blockers

1. **LinkedIn callback is not established.** At the last provider check, only the
   Postman test redirect was saved. Intended route:
   `https://<approved-site-origin>/api/linkedin/callback`. Adding the correct
   tester callback had been approved but not executed at handoff. Do not reuse
   an older original-site callback or a callback proxy.
2. **No end-to-end OAuth verification.** Real consent, token exchange,
   state/cookie round trip, nonce compatibility, identity display, disconnect
   and reconnect remain unverified. Local fixtures are not provider evidence.
3. **No real post or scheduled delivery verified.** Provider/runner flags remain
   off or unconfigured. A calendar plan is not a scheduled publisher, and no
   supported persistent recurring trigger has been established.
4. **Deployment configuration is absent here.** The live tester remained v5 with
   environment revision 1, rechecked at 10:06 UTC on 26 October 2026. Only
   `STORYBANK_SITE_ORIGIN` was configured there; LinkedIn secrets/activation
   were not established. The newer workflow candidate is not deployed by this
   source handoff.

## Product and QA boundaries

- Managed Sites/ChatGPT workspace sign-in and LinkedIn authorization are separate.
  Generic hosting is not a drop-in option: never trust public caller-supplied
  identity headers outside trusted dispatch.
- Manual copy/paste writing works without a paid API. No autonomous generation,
  transcription, completed creator research or automatic feedback learning.
- Prior 376 core tests, 99 UI/component checks, type/syntax and build results
  belong to the exact pre-sanitization candidate. They did not prove real
  browser/mobile, live two-account, OAuth or posting behavior.
- Browser QA was blocked by execution-to-browser network isolation. This handoff
  did not launch a preview, reinstall dependencies or rebuild while unrelated
  rendering was running. Recheck fresh-clone setup and browser flows:
  interrupted saves, double clicks, Back/Close, account switching, feedback
  and replanning.
- Integration is text-only. API version `202610` is a source-snapshot default,
  not an assurance of current provider compatibility.
- A timeout, ambiguous provider response or missing post identifier becomes
  `unknown`, not safe to retry. Inspect the real account before any retry.
- The runner is single-owner and disabled by default. A flag is not a scheduler.

## Data compatibility

The candidate adds optional `reviewFeedback` to existing records without a new
migration. Unmodified old v5's exact-shape D1 reader cannot read records containing
that field. Do not roll back to an unmodified old reader after writing feedback.
Preserve the compatible optional-field validation in `server/hosted-d1.mjs`
and `server/persistence.mjs`; never delete user data to force compatibility.

Use synthetic data when fixing this project. Deployment, real credentials,
member grants, posts, invitations and unattended activation are separate actions;
this handoff has not performed them.

