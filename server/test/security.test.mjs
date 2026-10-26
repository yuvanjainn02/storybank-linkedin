import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryBankRepository, createContextAuthority, disabledIdentityProvider, oauthIntegration, publishingAdapter } from '../index.mjs';
import { hashSnapshot } from '../approval.mjs';

function fixture() {
  let time = Date.parse('2026-10-22T12:00:00Z');
  let counter = 0;
  const sessions = new Map([
    ['alice-session', { subject: 'alice', memberships: [{ tenantId: 'alpha', role: 'owner' }, { tenantId: 'beta', role: 'editor' }] }],
    ['bob-session', { subject: 'bob', memberships: [{ tenantId: 'beta', role: 'owner' }] }],
    ['cara-session', { subject: 'cara', memberships: [{ tenantId: 'alpha', role: 'editor' }] }],
    ['viewer-session', { subject: 'viewer', memberships: [{ tenantId: 'alpha', role: 'viewer' }] }],
  ]);
  const authority = createContextAuthority({ resolveSession: (session) => sessions.get(session) });
  const repo = new StoryBankRepository({ authority, clock: () => new Date(time), id: () => `id-${++counter}` });
  const alice = authority.authenticate('alice-session', 'alpha');
  const aliceBeta = authority.authenticate('alice-session', 'beta');
  const bob = authority.authenticate('bob-session', 'beta');
  const cara = authority.authenticate('cara-session', 'alpha');
  const viewer = authority.authenticate('viewer-session', 'alpha');
  const create = (context = alice, input = {}) => repo.createStory(context, { title: 'A real lesson', text: 'My own story.', destinationId: 'linkedin:me', ...input });
  const approved = (context = alice) => {
    const story = create(context);
    const approval = repo.approveStory(context, story.id, { expectedRevision: story.revision });
    return { story, approval };
  };
  const plan = (context, story, approval, overrides = {}) => repo.schedulePlan(context, { storyId: story.id, approvalId: approval.record.id, dueAt: '2026-10-22T13:00:00Z', idempotencyKey: 'request-key-1', ...overrides });
  return { repo, authority, sessions, alice, aliceBeta, bob, cara, viewer, create, approved, plan, advance: (ms) => { time += ms; } };
}

const code = (expected) => (error) => error.code === expected;

test('contexts cannot be fabricated, copied, or switched to another tenant', () => {
  const { repo, authority, alice } = fixture();
  assert.throws(() => repo.listStories({ tenantId: 'alpha', userId: 'alice', role: 'owner' }), code('UNAUTHENTICATED'));
  assert.throws(() => repo.listStories({ ...alice }), code('UNAUTHENTICATED'));
  assert.throws(() => authority.authenticate('bob-session', 'alpha'), code('FORBIDDEN'));
  assert.throws(() => authority.authenticate('unknown', 'alpha'), code('UNAUTHENTICATED'));
  assert.throws(() => { alice.tenantId = 'beta'; }, TypeError);
});

test('cross-tenant reads, writes, approvals, cancellations and deletion are denied', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  const job = f.plan(f.alice, story, approval);
  for (const operation of [
    () => f.repo.getStory(f.bob, story.id),
    () => f.repo.updateStory(f.bob, story.id, { text: 'Stolen' }, { expectedRevision: 1 }),
    () => f.repo.approveStory(f.bob, story.id, { expectedRevision: 1 }),
    () => f.repo.getApproval(f.bob, approval.record.id),
    () => f.repo.revokeApproval(f.bob, story.id),
    () => f.repo.getJob(f.bob, job.id),
    () => f.repo.cancelJob(f.bob, job.id),
    () => f.repo.deleteStory(f.bob, story.id),
    () => f.repo.publishNow(f.bob, story.id, approval.record.id),
  ]) assert.throws(operation, code('NOT_FOUND'));
  assert.deepEqual(f.repo.listStories(f.bob), []);
  assert.deepEqual(f.repo.listJobs(f.bob), []);
  assert.deepEqual(f.repo.listAudit(f.bob), []);
});

