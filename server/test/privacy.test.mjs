import test from 'node:test';
import assert from 'node:assert/strict';
import { StoryBankRepository, createContextAuthority } from '../index.mjs';

const code = (expected) => (error) => error.code === expected;

function fixture() {
  let counter = 0;
  let now = Date.parse('2026-10-22T12:00:00Z');
  const sessions = new Map([
    ['alice-session', { subject: 'alice', memberships: [{ tenantId: 'alpha', role: 'owner' }, { tenantId: 'beta', role: 'editor' }] }],
    ['cara-session', { subject: 'cara', memberships: [{ tenantId: 'alpha', role: 'editor' }] }],
    ['owner-session', { subject: 'other-owner', memberships: [{ tenantId: 'alpha', role: 'owner' }] }],
    ['viewer-session', { subject: 'viewer', memberships: [{ tenantId: 'alpha', role: 'viewer' }] }],
  ]);
  const authority = createContextAuthority({ resolveSession: (session) => sessions.get(session) });
  const repo = new StoryBankRepository({ authority, clock: () => new Date(now), id: () => `privacy-${++counter}` });
  const alice = authority.authenticate('alice-session', 'alpha');
  const aliceBeta = authority.authenticate('alice-session', 'beta');
  const cara = authority.authenticate('cara-session', 'alpha');
  const otherOwner = authority.authenticate('owner-session', 'alpha');
  const viewer = authority.authenticate('viewer-session', 'alpha');
  const plan = (context, story, approval, idempotencyKey) => repo.schedulePlan(context, {
    storyId: story.id, approvalId: approval.record.id, dueAt: '2026-10-22T13:00:00Z', idempotencyKey,
  });
  const seed = (context, marker) => {
    let story = repo.createStory(context, { title: `${marker} title`, text: `${marker} original body`, source: `${marker} source`, mediaIds: [`${marker}-audio-reference`, `${marker}-image-reference`] });
    const firstApproval = repo.approveStory(context, story.id, { expectedRevision: 1 });
    const firstJob = plan(context, story, firstApproval, 'shared-request-key');
    story = repo.updateStory(context, story.id, { text: `${marker} revised body` }, { expectedRevision: 1 });
    const approval = repo.approveStory(context, story.id, { expectedRevision: 2 });
    const job = plan(context, story, approval, 'shared-second-key');
    repo.saveWritingProfile(context, { displayName: `${marker} writer`, voice: `${marker} voice`, creators: [{ name: `${marker} creator`, notes: `${marker} creator notes` }] }, { expectedVersion: 0 });
    const calibration = repo.createCalibration(context, { topic: `${marker} topic`, facts: [`${marker} private fact`] });
    repo.addCalibrationFeedback(context, calibration.id, { variantId: calibration.variants[0].id, feedback: `${marker} feedback`, editedText: `${marker} edited example` });
    const appliedProposal = repo.proposeWritingRevision(context, calibration.id);
    repo.applyWritingRevision(context, appliedProposal.id, { expectedVersion: 1 });
    repo.saveWritingProfile(context, { voice: `${marker} newer voice` }, { expectedVersion: 2 });
    repo.addCalibrationFeedback(context, calibration.id, { variantId: calibration.variants[1].id, dislikes: [`${marker} dislike`] });
    const pendingProposal = repo.proposeWritingRevision(context, calibration.id);
    // A prior per-story deletion leaves only cancelled planning metadata. The
    // full personal deletion must also erase these no-longer-linked records.
    const deletedStory = repo.createStory(context, { text: `${marker} prior deleted body` });
    const deletedApproval = repo.approveStory(context, deletedStory.id, { expectedRevision: 1 });
    const leftoverJob = plan(context, deletedStory, deletedApproval, 'shared-deleted-key');
    repo.deleteStory(context, deletedStory.id);
    return { story, firstApproval, approval, firstJob, job, calibration, appliedProposal, pendingProposal, deletedStory, leftoverJob };
  };
  return { repo, authority, sessions, alice, aliceBeta, cara, otherOwner, viewer, seed, plan, advance: () => { now += 7_200_000; } };
}

function seedOthers(f) {
  return { alice: f.seed(f.alice, 'ALICE_PRIVATE'), cara: f.seed(f.cara, 'CARA_PRIVATE'), beta: f.seed(f.aliceBeta, 'BETA_PRIVATE') };
}

