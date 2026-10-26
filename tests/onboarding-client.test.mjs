import test from 'node:test';
import assert from 'node:assert/strict';
import { freshOnboarding, demoFromExperience, experienceFacts, feedbackRecord, wizardError, creatorResearchMessage } from '../hosted/lib/onboarding-flow.mjs';
import { deriveCreatorResearchStatus } from '../server/creator-research-status.mjs';
import { toggleSelectedBold, toggleSelectedMarkers, accessiblePlainText, codePointLength } from '../hosted/lib/editor-format.mjs';
import { plainText } from '../server/plain-text.mjs';
import { requiresWorkspaceRefresh, WorkspaceRequestError } from '../hosted/lib/studio-flow.mjs';

const form = () => ({ displayName: 'Fictional writer', linkedinProfileUrl: 'https://www.linkedin.com/in/fictional-writer/', creators: [{ name: 'Reference', profileUrl: '', notes: 'Clear story openings' }], onboarding: freshOnboarding(), voice: 'Direct', tone: 'Warm', hooks: 'Start with the moment', structure: 'Situation, action, lesson', vocabulary: 'Plain language', avoid: 'Invented results' });

test('creator notes are optional; names or links still identify each reference', () => {
  const input = form(); input.creators[0].notes = '';
  assert.equal(wizardError(input, 3), '');
  input.creators[0].name = ''; input.creators[0].profileUrl = 'https://www.linkedin.com/in/fictional-writer/';
  assert.equal(wizardError(input, 3), '');
  input.creators[0].profileUrl = '';
  assert.match(wizardError(input, 3), /name or LinkedIn profile/);
});

test('research status displays only a matching saved server projection', () => {
  const status = deriveCreatorResearchStatus({ version: 2, preferences: { creators: [{ name: 'Fictional reference' }] } });
  assert.match(creatorResearchMessage(status, 2), /1 reference saved · not yet researched/);
  assert.match(creatorResearchMessage(status, 2, true), /Unsaved references/);
  assert.match(creatorResearchMessage(status, 3), /Refresh to check/);
  assert.match(creatorResearchMessage(undefined, 2), /Refresh to check/);
  assert.match(creatorResearchMessage(deriveCreatorResearchStatus(), 0), /No saved creator references/);
  for (const patch of [{ researchStatus: 'complete' }, { reviewedSourceCount: 1 }, { automaticResearchAvailable: true }, { collectionStatus: 'researching' }, { schema: 'future-schema' }, { referenceCount: 16 }]) assert.match(creatorResearchMessage({ ...status, ...patch }, 2), /Refresh to check/);
});
test('blank setup can save current step, but cannot skip identity, references or real experience', () => {
  const input = form(); input.displayName = ''; assert.equal(wizardError(input, 1), ''); assert.match(wizardError(input, 2), /name/);
  input.displayName = 'Writer'; input.creators = []; assert.equal(wizardError(input, 2), ''); assert.match(wizardError(input, 3), /at least one/);
  input.creators = form().creators; assert.equal(wizardError(input, 3), ''); assert.match(wizardError(input, 4), /title/);
});
test('creator bounds of 1 and 15 are accepted, 16 and uncleared samples are rejected without mutation', () => {
  const input = form(); for (const count of [1, 15]) { input.creators = Array.from({ length: count }, () => ({ ...form().creators[0] })); assert.equal(wizardError(input, 3), ''); }
  input.creators.push({ ...form().creators[0] }); const before = structuredClone(input); assert.match(wizardError(input, 3), /15/); assert.deepEqual(input, before);
  input.creators = [{ ...form().creators[0], sample: 'An owned sample.', rightsConfirmed: false }]; assert.match(wizardError(input, 3), /permission/);
  input.creators[0].rightsConfirmed = true; assert.equal(wizardError(input, 3), '');
});
test('own-profile URL rejects credentials, foreign hosts and fake connection URLs', () => {
  const input = form(); for (const url of ['https://linkedin.com.attacker.test/in/me', 'http://linkedin.com/in/me', 'https://me:password@linkedin.com/in/me', 'https://linkedin.com/in/', 'https://linkedin.com/oauth/authorize']) { input.linkedinProfileUrl = url; assert.match(wizardError(input, 2), /HTTPS LinkedIn profile/); }
});
test('template uses only supplied experience and preserves unknown outcomes', () => {
  const experience = { title: 'Access to 3D visualization', context: 'Small builders did not have easy access to 3D visualization.', action: 'I explored making visualization more accessible.', outcome: '', lesson: '' };
  const demo = demoFromExperience(experience); assert.equal(demo, `${experience.title}\n\n${experience.context}\n\n${experience.action}`); assert.equal(experienceFacts(experience).length, 2); assert.doesNotMatch(demo, /increased|revenue|%|architects were unemployed/);
});
test('feedback, revision reason and fact approval gates preserve back-navigation data', () => {
  const input = form(); const state = input.onboarding; Object.assign(state.experience, { title: 'Fictional moment', context: 'I noticed a confusing form.', action: 'I asked for feedback.' }); state.demoText = demoFromExperience(state.experience); state.feedback.revisedText = state.demoText;
  assert.match(wizardError(input, 6), /specific/); state.feedback.liked = 'good'; assert.match(wizardError(input, 6), /specific/); state.feedback.liked = 'Keep the short opening'; assert.equal(wizardError(input, 6), '');
  state.feedback.revisedText += '\nA clearer ending.'; assert.match(wizardError(input, 6), /why/); state.feedback.reason = 'The sequence is clearer.'; assert.equal(wizardError(input, 6), '');
  state.status = 'complete'; assert.match(wizardError(input, 6), /facts/); state.factsApproved = true; assert.equal(wizardError(input, 6), '');
  const snapshot = JSON.stringify(input); wizardError(input, 2); assert.equal(JSON.stringify(input), snapshot); assert.match(feedbackRecord(state), /Keep the short opening/);
});
test('workspace-switch mismatch requires refresh, not automatic retry', () => { assert.equal(requiresWorkspaceRefresh(new WorkspaceRequestError('Changed account', { status: 409, code: 'WORKSPACE_CHANGED' })), true); });
test('bold toggles on and off only within selection, preserving Hindi, emoji and newlines', () => {
  const original = 'Start हिंदी 🌱 hello 123\nEnd'; const start = original.indexOf('हिंदी'), end = original.indexOf('\n'); const decorated = toggleSelectedBold(original, start, end);
  assert.equal(decorated.changed, true); assert.ok(decorated.text.startsWith('Start हिंदी 🌱 ')); assert.ok(decorated.text.endsWith('\nEnd')); assert.equal(accessiblePlainText(decorated.text), original);
  const normal = toggleSelectedBold(decorated.text, decorated.start, decorated.end); assert.equal(normal.text, original); assert.equal(codePointLength(decorated.text), codePointLength(original)); assert.ok(decorated.text.length > original.length);
  assert.equal(plainText(decorated.text), decorated.text, 'Approved/exported plain text preserves exact decorative glyphs');
});
test('empty and unmapped selections do not invent placeholders or corrupt surrogate pairs', () => {
  const original = 'हिंदी 🌱'; assert.equal(toggleSelectedBold(original, 0, original.length).text, original); assert.equal(toggleSelectedBold('abc', 1, 1).text, 'abc');
  const mixed = '🌱abc'; const changed = toggleSelectedBold(mixed, 1, mixed.length); assert.ok(changed.text.startsWith('🌱')); assert.equal(accessiblePlainText(changed.text), mixed);
  assert.equal(toggleSelectedMarkers('abc', 1, 1).text, 'abc');
});
test('workspace italic markers can be removed with the repeated selection action', () => {
  const formatted = toggleSelectedMarkers('Hello world', 6, 11); assert.equal(formatted.text, 'Hello *world*'); const removed = toggleSelectedMarkers(formatted.text, formatted.start, formatted.end); assert.equal(removed.text, 'Hello world');
});