test('viewer permissions and current membership are checked on every operation', () => {
  const f = fixture();
  f.create();
  assert.equal(f.repo.listStories(f.viewer).length, 0);
  assert.throws(() => f.create(f.viewer), code('FORBIDDEN'));
  assert.throws(() => f.repo.runDuePlans(f.viewer), code('FORBIDDEN'));
  f.sessions.delete('alice-session');
  assert.throws(() => f.repo.listStories(f.alice), code('UNAUTHENTICATED'));
});

test('membership revocation and changed identity invalidate existing contexts', () => {
  const f = fixture();
  f.sessions.get('alice-session').memberships = [];
  assert.throws(() => f.repo.listStories(f.alice), code('FORBIDDEN'));
  f.sessions.set('alice-session', { subject: 'mallory', memberships: [{ tenantId: 'alpha', role: 'owner' }] });
  assert.throws(() => f.repo.listStories(f.alice), code('UNAUTHENTICATED'));
});

test('unknown fields cannot override server-owned tenant, user, or approval fields', () => {
  const f = fixture();
  for (const field of ['tenantId', 'createdBy', 'revision', 'activeApprovalId', '__proto__']) {
    assert.throws(() => f.create(f.alice, JSON.parse(`{"${field}":"untrusted"}`)), code('INVALID_FIELD'));
  }
});

test('approval binds exact revision, destination, text, and media; returned copies cannot mutate it', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  const originalHash = approval.record.hash;
  assert.equal(originalHash, hashSnapshot(approval.record.snapshot));
  approval.record.hash = 'a'.repeat(64);
  approval.record.snapshot.text = 'Changed outside repository';
  approval.record.snapshot.mediaIds.push('other');
  const stored = f.repo.getApproval(f.alice, approval.record.id);
  assert.equal(stored.record.hash, originalHash);
  assert.equal(stored.record.snapshot.text, story.text);
  assert.deepEqual(stored.record.snapshot.mediaIds, []);
});

test('each material edit revokes approval, preserves old snapshot hash, and cancels plans', () => {
  for (const patch of [{ text: 'New body' }, { title: 'New title' }, { source: 'New source' }, { destinationId: 'linkedin:someone-else' }, { mediaIds: ['asset-2'] }]) {
    const f = fixture();
    const { story, approval } = f.approved();
    const job = f.plan(f.alice, story, approval);
    const edited = f.repo.updateStory(f.alice, story.id, patch, { expectedRevision: 1 });
    assert.equal(edited.revision, 2);
    assert.equal(edited.activeApprovalId, null);
    assert.equal(f.repo.getApproval(f.alice, approval.record.id).record.hash, approval.record.hash);
    assert.equal(f.repo.getApproval(f.alice, approval.record.id).revocationReason, 'story_changed');
    assert.equal(f.repo.getJob(f.alice, job.id).status, 'cancelled');
    assert.throws(() => f.repo.publishNow(f.alice, story.id, approval.record.id), code('APPROVAL_INVALID'));
  }
});

test('stale edits and stale approvals fail; no-op updates do not revoke approval', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  assert.throws(() => f.repo.updateStory(f.alice, story.id, { text: 'Stale' }, { expectedRevision: 0 }), code('REVISION_CONFLICT'));
  assert.throws(() => f.repo.approveStory(f.alice, story.id, { expectedRevision: 0 }), code('REVISION_CONFLICT'));
  const same = f.repo.updateStory(f.alice, story.id, { text: story.text }, { expectedRevision: 1 });
  assert.equal(same.activeApprovalId, approval.record.id);
});

