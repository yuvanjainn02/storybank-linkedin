import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createContextAuthority } from '../server/context.mjs';
import { createD1StoryBank, personalWorkspaceId, STORYBANK_D1_SCHEMA_SQL, STORYBANK_D1_METHODS, STORYBANK_D1_PAYLOAD_LIMIT } from '../server/hosted-d1.mjs';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const FUTURE = '2026-10-22T13:00:00.000Z';
const code = (expected) => (error) => error.code === expected;

/**
 * Local contract fake, NOT live D1 or a Workers runtime. Real SQLite executes
 * the parameterized SQL and CAS; asynchronous hooks expose interleavings that
 * a synchronous in-memory map fake would hide. Public facade matches only the
 * D1 methods the adapter actually uses: withSession/prepare/bind/first/run.
 */
class AsyncSQLiteD1 {
  constructor(filename) { this.sqlite = new DatabaseSync(filename); this.calls = []; this.sessions = []; }
  withSession(constraint) {
    assert.equal(constraint, 'first-primary');
    this.sessions.push(constraint);
    return { prepare: (sql) => this.prepare(sql) };
  }
  prepare(sql) {
    assert.ok(!/\bBEGIN\b|\bCOMMIT\b|\bCREATE\b|\bDELETE\b/i.test(sql), 'Runtime adapter must not run schema DDL or transaction control');
    return { bind: (...bindings) => ({
      first: async () => {
        this.calls.push({ type: 'read', sql, bindings });
        const found = this.sqlite.prepare(sql).get(...bindings);
        const row = found ? { ...found } : null;
        await this.afterRead?.(row);
        return row;
      },
      run: async () => {
        this.calls.push({ type: 'write', sql, bindings });
        await this.beforeWrite?.({ sql, bindings });
        const outcome = this.sqlite.prepare(sql).run(...bindings);
        const result = { success: true, meta: { changes: Number(outcome.changes), last_row_id: Number(outcome.lastInsertRowid) }, results: [] };
        await this.afterWrite?.(result);
        return this.mapResult ? this.mapResult(result) : result;
      },
    }) };
  }
  close() { this.sqlite.close(); }
}
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'storybank-d1-contract-'));
  const filename = join(directory, 'state.sqlite');
  const setup = new DatabaseSync(filename);
  setup.exec(STORYBANK_D1_SCHEMA_SQL);
  setup.close();
  const principals = new Map(['alice', 'bob', 'mallory', "x'); DROP TABLE storybank_personal_workspaces; --"].map((userId) => [userId, { subject: userId, memberships: [{ tenantId: personalWorkspaceId(userId), role: 'owner' }] }]));
  const authority = createContextAuthority({ resolveSession: (session) => principals.get(session) });
  const contexts = Object.fromEntries(['alice', 'bob', 'mallory'].map((id) => [id, authority.authenticate(id, personalWorkspaceId(id))]));
  const handles = [];
  function open(options = {}) {
    const db = new AsyncSQLiteD1(filename);
    handles.push(db);
    const app = createD1StoryBank({ db, authority, clock: () => new Date(NOW), ...options });
    const invoke = (method, ...args) => app.invoke(contexts.alice, method, args);
    return { db, app, invoke, close() { if (handles.includes(db)) { handles.splice(handles.indexOf(db), 1); db.close(); } } };
  }
  function raw(user = 'alice') {
    const db = new DatabaseSync(filename);
    try { return { ...db.prepare('SELECT * FROM storybank_personal_workspaces WHERE tenant_id = ? AND owner_user_id = ?').get(personalWorkspaceId(user), user) }; }
    finally { db.close(); }
  }
  function tamper(change, user = 'alice') {
    const db = new DatabaseSync(filename);
    try {
      const row = raw(user);
      const envelope = JSON.parse(row.payload);
      const replacement = change(envelope);
      db.prepare('UPDATE storybank_personal_workspaces SET payload = ? WHERE tenant_id = ? AND owner_user_id = ?').run(replacement === undefined ? JSON.stringify(envelope) : replacement, personalWorkspaceId(user), user);
    } finally { db.close(); }
  }
  t.after(() => { for (const db of handles) db.close(); rmSync(directory, { recursive: true, force: true }); });
  return { filename, directory, authority, principals, ...contexts, open, raw, tamper };
}
async function seed(invoke, label = 'Synthetic writer') {
  const profile = await invoke('saveWritingProfile', { displayName: label, voice: 'Brief and factual', creators: [{ name: 'Synthetic creator', notes: 'User supplied fixture, not research' }] }, { expectedVersion: 0 });
  const story = await invoke('createStory', { title: label, text: `${label}: synthetic story`, mediaIds: ['synthetic-media'] });
  const approval = await invoke('approveStory', story.id, { expectedRevision: 1 });
  const planRequest = { storyId: story.id, approvalId: approval.record.id, dueAt: FUTURE, idempotencyKey: 'fixture-request' };
  const job = await invoke('schedulePlan', planRequest);
  const calibration = await invoke('createCalibration', { topic: label, facts: ['A synthetic observation.'], count: 3 });
  await invoke('addCalibrationFeedback', calibration.id, { variantId: calibration.variants[0].id, likes: ['brevity'] });
  const proposal = await invoke('proposeWritingRevision', calibration.id);
  const applied = await invoke('applyWritingRevision', proposal.id, { expectedVersion: profile.version });
  return { profile, story, approval, planRequest, job, calibration, proposal, applied };
}
function twoReadBarrier(dbA, dbB) {
  let arrivals = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const hook = async () => { if (++arrivals === 2) release(); if (arrivals <= 2) await gate; };
  dbA.afterRead = hook;
  dbB.afterRead = hook;
}