test('same-workspace members and workspace owners cannot read or mutate another writer’s personal records', () => {
  const f = fixture();
  const item = f.seed(f.cara, 'CARA_PRIVATE');
  for (const intruder of [f.alice, f.otherOwner, f.aliceBeta]) {
    for (const operation of [
      () => f.repo.getStory(intruder, item.story.id),
      () => f.repo.updateStory(intruder, item.story.id, { text: 'intrusion' }, { expectedRevision: 2 }),
      () => f.repo.approveStory(intruder, item.story.id, { expectedRevision: 2 }),
      () => f.repo.getApproval(intruder, item.approval.record.id),
      () => f.repo.revokeApproval(intruder, item.story.id),
      () => f.repo.getJob(intruder, item.job.id),
      () => f.repo.cancelJob(intruder, item.job.id),
      () => f.plan(intruder, item.story, item.approval, 'intruder-request'),
      () => f.repo.deleteStory(intruder, item.story.id),
      () => f.repo.publishNow(intruder, item.story.id, item.approval.record.id),
      () => f.repo.getCalibration(intruder, item.calibration.id),
      () => f.repo.getWritingRevision(intruder, item.pendingProposal.id),
    ]) assert.throws(operation, code('NOT_FOUND'));
    assert.deepEqual(f.repo.listStories(intruder), []);
    assert.deepEqual(f.repo.listJobs(intruder), []);
    assert.deepEqual(f.repo.listAudit(intruder), []);
  }
  assert.equal(f.repo.getStory(f.cara, item.story.id).text, 'CARA_PRIVATE revised body');
});

test('idempotency keys and due processing are isolated between writers in the same workspace', () => {
  const f = fixture();
  const seeded = seedOthers(f);
  assert.notEqual(seeded.alice.job.id, seeded.cara.job.id);
  assert.equal(f.plan(f.alice, seeded.alice.story, seeded.alice.approval, 'shared-second-key').id, seeded.alice.job.id);
  assert.equal(f.plan(f.cara, seeded.cara.story, seeded.cara.approval, 'shared-second-key').id, seeded.cara.job.id);
  f.advance();
  assert.deepEqual(f.repo.runDuePlans(f.alice).map((job) => job.id), [seeded.alice.job.id]);
  assert.equal(f.repo.getJob(f.cara, seeded.cara.job.id).status, 'planned');
  assert.equal(f.repo.getJob(f.aliceBeta, seeded.beta.job.id).status, 'planned');
});

test('personal export includes content and derived history, and never mixes owners or workspaces', () => {
  const f = fixture();
  const seeded = seedOthers(f);
  const exported = f.repo.exportOwnData(f.alice);
  assert.equal(exported.scope, 'authenticated_user_in_workspace');
  assert.equal(exported.tenantId, 'alpha');
  assert.equal(exported.userId, 'alice');
  assert.equal(exported.data.stories.length, 1);
  assert.equal(exported.data.approvals.length, 2);
  assert.equal(exported.data.jobs.length, 3);
  assert.equal(exported.data.idempotencyReservations.length, 3);
  assert.equal(exported.data.writingProfileVersions.length, 3);
  assert.equal(exported.data.calibrations.length, 1);
  assert.equal(exported.data.calibrations[0].feedback.length, 2);
  assert.equal(exported.data.writingRevisionProposals.length, 2);
  assert.equal(exported.data.mediaReferences.length, 2);
  assert.equal(exported.data.jobs.find((job) => job.id === seeded.alice.leftoverJob.id).status, 'cancelled');
  assert.ok(exported.data.auditEvents.every((event) => event.tenantId === 'alpha' && event.userId === 'alice'));
  const serialized = JSON.stringify(exported);
  for (const secret of ['ALICE_PRIVATE original body', 'ALICE_PRIVATE revised body', 'ALICE_PRIVATE voice', 'ALICE_PRIVATE feedback', 'ALICE_PRIVATE edited example']) assert.ok(serialized.includes(secret));
  for (const secret of ['CARA_PRIVATE', 'BETA_PRIVATE']) assert.ok(!serialized.includes(secret));
  assert.equal('audioMetadata' in exported.data, false);
  assert.match(exported.limitations.audioObjects, /repository alone has no audio object model/);
  assert.match(exported.limitations.backups, /not cryptographic erasure/);
});