test('planning retries are idempotent and a second key cannot duplicate an approval', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  const first = f.plan(f.alice, story, approval);
  assert.equal(f.plan(f.alice, story, approval).id, first.id);
  assert.equal(f.repo.listJobs(f.alice).length, 1);
  assert.throws(() => f.plan(f.alice, story, approval, { dueAt: '2026-10-22T14:00:00Z' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => f.plan(f.alice, story, approval, { idempotencyKey: 'different-request' }), code('DUPLICATE_JOB'));
});

test('idempotency keys are scoped by tenant and cannot return a foreign job', () => {
  const f = fixture();
  const a = f.approved(f.alice);
  const b = f.approved(f.bob);
  const first = f.plan(f.alice, a.story, a.approval);
  const second = f.plan(f.bob, b.story, b.approval);
  assert.notEqual(first.id, second.id);
  assert.equal(f.repo.listJobs(f.bob)[0].tenantId, 'beta');
});

test('due jobs are blocked, never sent, never retried automatically, and remain tenant scoped', () => {
  const f = fixture();
  const a = f.approved();
  const b = f.approved(f.bob);
  f.plan(f.alice, a.story, a.approval);
  const betaJob = f.plan(f.bob, b.story, b.approval);
  assert.deepEqual(f.repo.runDuePlans(f.alice), []);
  f.advance(3_600_000);
  const [blocked] = f.repo.runDuePlans(f.alice);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.reason, 'integration_disabled');
  assert.equal(blocked.publishAttempts, 0);
  assert.deepEqual(f.repo.runDuePlans(f.alice), []);
  assert.equal(f.repo.getJob(f.bob, betaJob.id).status, 'planned');
  assert.throws(() => f.repo.publishNow(f.alice, a.story.id, a.approval.record.id), code('INTEGRATION_DISABLED'));
});

test('explicit cancellation is repeatable and no due processor revives a cancelled plan', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  const job = f.plan(f.alice, story, approval);
  f.repo.cancelJob(f.alice, job.id);
  f.repo.cancelJob(f.alice, job.id);
  f.advance(7_200_000);
  assert.deepEqual(f.repo.runDuePlans(f.alice), []);
  assert.equal(f.repo.getJob(f.alice, job.id).status, 'cancelled');
  assert.equal(f.plan(f.alice, story, approval).status, 'cancelled');
});

test('revoking approval cancels its plan and reapproval cannot revive it', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  const job = f.plan(f.alice, story, approval);
  f.repo.revokeApproval(f.alice, story.id);
  const next = f.repo.approveStory(f.alice, story.id, { expectedRevision: 1 });
  assert.notEqual(next.record.id, approval.record.id);
  assert.equal(f.repo.getJob(f.alice, job.id).status, 'cancelled');
  assert.throws(() => f.plan(f.alice, story, approval, { idempotencyKey: 'fresh-request' }), code('APPROVAL_INVALID'));
});

test('integration revocation requires owner and cancels only that tenant’s plans', () => {
  const f = fixture();
  const a = f.approved();
  const b = f.approved(f.bob);
  const first = f.plan(f.alice, a.story, a.approval);
  const second = f.plan(f.bob, b.story, b.approval);
  assert.throws(() => f.repo.revokeIntegration(f.cara), code('FORBIDDEN'));
  assert.equal(f.repo.revokeIntegration(f.alice).status, 'revoked');
  assert.equal(f.repo.getJob(f.alice, first.id).status, 'cancelled');
  assert.equal(f.repo.getJob(f.bob, second.id).status, 'planned');
  const fresh = f.repo.approveStory(f.alice, a.story.id, { expectedRevision: 1 });
  assert.throws(() => f.plan(f.alice, a.story, fresh, { idempotencyKey: 'new-after-revoke' }), code('INTEGRATION_REVOKED'));
});

test('story deletion removes content-bearing approval snapshots and cancels pending plans', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  const job = f.plan(f.alice, story, approval);
  f.repo.deleteStory(f.alice, story.id);
  assert.throws(() => f.repo.getStory(f.alice, story.id), code('NOT_FOUND'));
  assert.throws(() => f.repo.getApproval(f.alice, approval.record.id), code('NOT_FOUND'));
  assert.equal(f.repo.getJob(f.alice, job.id).status, 'cancelled');
  assert.ok(!JSON.stringify(f.repo.listAudit(f.alice)).includes(story.text));
});