test('D1-shaped local adapter persists complete private aggregates across close/reopen', async (t) => {
  const f = fixture(t);
  let h = f.open();
  const s = await seed(h.invoke);
  const before = await h.invoke('exportOwnData');
  h.close();
  h = f.open();
  assert.deepEqual(await h.invoke('exportOwnData'), before);
  assert.deepEqual(await h.invoke('schedulePlan', s.planRequest), s.job);
  assert.equal((await h.invoke('applyWritingRevision', s.proposal.id, { expectedVersion: 1 })).version, 2);
  assert.match((await h.invoke('exportWritingSkill')).content, /Synthetic writer/);
  assert.deepEqual(Object.keys(h.app), ['invoke']);
  assert.ok(h.db.sessions.length > 0);
  assert.equal((await h.invoke('getJob', s.job.id)).publishAttempts, 0);
  assert.match(before.limitations.backups, /hosted/);
});

test('new empty workspace reads perform no writes; only explicit allowlisted operations run', async (t) => {
  const f = fixture(t);
  const h = f.open();
  assert.deepEqual(await h.invoke('listStories'), []);
  assert.deepEqual(await h.invoke('listAudit'), []);
  assert.equal(h.db.calls.filter((c) => c.type === 'write').length, 0);
  assert.equal(f.raw().revision, undefined);
  for (const method of ['constructor', '__proto__', 'toString', 'publishNow', 'transact', 'state', 'db', 'createRepository']) await assert.rejects(h.invoke(method), code('METHOD_NOT_ALLOWED'));
  assert.ok(!STORYBANK_D1_METHODS.includes('publishNow'));
  assert.ok(!readFileSync(new URL('../server/hosted-d1.mjs', import.meta.url), 'utf8').includes("from 'node:sqlite'"));
});

