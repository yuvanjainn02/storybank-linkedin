# StoryBank LinkedIn writing studio

A **source handoff for development**, not a finished LinkedIn publisher. This is
the latest verified manual-approval candidate on the live v5 source—not a
reconstruction from an older prototype. Read [known issues](KNOWN_ISSUES.md)
and [provenance](PROVENANCE.md) before changing or deploying it.

## What you can work on

- Stories/drafts, per-user writing profiles and rights-confirmed samples.
- A reviewable brief to copy into your own ChatGPT conversation, then paste a draft back.
- Exact-revision approval, reject/save feedback, approval invalidation and manual plans.
- Disabled-by-default LinkedIn OAuth, text-posting and owner-bound runner scaffolding.

**ChatGPT workspace sign-in is separate from connecting LinkedIn.** Manual
plans do not publish posts or send reminders. Automatic AI, transcription and
creator-post scraping are not active.

## Local setup

Use **Node.js 24+** and npm. No live credentials are needed for loopback testing.

```sh
# From the repository root:
npm --prefix hosted run install:ci
npm run db:local          # Local D1 migrations only
npm run dev              # Portable preview: http://localhost:5173
```

Use the preview's local sign-in action for its **synthetic Seedy account** and
use fictional content. This mock is not real ChatGPT/LinkedIn authentication.
Keep the server on loopback; do not expose it through a tunnel or deploy it as
public authentication. Stop it with Ctrl-C after testing.

The two `.openai/hosting.json` files contain only required DB/BUCKET binding
names and intentionally have **no deployment identity**.
`hosted/.dev.vars.example` documents optional server configuration with blank
credentials and provider switches off; it is not required for the manual flow.
Do not copy credentials from the original app.

## Checks

Run sequentially after installing the locked hosted dependencies:

```sh
node --test --test-concurrency=1 tests/*.test.mjs server/test/*.test.mjs
npm run test:hosted-ui
npm run check:hosted
npm run check
npm run build
```

The pre-sanitization candidate passed 376 core tests, 99 component/event checks,
type/syntax checks and a production build. These are **historical results, not
a fresh full-suite pass for this repo**. Fresh-machine setup, browser QA and
live integration verification remain open. See `HANDOFF_VALIDATION.md`.

## Code map

| Path | Purpose |
| --- | --- |
| `hosted/app/Studio.tsx` | Writing/profile/approval/manual-plan UI |
| `hosted/components/` | Onboarding, manual brief, planning, LinkedIn UI |
| `server/repository.mjs` | Domain rules and revision-bound approvals |
| `server/hosted-{http,d1,audio}.mjs` | Owner-scoped hosted adapters |
| `server/linkedin-{http,provider,store,runner}.mjs` | Gated provider and queue |
| `hosted/drizzle/` | Source database migrations |
| `tests/`, `server/test/`, `scripts/test-*.mjs` | Synthetic test coverage |
| `prototype/` | Historical local-only prototype retained for tests—not the hosted app |

Build creates local output only; it does not deploy. Production requires trusted
identity dispatch and separately provisioned DB/R2 resources. This repo has no
original secrets, environment values, user records, audio, Git history,
node_modules or build output. Vendored licenses are retained. Nothing here
grants permission to publish to a real account.