test('no OAuth or password integration can silently activate publishing', () => {
  assert.equal(publishingAdapter.canPublish, false);
  assert.throws(() => publishingAdapter.publish(), code('INTEGRATION_DISABLED'));
  assert.throws(() => { publishingAdapter.canPublish = true; }, TypeError);
  assert.throws(() => oauthIntegration.beginAuthorization(), code('OAUTH_DISABLED'));
  assert.throws(() => oauthIntegration.completeAuthorization(), code('OAUTH_DISABLED'));
  assert.throws(() => disabledIdentityProvider.authenticate(), code('AUTH_NOT_CONFIGURED'));
});

test('timezone-free or past plans fail; blank drafts cannot be approved', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  assert.throws(() => f.plan(f.alice, story, approval, { dueAt: '2026-10-22T13:00:00' }), code('INVALID_DATE'));
  assert.throws(() => f.plan(f.alice, story, approval, { dueAt: '2026-10-22T11:00:00Z' }), code('INVALID_DATE'));
  const empty = f.create(f.alice, { text: '   ' });
  assert.throws(() => f.repo.approveStory(f.alice, empty.id, { expectedRevision: 1 }), code('EMPTY_CONTENT'));
});

test('personal writing profiles are isolated between users in the same tenant', () => {
  const f = fixture();
  f.repo.saveWritingProfile(f.alice, { displayName: 'Alice', voice: 'Warm, grounded, concise' }, { expectedVersion: 0 });
  assert.throws(() => f.repo.getWritingProfile(f.cara), code('NOT_FOUND'));
  assert.deepEqual(f.repo.listWritingProfileVersions(f.cara), []);
  f.repo.saveWritingProfile(f.cara, { displayName: 'Cara', voice: 'Technical, detailed' }, { expectedVersion: 0 });
  assert.equal(f.repo.getWritingProfile(f.alice).preferences.voice, 'Warm, grounded, concise');
  assert.equal(f.repo.getWritingProfile(f.cara).preferences.voice, 'Technical, detailed');
  // Supplying an identity selector cannot change whose data is returned.
  assert.throws(() => f.repo.getWritingProfile(f.cara, { userId: 'alice' }), code('INVALID_PROFILE_SELECTION'));
  assert.throws(() => f.repo.saveWritingProfile(f.cara, { userId: 'alice', voice: 'Replace Alice' }, { expectedVersion: 1 }), code('INVALID_PROFILE'));
});

test('one user’s profile also remains isolated between that user’s workspaces', () => {
  const f = fixture();
  f.repo.saveWritingProfile(f.alice, { voice: 'Alpha only' }, { expectedVersion: 0 });
  assert.throws(() => f.repo.getWritingProfile(f.aliceBeta), code('NOT_FOUND'));
  assert.throws(() => f.repo.getWritingProfile(f.bob), code('NOT_FOUND'));
});

test('writing profile versions and exports preserve exact personal preferences', () => {
  const f = fixture();
  const first = f.repo.saveWritingProfile(f.alice, { displayName: 'Alice', voice: 'Plain-spoken', creators: [{ name: 'Example Creator', profileUrl: 'https://www.linkedin.com/in/example/', notes: 'Prefer concrete anecdotes, not copied language.' }] }, { expectedVersion: 0 });
  first.preferences.voice = 'Client mutation';
  f.repo.saveWritingProfile(f.alice, { voice: 'More analytical' }, { expectedVersion: 1 });
  assert.equal(f.repo.getWritingProfile(f.alice, { version: 1 }).preferences.voice, 'Plain-spoken');
  assert.equal(f.repo.getWritingProfile(f.alice).version, 2);
  assert.throws(() => f.repo.saveWritingProfile(f.alice, { voice: 'Stale' }, { expectedVersion: 1 }), code('VERSION_CONFLICT'));
  const exported = f.repo.exportWritingSkill(f.alice, { version: 1 });
  assert.equal(exported.filename, 'storybank-personal-writing-v1.md');
  assert.match(exported.content, /Plain-spoken/);
  assert.match(exported.content, /Example Creator/);
  assert.match(exported.content, /not evidence that their posts have been researched/);
  assert.ok(!exported.content.includes('More analytical'));
});

