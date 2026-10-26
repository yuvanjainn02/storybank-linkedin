> Technical design retained from the source candidate. Historical test/rollout statements below are not new verification; root `KNOWN_ISSUES.md` and `PROVENANCE.md` are authoritative for this handoff.

# Personal onboarding and selective emphasis

Status: implemented and tested in the cloud checkout, not deployed. Base commit: 61df6ffcb76ba082951fcc48c989b8989bc92094. This change does not activate AI drafting, transcription, LinkedIn OAuth, or publishing, and does not change the private Site audience.

## First-use journey

1. Preferred name and informational HTTPS LinkedIn profile URL. No password field or false connected state.
2. One to fifteen named or linked creator references, a specific observation for each, and optional rights-cleared pasted samples. No crawling, scraping or creator API requests.
3. A real experience: title, context and personal action; outcome and lesson are optional so unknown results stay unknown. Existing deliberate voice-recording flow is available, with no claimed transcription.
4. A deterministic demo made from supplied experience. It is marked as a template, not AI. Selective decorative emphasis changes characters, not the claims.
5. Specific feedback, a revised example and a reason for changes. Raw source, demo and feedback remain in the owner-scoped record.
6. Reviewed voice, tone, hooks, structure, vocabulary, don’ts, emphasis preference, approved facts and editable/exportable versioned Markdown.

Save & continue, Save & back, and Save & exit store checkpoints. The latest in-progress step resumes on refresh. There is no silent browser-local autosave: unsaved edits are visibly labeled and guarded on navigation/refresh. Stale or uncertain saves stop further mutations until recovery. A new saved version does not silently replace unsaved input. Existing users keep their current dashboard and data, with an optional setup entry.

## Isolation and compatibility

Optional profile fields remain absent in older records. No D1 or SQLite schema migration is required. Profiles and histories retain the existing authenticated-owner isolation and compare-and-set version checks. The workspace response supplies an opaque workspace key. New clients attach it as a consistency precondition, and account-switched mutations (including audio) fail before side effects. The key does not select authority; server-verified identity remains authoritative. The UI clears prior-account forms and dialogs when it loads another workspace.

Profile requests are bounded to 512 KiB, while other JSON operations remain at 64 KiB. Existing cumulative workspace storage stays capped at 1 MB. Long samples across many immutable versions can reach this limit; errors preserve existing data rather than truncating it. This remains a capacity limitation for a future storage redesign.

## Text formatting

The supplied visual reference was inspected. Its useful pattern is a bold opening hook and closing takeaway, a normal-weight body, and native LinkedIn blue names/hashtags. Its personal story was not imported as this user’s experience.

A per-user setting chooses opening/takeaway emphasis, manual-only selection, or plain text. New setup defaults to opening/takeaway; old profiles retain manual behavior unless changed. Users can bold or unbold selected Latin letters/digits, remove decorative bold, and toggle workspace-only italics. Hindi, other unmapped glyphs, emoji, whitespace and paragraph boundaries are preserved. Hashtag-only ending paragraphs are excluded from automatic emphasis. No arbitrary text-color control or fake LinkedIn mention is added.

Bold is decorative Unicode, not native LinkedIn rich text. The exact Unicode text remains in the approved snapshot and exact-copy/download output. Accessible plain copy/download is available as a clearly labeled alternative, not falsely treated as the approved decorated version. The conservative existing 3,000 UTF-16-unit approval gate remains; the UI also displays actual Unicode code-point count. Any saved edit continues to revoke approval and cancel existing plans.

## Verification and limits

Automated coverage includes legacy-schema compatibility, all stage prerequisites, creator bounds, sample rights, immutable versions, stale saves, SQLite/D1 persistence across reload, same-tenant/cross-tenant isolation, account-switched writes, explicit factual review, template evidence, select/unselect formatting, Hindi/emoji preservation, and idempotent selective emphasis. All six steps are server-render tested for progress, labels, save/back actions and honest provider labels.

Browser click/keyboard/device QA was not run in this task because the required current preview/browser skill was unavailable. Render tests are not a substitute for a real browser session. Live microphone/R2 behavior, production multi-account sessions, exact platform visual rendering and deployment require later verification. No live user data was modified during tests; fixtures are fictional.