test('export returns detached copies of every nested personal record', () => {
  const f = fixture();
  const item = f.seed(f.alice, 'ALICE_PRIVATE');
  const exported = f.repo.exportOwnData(f.alice);
  exported.data.stories[0].text = 'changed';
  exported.data.approvals[0].record.snapshot.text = 'changed';
  exported.data.writingProfileVersions[0].preferences.voice = 'changed';
  exported.data.calibrations[0].facts[0] = 'changed';
  exported.data.calibrations[0].feedback[0].feedback = 'changed';
  exported.data.writingRevisionProposals[0].preferences.feedbackGuidance = 'changed';
  exported.data.idempotencyReservations[0].jobId = 'changed';
  const fresh = f.repo.exportOwnData(f.alice);
  assert.ok(!JSON.stringify(fresh).includes('"changed"'));
  assert.equal(f.plan(f.alice, item.story, item.approval, 'shared-second-key').id, item.job.id);
});

test('export and privacy deletion reject client-supplied identity selectors and forged contexts', () => {
  const f = fixture();
  f.seed(f.cara, 'CARA_PRIVATE');
  for (const method of ['exportOwnData', 'deleteOwnData']) {
    assert.throws(() => f.repo[method]({ tenantId: 'alpha', userId: 'cara', role: 'owner' }), code('UNAUTHENTICATED'));
    assert.throws(() => f.repo[method]({ ...f.alice }), code('UNAUTHENTICATED'));
    for (const options of [{ userId: 'cara' }, { tenantId: 'beta' }, { all: true }, { owner: 'cara' }, null, [], 'cara']) {
      assert.throws(() => f.repo[method](f.alice, options), code('INVALID_PRIVACY_SELECTION'));
    }
  }
  assert.equal(f.repo.listStories(f.cara).length, 1);
  assert.deepEqual(f.repo.exportOwnData(f.viewer).data.stories, []);
  assert.throws(() => f.repo.deleteOwnData(f.viewer), code('FORBIDDEN'));
  f.sessions.delete('alice-session');
  assert.throws(() => f.repo.exportOwnData(f.alice), code('UNAUTHENTICATED'));
  assert.throws(() => f.repo.deleteOwnData(f.alice), code('UNAUTHENTICATED'));
});

test('full personal deletion removes live content, versions, feedback, proposals, plans and reservations only for its owner', () => {
  const f = fixture();
  const seeded = seedOthers(f);
  const caraBefore = f.repo.exportOwnData(f.cara);
  const betaBefore = f.repo.exportOwnData(f.aliceBeta);
  const before = f.repo.exportOwnData(f.alice);
  const result = f.repo.deleteOwnData(f.alice);
  assert.equal(result.storageScope, 'live_repository_records');
  assert.deepEqual(result.counts, {
    stories: 1, approvals: 2, jobs: 3, idempotencyReservations: 3, approvalJobReservations: 3,
    writingProfileVersions: 3, calibrations: 1, feedbackEntries: 2, writingRevisionProposals: 2,
    mediaReferences: 2, auditEvents: before.data.auditEvents.length,
  });
  assert.deepEqual(f.repo.exportOwnData(f.cara), caraBefore);
  assert.deepEqual(f.repo.exportOwnData(f.aliceBeta), betaBefore);
  assert.equal(f.repo.integrationStatus(f.alice).status, 'disabled');
  for (const operation of [
    () => f.repo.getStory(f.alice, seeded.alice.story.id),
    () => f.repo.getApproval(f.alice, seeded.alice.approval.record.id),
    () => f.repo.getApproval(f.alice, seeded.alice.firstApproval.record.id),
    () => f.repo.getJob(f.alice, seeded.alice.job.id),
    () => f.repo.getJob(f.alice, seeded.alice.leftoverJob.id),
    () => f.repo.getWritingProfile(f.alice, { version: 1 }),
    () => f.repo.getWritingProfile(f.alice, { version: 3 }),
    () => f.repo.getCalibration(f.alice, seeded.alice.calibration.id),
    () => f.repo.getWritingRevision(f.alice, seeded.alice.appliedProposal.id),
    () => f.repo.getWritingRevision(f.alice, seeded.alice.pendingProposal.id),
    () => f.repo.applyWritingRevision(f.alice, seeded.alice.appliedProposal.id, { expectedVersion: 0 }),
  ]) assert.throws(operation, code('NOT_FOUND'));
  const after = f.repo.exportOwnData(f.alice);
  for (const [field, records] of Object.entries(after.data)) {
    if (field !== 'auditEvents') assert.deepEqual(records, [], field);
  }
  assert.equal(after.data.auditEvents.length, 1);
  assert.equal(after.data.auditEvents[0].type, 'privacy.deleted');
  assert.ok(!JSON.stringify(after).includes('ALICE_PRIVATE'));
  assert.match(result.limitations.accountAndSessions, /not account or workspace deletion/);
  assert.match(result.limitations.externalCopies, /outside repository deletion control/);
  f.advance();
  assert.deepEqual(f.repo.runDuePlans(f.alice), []);
  assert.equal(f.repo.getJob(f.cara, seeded.cara.job.id).status, 'planned');
});