test('creator references reject non-LinkedIn links, credentials, scripts, and client identities', () => {
  const f = fixture();
  for (const profileUrl of ['javascript:alert(1)', 'https://linkedin.com.evil.test/in/name', 'http://www.linkedin.com/in/name', 'https://user:password@www.linkedin.com/in/name', 'https://www.linkedin.com/company/name']) {
    assert.throws(() => f.repo.saveWritingProfile(f.alice, { creators: [{ name: 'Name', profileUrl }] }, { expectedVersion: 0 }), code('INVALID_PROFILE'));
  }
});

test('personal profile deletion removes all own versions but not a teammate’s', () => {
  const f = fixture();
  f.repo.saveWritingProfile(f.alice, { voice: 'Alice only' }, { expectedVersion: 0 });
  f.repo.saveWritingProfile(f.cara, { voice: 'Cara only' }, { expectedVersion: 0 });
  f.repo.deleteWritingProfile(f.alice);
  assert.deepEqual(f.repo.listWritingProfileVersions(f.alice), []);
  assert.throws(() => f.repo.getWritingProfile(f.alice, { version: 1 }), code('NOT_FOUND'));
  assert.equal(f.repo.getWritingProfile(f.cara).preferences.voice, 'Cara only');
});

test('calibration creates 3 to 5 marked template previews using only supplied facts', () => {
  const f = fixture();
  const facts = ['I ran two workshops.', 'Seven people gave feedback.'];
  const calibration = f.repo.createCalibration(f.alice, { topic: 'My workshops', facts, count: 5 });
  assert.equal(calibration.variants.length, 5);
  assert.equal(calibration.mode, 'non_ai_template_preview');
  for (const variant of calibration.variants) {
    for (const fact of facts) assert.ok(variant.text.includes(fact));
    assert.equal(variant.kind, 'non_ai_template_preview');
  }
  assert.throws(() => f.repo.createCalibration(f.alice, { topic: 'Topic', facts: [], count: 3 }), code('INVALID_CALIBRATION'));
  assert.throws(() => f.repo.createCalibration(f.alice, { topic: 'Topic', facts, count: 6 }), code('INVALID_CALIBRATION'));
});

test('calibration facts, drafts, feedback and revisions are private to their authenticated owner', () => {
  const f = fixture();
  const calibration = f.repo.createCalibration(f.alice, { topic: 'Private topic', facts: ['A private fact.'] });
  f.repo.addCalibrationFeedback(f.alice, calibration.id, { variantId: calibration.variants[0].id, likes: ['Direct opening'], dislikes: ['Too long'], editReasons: 'Keep one idea.', feedback: 'Prefer short paragraphs.', editedText: 'A private fact.' });
  const proposal = f.repo.proposeWritingRevision(f.alice, calibration.id);
  for (const intruder of [f.cara, f.bob, f.aliceBeta]) {
    assert.throws(() => f.repo.getCalibration(intruder, calibration.id), code('NOT_FOUND'));
    assert.throws(() => f.repo.addCalibrationFeedback(intruder, calibration.id, { variantId: calibration.variants[0].id, feedback: 'Replace preferences' }), code('NOT_FOUND'));
    assert.throws(() => f.repo.proposeWritingRevision(intruder, calibration.id), code('NOT_FOUND'));
    assert.throws(() => f.repo.getWritingRevision(intruder, proposal.id), code('NOT_FOUND'));
    assert.throws(() => f.repo.applyWritingRevision(intruder, proposal.id, { expectedVersion: 0 }), code('NOT_FOUND'));
    assert.throws(() => f.repo.deleteCalibration(intruder, calibration.id), code('NOT_FOUND'));
  }
});