test('selective emphasis decorates opening and takeaway, never body or final hashtag lines', async () => {
  const { applyEmphasisPreference } = await import('../hosted/lib/editor-format.mjs');
  const original = 'A true opening\n\nNormal body in हिंदी 🌱.\n\nMy actual takeaway.\n\n#Learning #Building';
  const result = applyEmphasisPreference(original, 'hook_takeaway');
  assert.equal(accessiblePlainText(result), original); assert.ok(result.includes('Normal body in हिंदी 🌱.')); assert.ok(result.endsWith('#Learning #Building')); assert.ok(!result.startsWith('A true opening'));
  assert.equal(applyEmphasisPreference(result, 'hook_takeaway'), result, 'repeat application is idempotent');
  assert.equal(applyEmphasisPreference(result, 'none'), original); assert.equal(applyEmphasisPreference(result, 'manual'), result);
});

test('decorated exact text is approved unchanged, and unbolding revokes approval and cancels old plan', async () => {
  const { StoryBankRepository, createContextAuthority } = await import('../server/index.mjs');
  const authority = createContextAuthority({ resolveSession: token => token === 'fixture-session' ? { subject: 'fictional-writer', memberships: [{ tenantId: 'fixture-workspace', role: 'owner' }] } : null });
  const context = authority.authenticate('fixture-session', 'fixture-workspace');
  const repository = new StoryBankRepository({ authority, clock: () => new Date('2026-10-23T00:00:00Z') });
  const decorated = toggleSelectedBold('My real story हिंदी 🌱', 0, 13).text;
  const story = repository.createStory(context, { title: 'Fictional fixture', text: decorated, source: 'draft:fixture' });
  const approval = repository.approveStory(context, story.id, { expectedRevision: 1 });
  assert.equal(approval.record.snapshot.text, decorated);
  const job = repository.schedulePlan(context, { storyId: story.id, approvalId: approval.record.id, dueAt: '2026-10-24T00:00:00Z', idempotencyKey: 'fixture-format-plan' });
  repository.updateStory(context, story.id, { text: accessiblePlainText(decorated) }, { expectedRevision: 1 });
  assert.equal(repository.getStory(context, story.id).activeApprovalId, null);
  assert.equal(repository.getJob(context, job.id).status, 'cancelled');
  assert.equal(repository.getApproval(context, approval.record.id).record.snapshot.text, decorated, 'Original approved payload remains immutable');
});
