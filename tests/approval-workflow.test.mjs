import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextAuthority } from '../server/context.mjs';
import { StoryBankRepository } from '../server/repository.mjs';
import { createD1StoryBank, personalWorkspaceId } from '../server/hosted-d1.mjs';
import { createD1Fixture } from './support/d1-fixture.mjs';
import { manualWritingBrief } from '../hosted/lib/manual-writing-brief.mjs';
const now = () => new Date('2026-10-25T12:00:00Z');
function setup() {
  const authority = createContextAuthority({ resolveSession: user => ({ subject: user, memberships: [{ tenantId: personalWorkspaceId(user), role: 'owner' }] }) });
  const alice = authority.authenticate('alice', personalWorkspaceId('alice'));
  const bob = authority.authenticate('bob', personalWorkspaceId('bob'));
  return { authority, alice, bob };
}
for (const adapter of ['memory', 'D1']) test(`${adapter}: reject feedback survives reload, invalidates approval/plan and remains owner-only`, async t => {
  const { authority, alice, bob } = setup();
  const db = adapter === 'D1' ? createD1Fixture() : null;
  if (db) t.after(() => db.close());
  let repository;
  const open = () => { repository = db ? createD1StoryBank({ db: db.db, authority, clock: now }) : new StoryBankRepository({ authority, clock: now }); };
  open();
  const call = (user, method, ...args) => db ? repository.invoke(user, method, args) : Promise.resolve().then(() => repository[method](user, ...args));
  const story = await call(alice, 'createStory', { text: 'I changed the agenda.' });
  assert.equal(Object.hasOwn(story, 'reviewFeedback'), false, 'Legacy shape stays unchanged');
  const approval = await call(alice, 'approveStory', story.id, { expectedRevision: 1 });
  const job = await call(alice, 'schedulePlan', { storyId: story.id, approvalId: approval.record.id, dueAt: '2026-10-26T12:00:00Z', idempotencyKey: 'workflow-fixture-1' });
  for (const reviewFeedback of ['', ' ', 'x'.repeat(2001), {}, null]) await assert.rejects(call(alice, 'updateStory', story.id, { reviewFeedback }, { expectedRevision: 1 }), e => e.code === 'INVALID_REVIEW_FEEDBACK');
  await assert.rejects(call(bob, 'updateStory', story.id, { reviewFeedback: 'Cross-owner edit' }, { expectedRevision: 1 }));
  const rejected = await call(alice, 'updateStory', story.id, { reviewFeedback: 'Keep it factual. Remove the unsourced result.' }, { expectedRevision: 1 });
  assert.equal(rejected.revision, 2); assert.equal(rejected.text, story.text); assert.equal(rejected.activeApprovalId, null);
  assert.equal((await call(alice, 'getJob', job.id)).status, 'cancelled');
  if (db) open();
  assert.equal((await call(alice, 'getStory', story.id)).reviewFeedback, rejected.reviewFeedback);
  assert.deepEqual(await call(bob, 'listStories'), []);
  await assert.rejects(call(alice, 'updateStory', story.id, { reviewFeedback: 'Stale feedback' }, { expectedRevision: 1 }), e => e.code === 'REVISION_CONFLICT');
  await call(alice, 'approveStory', story.id, { expectedRevision: 2 });
  // Identical requested changes must still withdraw a newer approval.
  const again = await call(alice, 'updateStory', story.id, { reviewFeedback: rejected.reviewFeedback }, { expectedRevision: 2 });
  assert.equal(again.revision, 3); assert.equal(again.activeApprovalId, null);
  assert.equal((await call(alice, 'getJob', job.id)).publishAttempts, 0);
});
test('manual brief includes saved review as quoted feedback, never as factual evidence', () => {
  const brief = manualWritingBrief({ facts: 'I changed the agenda.', reviewFeedback: 'Remove invented metrics.' });
  assert.match(brief, /"requestedChangesNotFactualEvidence": "Remove invented metrics\."/);
  assert.match(brief, /Do not invent experiences/);
  assert.ok(brief.indexOf('requestedChangesNotFactualEvidence') > brief.indexOf('BEGIN QUOTED STORYBANK CONTENT'));
});