test('feedback never silently applies: reviewed proposals create versioned personal guidance', () => {
  const f = fixture();
  f.repo.saveWritingProfile(f.alice, { voice: 'My original voice' }, { expectedVersion: 0 });
  const calibration = f.repo.createCalibration(f.alice, { topic: 'Topic', facts: ['A fact.'] });
  f.repo.addCalibrationFeedback(f.alice, calibration.id, { variantId: calibration.variants[0].id, likes: ['Short paragraphs'], dislikes: ['Hype'], feedback: 'Keep my actual details.' });
  const proposal = f.repo.proposeWritingRevision(f.alice, calibration.id);
  assert.equal(proposal.status, 'proposed');
  assert.equal(f.repo.getWritingProfile(f.alice).version, 1);
  assert.equal(f.repo.getWritingProfile(f.alice).preferences.feedbackGuidance, '');
  const applied = f.repo.applyWritingRevision(f.alice, proposal.id, { expectedVersion: 1 });
  assert.equal(applied.version, 2);
  assert.match(applied.preferences.feedbackGuidance, /Prefer: Short paragraphs/);
  assert.match(applied.preferences.feedbackGuidance, /Avoid: Hype/);
  assert.equal(applied.preferences.voice, 'My original voice');
  assert.equal(f.repo.applyWritingRevision(f.alice, proposal.id, { expectedVersion: 1 }).version, 2);
  assert.equal(f.repo.listWritingProfileVersions(f.alice).length, 2);
  const next = f.repo.createCalibration(f.alice, { topic: 'Next topic', facts: ['A new fact.'] });
  assert.equal(next.profileVersion, 2);
});

test('new feedback or a manual profile edit invalidates an outstanding proposal', () => {
  const f = fixture();
  const calibration = f.repo.createCalibration(f.alice, { topic: 'Topic', facts: ['A fact.'] });
  const feedback = { variantId: calibration.variants[0].id, feedback: 'Be direct.' };
  f.repo.addCalibrationFeedback(f.alice, calibration.id, feedback);
  const first = f.repo.proposeWritingRevision(f.alice, calibration.id);
  f.repo.addCalibrationFeedback(f.alice, calibration.id, { ...feedback, feedback: 'Prefer shorter endings.' });
  assert.throws(() => f.repo.applyWritingRevision(f.alice, first.id, { expectedVersion: 0 }), code('FEEDBACK_CHANGED'));
  const second = f.repo.proposeWritingRevision(f.alice, calibration.id);
  f.repo.saveWritingProfile(f.alice, { voice: 'A newer preference' }, { expectedVersion: 0 });
  assert.throws(() => f.repo.applyWritingRevision(f.alice, second.id, { expectedVersion: 0 }), code('VERSION_CONFLICT'));
});

test('future preview generation uses latest profile version; reset creates a new clean version', () => {
  const f = fixture();
  const input = { topic: 'Topic', facts: ['First fact.', 'Second fact.'] };
  f.repo.saveWritingProfile(f.alice, { voice: 'Detailed' }, { expectedVersion: 0 });
  const before = f.repo.createCalibration(f.alice, input);
  f.repo.saveWritingProfile(f.alice, { voice: 'Concise' }, { expectedVersion: 1 });
  const after = f.repo.createCalibration(f.alice, input);
  assert.equal(before.profileVersion, 1);
  assert.equal(after.profileVersion, 2);
  assert.notEqual(before.variants[0].text, after.variants[0].text);
  const reset = f.repo.resetWritingProfile(f.alice, { expectedVersion: 2 });
  assert.equal(reset.version, 3);
  assert.equal(reset.preferences.voice, '');
  assert.equal(f.repo.getWritingProfile(f.alice, { version: 2 }).preferences.voice, 'Concise');
});

test('deleting calibration removes original feedback and proposals, but not applied versions', () => {
  const f = fixture();
  const calibration = f.repo.createCalibration(f.alice, { topic: 'Topic', facts: ['A fact.'] });
  f.repo.addCalibrationFeedback(f.alice, calibration.id, { variantId: calibration.variants[0].id, feedback: 'Be direct.' });
  const proposal = f.repo.proposeWritingRevision(f.alice, calibration.id);
  f.repo.applyWritingRevision(f.alice, proposal.id, { expectedVersion: 0 });
  f.repo.deleteCalibration(f.alice, calibration.id);
  assert.throws(() => f.repo.getCalibration(f.alice, calibration.id), code('NOT_FOUND'));
  assert.throws(() => f.repo.getWritingRevision(f.alice, proposal.id), code('NOT_FOUND'));
  assert.match(f.repo.getWritingProfile(f.alice).preferences.feedbackGuidance, /Be direct/);
});

