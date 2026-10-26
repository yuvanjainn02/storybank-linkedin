# Source provenance and sanitization

## Exact source

- Base tester v5 commit: `9e97fcee624789b1d0f55665e3ebb5daecdae278`.
- Working tree: the manual-approval candidate on that exact base.
- Verified bundle: `StoryBank-manual-approval-candidate.zip`, version 2.
- Bundle SHA-256: `80935a36c00d8d6b54cac6c1989d2124215e09ee9138684b1e998834b2dadd1e`.
- All **14 changed-file SHA-256 values matched** the bundle manifest.
- The working tree staged binary diff **exactly matched** the bundle patch.
- Full working source was copied—not just a patch. No older reconstruction
  was merged in, and Git history was not copied.

## Handoff-only changes

Product/domain/HTTP/provider code is unchanged.

- Replace both hosting manifests with unassigned local configs containing only
  `d1: DB` and `r2: BUCKET`; remove live project identity.
- Change the corresponding test to require unassigned configs. Existing guard
  tests still reject inconsistent identity or missing storage bindings.
- Rewrite root/hosted/server READMEs for this handoff.
- Remove account-specific passages from retained LinkedIn design notes, label
  historical test/rollout statements and omit superseded rollout/QA documents.
- Add a blank configuration example and stronger ignore rules.
- Add portable framework type declarations without generated route manifests.
- Add handoff status, validation and SHA-256 manifest.

## Excluded

Original `.git` config/history/remotes; real environment values, credentials
and tokens; tool/session state; runtime databases/audio; private user records;
logs/screenshots/QA exports; node_modules and caches; generated build output,
standalone HTML and typing caches; live hosting identifiers. The two neutral
binding configs remain because build tooling needs them, not because a live
project is selected.

Synthetic credentials and fictional records remain in tests for security and
provider failure coverage. They are not production credentials. Vendored helpers,
the locked dependencies and required license files are preserved.

`SHA256SUMS` covers every deliverable file except itself. It is an integrity
snapshot, not a signature. The archive hash is reported separately.