test('privacy deletion is safe to repeat and removes idempotency reservations without disturbing another writer', () => {
  const f = fixture();
  seedOthers(f);
  f.repo.deleteOwnData(f.alice);
  const again = f.repo.deleteOwnData(f.alice);
  for (const [field, count] of Object.entries(again.counts)) assert.equal(count, field === 'auditEvents' ? 1 : 0, field);
  const recreated = f.seed(f.alice, 'FRESH_PRIVATE');
  assert.equal(f.repo.getJob(f.alice, recreated.job.id).status, 'planned');
  assert.equal(f.repo.getWritingProfile(f.alice).version, 3);
  assert.equal(f.repo.exportOwnData(f.cara).data.idempotencyReservations.length, 3);
});

test('workspace-wide integration revocation invalidates plans without granting access to other owners’ content or audit', () => {
  const f = fixture();
  const item = f.seed(f.cara, 'CARA_PRIVATE');
  f.repo.revokeIntegration(f.alice);
  assert.equal(f.repo.getJob(f.cara, item.job.id).status, 'cancelled');
  assert.equal(f.repo.getApproval(f.cara, item.approval.record.id).revocationReason, 'integration_revoked');
  assert.deepEqual(f.repo.listStories(f.alice), []);
  assert.deepEqual(f.repo.listJobs(f.alice), []);
  const ownerAudit = f.repo.listAudit(f.alice);
  assert.deepEqual(ownerAudit.map((event) => event.type), ['integration.revoked']);
  for (const hiddenId of [item.story.id, item.approval.record.id, item.job.id]) assert.ok(!JSON.stringify(ownerAudit).includes(hiddenId));
  const subjectAudit = f.repo.listAudit(f.cara);
  assert.ok(subjectAudit.some((event) => event.type === 'job.cancelled' && event.actorUserId === 'alice'));
  assert.ok(subjectAudit.every((event) => event.userId === 'cara'));
  // Deleting one's private records must not silently reconnect the workspace.
  f.repo.deleteOwnData(f.alice);
  assert.equal(f.repo.integrationStatus(f.cara).status, 'revoked');
});

test('audit and deletion receipts contain metadata only, never content or reusable request keys', () => {
  const f = fixture();
  f.seed(f.alice, 'CONTENT_CANARY');
  const auditBefore = JSON.stringify(f.repo.listAudit(f.alice));
  assert.ok(!auditBefore.includes('CONTENT_CANARY'));
  assert.ok(!auditBefore.includes('shared-request-key'));
  assert.ok(!auditBefore.includes('shared-second-key'));
  assert.ok(!auditBefore.includes('shared-deleted-key'));
  f.repo.deleteOwnData(f.alice);
  const auditAfter = f.repo.listAudit(f.alice);
  assert.equal(auditAfter.length, 1);
  assert.deepEqual(Object.keys(auditAfter[0]).sort(), ['actorUserId', 'at', 'counts', 'entityId', 'id', 'tenantId', 'type', 'userId']);
  assert.ok(!JSON.stringify(auditAfter).includes('CONTENT_CANARY'));
});