test('applied positive formatting feedback affects subsequent previews, but proposed feedback does not', () => {
  const f = fixture();
  const input = { topic: 'Topic', facts: ['First fact.', 'Second fact.'] };
  const original = f.repo.createCalibration(f.alice, input);
  f.repo.addCalibrationFeedback(f.alice, original.id, { variantId: original.variants[0].id, likes: ['Concise formatting'] });
  const proposal = f.repo.proposeWritingRevision(f.alice, original.id);
  const unapproved = f.repo.createCalibration(f.alice, input);
  assert.equal(unapproved.variants[0].text, original.variants[0].text);
  f.repo.applyWritingRevision(f.alice, proposal.id, { expectedVersion: 0 });
  const applied = f.repo.createCalibration(f.alice, input);
  assert.notEqual(applied.variants[0].text, original.variants[0].text);
  assert.equal(applied.profileVersion, 1);
});

test('feedback cannot switch identity, reference a different calibration’s variant, or mutate stored copies', () => {
  const f = fixture();
  const first = f.repo.createCalibration(f.alice, { topic: 'First', facts: ['Fact one.'] });
  const second = f.repo.createCalibration(f.alice, { topic: 'Second', facts: ['Fact two.'] });
  assert.throws(() => f.repo.addCalibrationFeedback(f.alice, first.id, { variantId: first.variants[0].id, userId: 'cara', feedback: 'Wrong identity' }), code('INVALID_FEEDBACK'));
  assert.throws(() => f.repo.addCalibrationFeedback(f.alice, first.id, { variantId: second.variants[0].id, feedback: 'Wrong draft' }), code('NOT_FOUND'));
  const saved = f.repo.addCalibrationFeedback(f.alice, first.id, { variantId: first.variants[0].id, likes: ['Specific facts'] });
  saved.likes.push('Tampered value');
  first.facts[0] = 'Tampered fact';
  assert.deepEqual(f.repo.getCalibration(f.alice, first.id).feedback[0].likes, ['Specific facts']);
  assert.equal(f.repo.getCalibration(f.alice, first.id).facts[0], 'Fact one.');
});

test('profile deletion also removes proposal copies and prevents reapplying deleted preferences', () => {
  const f = fixture();
  const calibration = f.repo.createCalibration(f.alice, { topic: 'Topic', facts: ['A fact.'] });
  f.repo.addCalibrationFeedback(f.alice, calibration.id, { variantId: calibration.variants[0].id, feedback: 'Old guidance' });
  const proposal = f.repo.proposeWritingRevision(f.alice, calibration.id);
  f.repo.applyWritingRevision(f.alice, proposal.id, { expectedVersion: 0 });
  f.repo.deleteWritingProfile(f.alice);
  assert.throws(() => f.repo.getWritingRevision(f.alice, proposal.id), code('NOT_FOUND'));
  assert.throws(() => f.repo.applyWritingRevision(f.alice, proposal.id, { expectedVersion: 0 }), code('NOT_FOUND'));
});

test('planning rejects JavaScript calendar rollover and normalizes explicit timezone offsets', () => {
  const f = fixture();
  const { story, approval } = f.approved();
  assert.throws(() => f.plan(f.alice, story, approval, { dueAt: '2027-02-30T13:00:00Z' }), code('INVALID_DATE'));
  assert.throws(() => f.plan(f.alice, story, approval, { dueAt: '2026-10-22T24:00:00Z' }), code('INVALID_DATE'));
  const plan = f.plan(f.alice, story, approval, { dueAt: '2026-10-22T18:30:00+05:30' });
  assert.equal(plan.dueAt, '2026-10-22T13:00:00.000Z');
});