test('first-insert CAS race preserves both independent requests with no lost stories or audit entries', async (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  twoReadBarrier(a.db, b.db);
  const results = await Promise.all([a.invoke('createStory', { text: 'First concurrent story' }), b.invoke('createStory', { text: 'Second concurrent story' })]);
  const stories = await a.invoke('listStories');
  assert.equal(stories.length, 2);
  assert.deepEqual(new Set(stories.map((s) => s.id)), new Set(results.map((s) => s.id)));
  assert.equal((await a.invoke('listAudit')).length, 2);
  assert.equal(f.raw().revision, 2);
  assert.equal(a.db.calls.concat(b.db.calls).filter((c) => c.type === 'write').length, 3, 'one CAS miss was retried');
});

test('existing-row CAS race reruns stale story revisions rather than overwriting another edit', async (t) => {
  const f = fixture(t);
  const a = f.open();
  const story = await a.invoke('createStory', { text: 'Before' });
  const b = f.open();
  twoReadBarrier(a.db, b.db);
  const results = await Promise.allSettled([a.invoke('updateStory', story.id, { text: 'First edit' }, { expectedRevision: 1 }), b.invoke('updateStory', story.id, { text: 'Second edit' }, { expectedRevision: 1 })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  assert.equal((await a.invoke('getStory', story.id)).revision, 2);
  assert.equal((await a.invoke('listAudit')).filter((e) => e.type === 'story.updated').length, 1);
});

test('profile race preserves only the winning current version; stale proposal and feedback are rejected', async (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  twoReadBarrier(a.db, b.db);
  const results = await Promise.allSettled([a.invoke('saveWritingProfile', { voice: 'A' }, { expectedVersion: 0 }), b.invoke('saveWritingProfile', { voice: 'B' }, { expectedVersion: 0 })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  const c = await a.invoke('createCalibration', { topic: 'Synthetic', facts: ['Synthetic fact'] });
  await a.invoke('addCalibrationFeedback', c.id, { variantId: c.variants[0].id, likes: ['short paragraphs'] });
  const p = await a.invoke('proposeWritingRevision', c.id);
  await b.invoke('addCalibrationFeedback', c.id, { variantId: c.variants[1].id, dislikes: ['long paragraphs'] });
  await assert.rejects(a.invoke('applyWritingRevision', p.id, { expectedVersion: 1 }), code('FEEDBACK_CHANGED'));
  const fresh = await a.invoke('proposeWritingRevision', c.id);
  await b.invoke('saveWritingProfile', { voice: 'Changed' }, { expectedVersion: 1 });
  await assert.rejects(a.invoke('applyWritingRevision', fresh.id, { expectedVersion: 1 }), code('VERSION_CONFLICT'));
  assert.equal((await a.invoke('getWritingRevision', fresh.id)).status, 'proposed');
});

test('CAS retry rechecks feedback that changes while a revision application is in flight', async (t) => {
  const f = fixture(t);
  const a = f.open();
  const b = f.open();
  const c = await a.invoke('createCalibration', { topic: 'Synthetic', facts: ['A fact'] });
  await a.invoke('addCalibrationFeedback', c.id, { variantId: c.variants[0].id, likes: ['brief'] });
  const p = await a.invoke('proposeWritingRevision', c.id);
  let intercepted = false;
  a.db.beforeWrite = async () => {
    if (intercepted) return;
    intercepted = true;
    await b.invoke('addCalibrationFeedback', c.id, { variantId: c.variants[1].id, dislikes: ['generic'] });
  };
  await assert.rejects(a.invoke('applyWritingRevision', p.id, { expectedVersion: 0 }), code('FEEDBACK_CHANGED'));
  assert.deepEqual(await a.invoke('listWritingProfileVersions'), []);
  assert.equal((await a.invoke('getWritingRevision', p.id)).status, 'proposed');
});

test('domain exceptions after mutation and nested application leave stored payload and audit untouched', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const failed = f.open({ id: () => { if (++calls === 2) throw new Error('Injected audit failure'); return randomUUID(); } });
  await assert.rejects(failed.invoke('createStory', { text: 'Never committed' }), /Injected audit failure/);
  assert.equal(f.raw().revision, undefined);
  const h = f.open();
  await h.invoke('saveWritingProfile', { voice: 'Initial' }, { expectedVersion: 0 });
  const c = await h.invoke('createCalibration', { topic: 'Synthetic', facts: ['A fact'] });
  await h.invoke('addCalibrationFeedback', c.id, { variantId: c.variants[0].id, likes: ['brief'] });
  const p = await h.invoke('proposeWritingRevision', c.id);
  const before = f.raw();
  calls = 0;
  await assert.rejects(failed.invoke('applyWritingRevision', p.id, { expectedVersion: 1 }), /Injected audit failure/);
  assert.deepEqual(f.raw(), before);
  assert.equal((await h.invoke('getWritingProfile')).version, 1);
  assert.equal((await h.invoke('getWritingRevision', p.id)).status, 'proposed');
});

test('known CAS contention retries are bounded and never return an uncommitted result', async (t) => {
  const f = fixture(t);
  const h = f.open({ maxAttempts: 3 });
  await h.invoke('createStory', { text: 'Committed first' });
  const before = await h.invoke('exportOwnData');
  const writesBefore = h.db.calls.filter((c) => c.type === 'write').length;
  h.db.beforeWrite = async () => { h.db.sqlite.prepare('UPDATE storybank_personal_workspaces SET revision = revision + 1').run(); };
  await assert.rejects(h.invoke('createStory', { text: 'Must not commit' }), code('STORAGE_CONFLICT'));
  assert.equal(h.db.calls.filter((c) => c.type === 'write').length - writesBefore, 3);
  assert.deepEqual(await h.invoke('exportOwnData'), before);
});

test('unknown commit outcomes and malformed success responses are never automatically retried', async (t) => {
  const f = fixture(t);
  const h = f.open();
  h.db.afterWrite = async () => { throw new Error('Simulated transport loss after commit'); };
  await assert.rejects(h.invoke('createStory', { text: 'May have committed' }), code('STORAGE_OUTCOME_UNKNOWN'));
  assert.equal(h.db.calls.filter((c) => c.type === 'write').length, 1);
  assert.equal((await h.invoke('listStories')).length, 1, 'test proves commit occurred even though caller saw an unknown outcome');
  h.db.afterWrite = undefined;
  h.db.mapResult = () => ({ success: true, meta: {} });
  await assert.rejects(h.invoke('createStory', { text: 'Another unknown outcome' }), code('STORAGE_OUTCOME_UNKNOWN'));
  assert.equal(h.db.calls.filter((c) => c.type === 'write').length, 2);
  assert.equal((await h.invoke('listStories')).length, 2);
});

test('failed SQL atomic write leaves the previous payload intact and reports uncertainty without retry', async (t) => {
  const f = fixture(t);
  const h = f.open();
  await h.invoke('createStory', { text: 'Existing' });
  const before = f.raw();
  h.db.sqlite.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON storybank_personal_workspaces BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;");
  await assert.rejects(h.invoke('createStory', { text: 'Not written' }), code('STORAGE_OUTCOME_UNKNOWN'));
  assert.deepEqual(f.raw(), before);
  assert.equal(h.db.calls.filter((c) => c.type === 'write').length, 2);
});

test('forged contexts and client owner selectors cannot authenticate or cross personal workspaces', async (t) => {
  const f = fixture(t);
  const h = f.open();
  const s = await seed(h.invoke, 'Alice private');
  const invokeBob = (method, ...args) => h.app.invoke(f.bob, method, args);
  await seed(invokeBob, 'Bob private');
  assert.equal((await invokeBob('listStories')).length, 1);
  await assert.rejects(invokeBob('getStory', s.story.id), code('NOT_FOUND'));
  await assert.rejects(invokeBob('getApproval', s.approval.record.id), code('NOT_FOUND'));
  await assert.rejects(invokeBob('getCalibration', s.calibration.id), code('NOT_FOUND'));
  await assert.rejects(invokeBob('getWritingRevision', s.proposal.id), code('NOT_FOUND'));
  await assert.rejects(h.app.invoke({ ...f.alice }, 'listStories'), code('UNAUTHENTICATED'));
  await assert.rejects(h.app.invoke({ tenantId: personalWorkspaceId('alice'), userId: 'alice' }, 'listStories'), code('UNAUTHENTICATED'));
  await assert.rejects(h.invoke('exportOwnData', { userId: 'bob' }), code('INVALID_PRIVACY_SELECTION'));
  await assert.rejects(h.invoke('getWritingProfile', { userId: 'bob' }), code('INVALID_PROFILE_SELECTION'));
  await assert.rejects(h.invoke('createStory', { text: 'X', createdBy: 'bob' }), code('INVALID_FIELD'));
  await assert.rejects(h.invoke('saveWritingProfile', { userId: 'bob' }, { expectedVersion: 2 }), code('INVALID_PROFILE'));
  assert.ok(!JSON.stringify(await h.invoke('exportOwnData')).includes('Bob private'));
});

test('global integration revocation is only personal, never another owner workspace', async (t) => {
  const f = fixture(t);
  const h = f.open();
  const a = await seed(h.invoke, 'Alice private');
  const bob = (method, ...args) => h.app.invoke(f.bob, method, args);
  const b = await seed(bob, 'Bob private');
  await h.invoke('revokeIntegration');
  assert.equal((await h.invoke('getJob', a.job.id)).status, 'cancelled');
  assert.equal((await bob('getJob', b.job.id)).status, 'planned');
  assert.equal((await h.invoke('integrationStatus')).status, 'revoked');
  assert.equal((await bob('integrationStatus')).status, 'disabled');
  const otherTenantAuthority = { require: () => ({ userId: 'alice', tenantId: 'team-workspace', role: 'owner' }) };
  const other = createD1StoryBank({ db: h.db, authority: otherTenantAuthority });
  await assert.rejects(other.invoke({}, 'revokeIntegration'), code('FORBIDDEN'));
});

test('read-only contexts cannot mutate and auth loss during the awaited read prevents commit', async (t) => {
  const f = fixture(t);
  const h = f.open();
  const readOnly = f.authority.authenticate('alice', personalWorkspaceId('alice'), { readOnly: true });
  await assert.rejects(h.app.invoke(readOnly, 'createStory', [{ text: 'Forbidden' }]), code('READ_ONLY_REQUEST'));
  assert.deepEqual(await h.app.invoke(readOnly, 'listStories'), []);
  h.db.afterRead = async () => { f.principals.delete('alice'); };
  await assert.rejects(h.invoke('createStory', { text: 'Session expired during read' }), code('UNAUTHENTICATED'));
  assert.equal(h.db.calls.filter((c) => c.type === 'write').length, 0);
});

test('delete own data persists a content-free receipt without affecting another owner', async (t) => {
  const f = fixture(t);
  let h = f.open();
  await seed(h.invoke, 'Alice secret fixture');
  const bob = (method, ...args) => h.app.invoke(f.bob, method, args);
  await seed(bob, 'Bob private');
  const bobBefore = f.raw('bob');
  const result = await h.invoke('deleteOwnData');
  assert.equal(result.counts.writingProfileVersions, 2);
  assert.equal(result.counts.feedbackEntries, 1);
  assert.match(result.limitations.backups, /not erased/);
  h.close();
  h = f.open();
  const after = await h.invoke('exportOwnData');
  for (const [name, entries] of Object.entries(after.data)) assert.equal(entries.length, name === 'auditEvents' ? 1 : 0, name);
  assert.equal(after.data.auditEvents[0].type, 'privacy.deleted');
  assert.ok(!f.raw().payload.includes('Alice secret fixture'));
  assert.deepEqual(f.raw('bob'), bobBefore);
});

test('deletion with receipt failure rolls back and story-only deletion retains valid plan history', async (t) => {
  const f = fixture(t);
  const h = f.open();
  const s = await seed(h.invoke);
  const before = f.raw();
  const faulty = f.open({ clock: () => { throw new Error('Receipt failed'); } });
  await assert.rejects(faulty.invoke('deleteOwnData'), /Receipt failed/);
  assert.deepEqual(f.raw(), before);
  assert.equal((await h.invoke('deleteStory', s.story.id)).scope, 'live_hosted_database');
  await assert.rejects(h.invoke('getApproval', s.approval.record.id), code('NOT_FOUND'));
  assert.equal((await h.invoke('getJob', s.job.id)).status, 'cancelled');
  assert.equal((await h.invoke('deleteCalibration', s.calibration.id)).scope, 'own_calibration_live_hosted_database');
  assert.equal((await h.invoke('deleteWritingProfile')).scope, 'own_profile_live_hosted_database');
  assert.deepEqual(await h.invoke('listWritingProfileVersions'), []);
});

const mutations = {
  'invalid envelope': () => 'null',
  'unknown envelope fields': (p) => { p.unrecognized = true; },
  'future schema': (p) => { p.schemaVersion = 999; },
  'foreign envelope owner': (p) => { p.ownerUserId = 'bob'; },
  'foreign envelope tenant': (p) => { p.tenantId = personalWorkspaceId('bob'); },
  'unknown collection': (p) => { p.collections.foreign = []; },
  'duplicate map key': (p) => { p.collections.stories.push(p.collections.stories[0]); },
  'invalid map shape': (p) => { p.collections.stories = {}; },
  'noncanonical key': (p) => { p.collections.stories[0][0] = '["bad"]'; },
  'foreign story owner': (p) => { p.collections.stories[0][1].createdBy = 'bob'; },
  'foreign approval owner': (p) => { p.collections.approvals[0][1].record.approvedBy = 'bob'; },
  'changed approval snapshot': (p) => { p.collections.approvals[0][1].record.snapshot.text = 'Tampered'; },
  'foreign approval revoker': (p) => { Object.assign(p.collections.approvals[0][1], { revokedAt: new Date(NOW).toISOString(), revokedBy: 'bob', revocationReason: 'approval_revoked' }); },
  'foreign job owner': (p) => { p.collections.jobs[0][1].createdBy = 'bob'; },
  'foreign idempotency owner': (p) => { p.collections.idempotency[0][1].userId = 'bob'; },
  'foreign approval-job key': (p) => { p.collections.approvalJobs[0][0] = JSON.stringify([p.tenantId, 'bob', 'unknown']); },
  'foreign integration key': (p) => { p.collections.integrations.push([personalWorkspaceId('bob'), { status: 'revoked', revokedAt: new Date(NOW).toISOString() }]); },
  'foreign profile version': (p) => { p.collections.profiles[0][1][0].userId = 'bob'; },
  'foreign calibration owner': (p) => { p.collections.calibrations[0][1].userId = 'bob'; },
  'foreign nested feedback owner': (p) => { p.collections.calibrations[0][1].feedback[0].userId = 'bob'; },
  'foreign proposal owner': (p) => { p.collections.profileProposals[0][1].userId = 'bob'; },
  'foreign audit actor': (p) => { p.audit[0].actorUserId = 'bob'; },
  'foreign audit subject': (p) => { p.audit[0].userId = 'bob'; },
  'foreign audit tenant': (p) => { p.audit[0].tenantId = personalWorkspaceId('bob'); },
  'private payload smuggled into audit': (p) => { p.audit[0].privateText = 'Must not be exposed'; },
  'invalid feedback shape': (p) => { p.collections.calibrations[0][1].feedback[0].likes = null; },
  'invalid profile preferences': (p) => { p.collections.profiles[0][1][0].preferences.creators[0].userId = 'bob'; },
  'dangling active approval': (p) => { p.collections.stories[0][1].activeApprovalId = 'missing'; },
  'dangling reservation': (p) => { p.collections.idempotency[0][1].jobId = 'missing'; },
  'dangling proposal calibration': (p) => { p.collections.profileProposals[0][1].calibrationId = 'missing'; },
};
for (const [label, change] of Object.entries(mutations)) {
  test(`corrupt aggregate fails closed without a write: ${label}`, async (t) => {
    const f = fixture(t);
    const h = f.open();
    await seed(h.invoke);
    f.tamper(change);
    const before = f.raw();
    const callsBefore = h.db.calls.filter((c) => c.type === 'write').length;
    await assert.rejects(h.invoke('exportOwnData'), code('STORAGE_CORRUPT'));
    await assert.rejects(h.invoke('createStory', { text: 'Do not reset or overwrite corruption' }), code('STORAGE_CORRUPT'));
    assert.deepEqual(f.raw(), before);
    assert.equal(h.db.calls.filter((c) => c.type === 'write').length, callsBefore);
  });
}

test('invalid JSON and invalid revisions are rejected even if database constraints were bypassed', async (t) => {
  const f = fixture(t);
  const h = f.open();
  await h.invoke('createStory', { text: 'Fixture' });
  h.db.sqlite.exec('PRAGMA ignore_check_constraints = ON');
  h.db.sqlite.prepare('UPDATE storybank_personal_workspaces SET payload = ?').run('{invalid json');
  await assert.rejects(h.invoke('listStories'), code('STORAGE_CORRUPT'));
  h.db.sqlite.prepare('UPDATE storybank_personal_workspaces SET revision = 0').run();
  await assert.rejects(h.invoke('listStories'), code('STORAGE_CORRUPT'));
});

test('SQL-looking values are bound literally, including verified user IDs; aggregate cap is atomic', async (t) => {
  const f = fixture(t);
  const h = f.open();
  const userId = "x'); DROP TABLE storybank_personal_workspaces; --";
  const context = f.authority.authenticate(userId, personalWorkspaceId(userId));
  const text = "'); DROP TABLE storybank_personal_workspaces; -- synthetic text";
  const story = await h.app.invoke(context, 'createStory', [{ text }]);
  assert.equal((await h.app.invoke(context, 'getStory', [story.id])).text, text);
  assert.ok(h.db.calls.every((call) => !call.sql.includes(text) && !call.sql.includes(userId)));
  await h.invoke('createStory', { text: 'Original' });
  let capacity = false;
  let lastCommitted;
  for (let i = 0; i < 80; i++) {
    lastCommitted = f.raw();
    try { await h.invoke('createStory', { text: 'X'.repeat(20_000) }); }
    catch (error) { assert.equal(error.code, 'WORKSPACE_CAPACITY'); capacity = true; break; }
  }
  assert.ok(capacity);
  assert.deepEqual(f.raw(), lastCommitted);
  assert.ok(Buffer.byteLength(f.raw().payload) <= STORYBANK_D1_PAYLOAD_LIMIT);
});

test('local plan runner remains blocked, cancellation and reapproval survive persistence', async (t) => {
  const f = fixture(t);
  const h = f.open();
  const s = await seed(h.invoke);
  const later = f.open({ clock: () => new Date('2026-10-22T14:00:00.000Z') });
  const processed = await later.invoke('runDuePlans');
  assert.equal(processed.length, 1);
  assert.equal(processed[0].status, 'blocked');
  assert.equal(processed[0].reason, 'integration_disabled');
  assert.equal(processed[0].publishAttempts, 0);
  await h.invoke('revokeApproval', s.story.id);
  const a = await h.invoke('approveStory', s.story.id, { expectedRevision: 1 });
  const job = await h.invoke('schedulePlan', { ...s.planRequest, approvalId: a.record.id, idempotencyKey: '            ' });
  assert.equal((await h.invoke('cancelJob', job.id)).status, 'cancelled');
  await h.invoke('resetWritingProfile', { expectedVersion: 2 });
  assert.equal((await h.invoke('getWritingProfile')).version, 3);
});
