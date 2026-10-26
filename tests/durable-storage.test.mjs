import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { createContextAuthority } from '../server/context.mjs';
import { createDurableStoryBankRepository, openStoryBankStorage, STORYBANK_SCHEMA_VERSION } from '../server/persistence.mjs';
import migration1 from '../server/migrations/001-domain-state.mjs';

const code = (expected) => (error) => error.code === expected;
const NOW = Date.parse('2026-10-22T12:00:00Z');
const FUTURE = '2026-10-22T13:00:00Z';
const digest = (text) => createHash('sha256').update(text).digest('hex');

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'storybank-durable-'));
  const filename = join(directory, 'fixture.sqlite');
  const handles = [];
  const sessions = new Map([
    ['alice', { subject: 'alice', memberships: [{ tenantId: 'alpha', role: 'owner' }, { tenantId: 'beta', role: 'owner' }] }],
    ['cara', { subject: 'cara', memberships: [{ tenantId: 'alpha', role: 'owner' }] }],
    ['bob', { subject: 'bob', memberships: [{ tenantId: 'beta', role: 'owner' }] }],
    ['viewer', { subject: 'viewer', memberships: [{ tenantId: 'alpha', role: 'viewer' }] }],
  ]);
  const authority = createContextAuthority({ resolveSession: (session) => sessions.get(session) });
  const alice = authority.authenticate('alice', 'alpha');
  const aliceBeta = authority.authenticate('alice', 'beta');
  const cara = authority.authenticate('cara', 'alpha');
  const bob = authority.authenticate('bob', 'beta');
  const viewer = authority.authenticate('viewer', 'alpha');
  const open = (options = {}) => {
    const handle = createDurableStoryBankRepository({ filename, authority, clock: () => new Date(NOW), ...overrides, ...options });
    handles.push(handle);
    return handle;
  };
  t.after(() => {
    for (const handle of handles) handle.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { filename, directory, authority, sessions, alice, aliceBeta, cara, bob, viewer, open };
}

function seed(repo, context, label = 'Synthetic writer') {
  const profile = repo.saveWritingProfile(context, { displayName: label, voice: 'Brief and factual', creators: [{ name: `${label} reference`, notes: 'Only synthetic test notes.' }] }, { expectedVersion: 0 });
  const story = repo.createStory(context, { title: label, text: `${label}: a synthetic story, not real user data.`, mediaIds: [`fixture-${label}`] });
  const approval = repo.approveStory(context, story.id, { expectedRevision: 1 });
  const planRequest = { storyId: story.id, approvalId: approval.record.id, dueAt: FUTURE, idempotencyKey: 'same-owner-request' };
  const job = repo.schedulePlan(context, planRequest);
  const calibration = repo.createCalibration(context, { topic: label, facts: ['A synthetic observation.'], count: 3 });
  repo.addCalibrationFeedback(context, calibration.id, { variantId: calibration.variants[0].id, likes: ['short paragraphs'] });
  const proposal = repo.proposeWritingRevision(context, calibration.id);
  const revision = repo.applyWritingRevision(context, proposal.id, { expectedVersion: profile.version });
  return { profile, story, approval, job, calibration, proposal, revision, planRequest };
}

test('durable aggregate state and approvals, applied revisions, plans, and idempotency survive reopen', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const seeded = seed(handle.repository, f.alice);
  const before = handle.repository.exportOwnData(f.alice);
  handle.close();
  handle = f.open();
  assert.deepEqual(handle.repository.exportOwnData(f.alice), before);
  assert.deepEqual(handle.repository.schedulePlan(f.alice, seeded.planRequest), seeded.job);
  assert.equal(handle.repository.applyWritingRevision(f.alice, seeded.proposal.id, { expectedVersion: 1 }).version, 2);
  assert.match(handle.repository.exportWritingSkill(f.alice).content, /Synthetic writer/);
  assert.throws(() => handle.repository.schedulePlan(f.alice, { ...seeded.planRequest, dueAt: '2026-10-22T14:00:00Z' }), code('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => handle.repository.schedulePlan(f.alice, { ...seeded.planRequest, idempotencyKey: 'another-request' }), code('DUPLICATE_JOB'));
  assert.throws(() => handle.repository.publishNow(f.alice, seeded.story.id, seeded.approval.record.id), code('INTEGRATION_DISABLED'));
  assert.equal(handle.repository.getJob(f.alice, seeded.job.id).publishAttempts, 0);
});

test('separate Node processes read committed durable records after restart', (t) => {
  const f = fixture(t);
  const persistenceUrl = new URL('../server/persistence.mjs', import.meta.url).href;
  const contextUrl = new URL('../server/context.mjs', import.meta.url).href;
  const setup = `import {createDurableStoryBankRepository} from ${JSON.stringify(persistenceUrl)};
    import {createContextAuthority} from ${JSON.stringify(contextUrl)};
    const authority=createContextAuthority({resolveSession:()=>({subject:'process-fixture',memberships:[{tenantId:'process-tenant',role:'owner'}]})});
    const context=authority.authenticate('test-session','process-tenant');
    const handle=createDurableStoryBankRepository({filename:${JSON.stringify(f.filename)},authority});`;
  const write = spawnSync(process.execPath, ['--input-type=module', '-e', `${setup} handle.repository.createStory(context,{text:'Process restart fixture'}); handle.close();`], { encoding: 'utf8' });
  assert.equal(write.status, 0, write.stderr);
  const read = spawnSync(process.execPath, ['--input-type=module', '-e', `${setup} console.log(JSON.stringify(handle.repository.listStories(context))); handle.close();`], { encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.equal(JSON.parse(read.stdout)[0].text, 'Process restart fixture');
});

test('same-tenant writers, tenant owners, foreign tenants, and copied contexts cannot read private durable content', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const seeded = seed(handle.repository, f.alice, 'Alice only');
  handle.close();
  handle = f.open();
  for (const stranger of [f.cara, f.bob, f.aliceBeta, f.viewer]) {
    assert.deepEqual(handle.repository.listStories(stranger), []);
    assert.deepEqual(handle.repository.listJobs(stranger), []);
    assert.deepEqual(handle.repository.listAudit(stranger), []);
    for (const attempt of [
      () => handle.repository.getStory(stranger, seeded.story.id),
      () => handle.repository.getApproval(stranger, seeded.approval.record.id),
      () => handle.repository.getJob(stranger, seeded.job.id),
      () => handle.repository.getWritingProfile(stranger),
      () => handle.repository.getCalibration(stranger, seeded.calibration.id),
      () => handle.repository.getWritingRevision(stranger, seeded.proposal.id),
    ]) assert.throws(attempt, code('NOT_FOUND'));
    assert.ok(!JSON.stringify(handle.repository.exportOwnData(stranger)).includes('Alice only'));
  }
  assert.throws(() => handle.repository.listStories({ ...f.alice }), code('UNAUTHENTICATED'));
  f.sessions.delete('alice');
  assert.throws(() => handle.repository.getStory(f.alice, seeded.story.id), code('UNAUTHENTICATED'));
});

test('idempotency reservations are private to each writer even with identical keys', (t) => {
  const f = fixture(t);
  const handle = f.open();
  const alice = seed(handle.repository, f.alice, 'Alice');
  const cara = seed(handle.repository, f.cara, 'Cara');
  assert.notEqual(alice.job.id, cara.job.id);
  assert.equal(handle.repository.schedulePlan(f.cara, cara.planRequest).id, cara.job.id);
  assert.throws(() => handle.repository.schedulePlan(f.cara, alice.planRequest), code('IDEMPOTENCY_CONFLICT'));
  assert.equal(handle.repository.listJobs(f.alice).length, 1);
  assert.equal(handle.repository.listJobs(f.cara).length, 1);
});

test('independent storage handles reload current revisions and reject stale story and profile writes', (t) => {
  const f = fixture(t);
  const first = f.open();
  const second = f.open();
  const story = first.repository.createStory(f.alice, { text: 'Before' });
  second.repository.updateStory(f.alice, story.id, { text: 'After' }, { expectedRevision: 1 });
  assert.throws(() => first.repository.updateStory(f.alice, story.id, { text: 'Lost update' }, { expectedRevision: 1 }), code('REVISION_CONFLICT'));
  assert.equal(first.repository.getStory(f.alice, story.id).text, 'After');
  first.repository.saveWritingProfile(f.alice, { voice: 'First' }, { expectedVersion: 0 });
  assert.throws(() => second.repository.saveWritingProfile(f.alice, { voice: 'Overwrite' }, { expectedVersion: 0 }), code('VERSION_CONFLICT'));
  assert.equal(second.repository.saveWritingProfile(f.alice, { voice: 'Second' }, { expectedVersion: 1 }).version, 2);
  assert.equal(first.repository.getWritingProfile(f.alice).preferences.voice, 'Second');
});

test('concurrent writers serialize profile compare-and-set across worker connections', async (t) => {
  const f = fixture(t);
  f.open().close();
  const gate = new SharedArrayBuffer(4);
  const workerCode = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {createDurableStoryBankRepository}=await import(workerData.persistenceUrl);
      const {createContextAuthority}=await import(workerData.contextUrl);
      const authority=createContextAuthority({resolveSession:()=>({subject:'alice',memberships:[{tenantId:'alpha',role:'owner'}]})});
      const context=authority.authenticate('fixture-session','alpha');
      const handle=createDurableStoryBankRepository({filename:workerData.filename,authority});
      parentPort.postMessage({ready:true});
      Atomics.wait(new Int32Array(workerData.gate),0,0);
      try { const profile=handle.repository.saveWritingProfile(context,{voice:workerData.voice},{expectedVersion:0}); parentPort.postMessage({version:profile.version}); }
      catch(error) { parentPort.postMessage({code:error.code}); }
      finally {handle.close();}
    })().catch(error=>{parentPort.postMessage({fatal:error.message});process.exitCode=1;});`;
  const workers = ['worker-A', 'worker-B'].map((voice) => new Worker(workerCode, { eval: true, workerData: { filename: f.filename, gate, voice, persistenceUrl: new URL('../server/persistence.mjs', import.meta.url).href, contextUrl: new URL('../server/context.mjs', import.meta.url).href } }));
  t.after(async () => { await Promise.all(workers.map((worker) => worker.terminate())); });
  let ready = 0;
  const results = await Promise.all(workers.map((worker) => new Promise((resolve, reject) => {
    worker.on('error', reject);
    worker.on('message', (message) => {
      if (message.ready) {
        if (++ready === 2) { Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0); }
      } else if (message.fatal) reject(new Error(message.fatal));
      else resolve(message);
    });
  })));
  assert.deepEqual(results.map((result) => result.version ?? result.code).sort(), [1, 'VERSION_CONFLICT']);
  assert.equal(f.open().repository.listWritingProfileVersions(f.alice).length, 1);
});

test('an exception after in-memory mutation rolls back data and audit instead of committing partially', (t) => {
  let calls = 0;
  const f = fixture(t);
  const faulty = f.open({ id: () => { if (++calls === 2) throw new Error('Injected audit failure'); return randomUUID(); } });
  assert.throws(() => faulty.repository.createStory(f.alice, { text: 'Must roll back' }), /Injected audit failure/);
  assert.deepEqual(faulty.repository.listStories(f.alice), []);
  assert.deepEqual(faulty.repository.listAudit(f.alice), []);
  faulty.close();
  assert.deepEqual(f.open().repository.listStories(f.alice), []);
});

test('nested revision application rolls back profile history and proposal status together on failure', (t) => {
  const f = fixture(t);
  const handle = f.open();
  const profile = handle.repository.saveWritingProfile(f.alice, { voice: 'Original' }, { expectedVersion: 0 });
  const calibration = handle.repository.createCalibration(f.alice, { topic: 'Fixture', facts: ['Synthetic fact.'] });
  handle.repository.addCalibrationFeedback(f.alice, calibration.id, { variantId: calibration.variants[0].id, likes: ['brevity'] });
  const proposal = handle.repository.proposeWritingRevision(f.alice, calibration.id);
  const auditBefore = handle.repository.listAudit(f.alice);
  let calls = 0;
  const faulty = f.open({ id: () => { if (++calls === 2) throw new Error('Injected second audit failure'); return randomUUID(); } });
  assert.throws(() => faulty.repository.applyWritingRevision(f.alice, proposal.id, { expectedVersion: profile.version }), /Injected second audit failure/);
  assert.equal(handle.repository.getWritingProfile(f.alice).version, 1);
  assert.equal(handle.repository.getWritingRevision(f.alice, proposal.id).status, 'proposed');
  assert.deepEqual(handle.repository.listAudit(f.alice), auditBefore);
});

test('owner deletion commits across restart without deleting another writer or workspace', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const alice = seed(handle.repository, f.alice, 'Alice private');
  seed(handle.repository, f.cara, 'Cara private');
  seed(handle.repository, f.aliceBeta, 'Alice other tenant');
  const caraBefore = handle.repository.exportOwnData(f.cara);
  const betaBefore = handle.repository.exportOwnData(f.aliceBeta);
  const deleted = handle.repository.deleteOwnData(f.alice);
  assert.equal(deleted.counts.writingProfileVersions, 2);
  assert.equal(deleted.counts.idempotencyReservations, 1);
  handle.close();
  handle = f.open();
  const remaining = handle.repository.exportOwnData(f.alice);
  for (const [name, entries] of Object.entries(remaining.data)) {
    assert.equal(entries.length, name === 'auditEvents' ? 1 : 0, name);
  }
  assert.equal(remaining.data.auditEvents[0].type, 'privacy.deleted');
  assert.ok(!JSON.stringify(remaining).includes('Alice private'));
  assert.deepEqual(handle.repository.exportOwnData(f.cara), caraBefore);
  assert.deepEqual(handle.repository.exportOwnData(f.aliceBeta), betaBefore);
  assert.throws(() => handle.repository.getApproval(f.alice, alice.approval.record.id), code('NOT_FOUND'));
  const replacement = seed(handle.repository, f.alice, 'Replacement fixture');
  assert.notEqual(replacement.job.id, alice.job.id);
});

test('deletion rolls back removed data and audit if the deletion receipt cannot be recorded', (t) => {
  const f = fixture(t);
  const handle = f.open();
  seed(handle.repository, f.alice);
  const before = handle.repository.exportOwnData(f.alice);
  const faulty = f.open({ clock: () => { throw new Error('Injected deletion clock failure'); } });
  assert.throws(() => faulty.repository.deleteOwnData(f.alice), /Injected deletion clock failure/);
  assert.deepEqual(handle.repository.exportOwnData(f.alice), before);
});

test('deleting a story durably removes approval snapshots and leaves only its blocked/cancelled job history', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const { story, approval, job } = seed(handle.repository, f.alice);
  assert.equal(handle.repository.deleteStory(f.alice, story.id).scope, 'live_local_database');
  handle.close();
  handle = f.open();
  assert.throws(() => handle.repository.getStory(f.alice, story.id), code('NOT_FOUND'));
  assert.throws(() => handle.repository.getApproval(f.alice, approval.record.id), code('NOT_FOUND'));
  assert.equal(handle.repository.getJob(f.alice, job.id).status, 'cancelled');
});

test('workspace integration revocation persists and invalidates all plans without widening audit access', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const alice = seed(handle.repository, f.alice, 'Alice private');
  const cara = seed(handle.repository, f.cara, 'Cara private');
  handle.repository.revokeIntegration(f.alice);
  handle.close();
  handle = f.open();
  assert.equal(handle.repository.integrationStatus(f.cara).status, 'revoked');
  assert.equal(handle.repository.getJob(f.cara, cara.job.id).status, 'cancelled');
  assert.equal(handle.repository.getJob(f.alice, alice.job.id).status, 'cancelled');
  assert.ok(!JSON.stringify(handle.repository.listAudit(f.alice)).includes(cara.job.id));
});

test('session digest facade persists fixed-expiry records, revocations, and expiry deletion without exposing raw state', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const alice = { tokenDigest: digest('synthetic session a'), csrfDigest: digest('synthetic csrf a'), subject: 'alice', createdAt: NOW, expiresAt: NOW + 3600000, authTime: NOW - 1 };
  const cara = { ...alice, tokenDigest: digest('synthetic session c'), subject: 'cara' };
  handle.sessionStore.put(alice);
  handle.sessionStore.put(cara);
  assert.throws(() => handle.sessionStore.put(alice));
  assert.throws(() => handle.sessionStore.put({ ...alice, rawToken: 'must-not-be-stored' }), TypeError);
  const copy = handle.sessionStore.getByDigest(alice.tokenDigest);
  copy.subject = 'mallory';
  assert.equal(handle.sessionStore.getByDigest(alice.tokenDigest).subject, 'alice');
  handle.close();
  handle = f.open();
  assert.deepEqual(handle.sessionStore.getByDigest(alice.tokenDigest), alice);
  handle.sessionStore.deleteForUser('alice');
  handle.close();
  handle = f.open();
  assert.equal(handle.sessionStore.getByDigest(alice.tokenDigest), null);
  assert.deepEqual(handle.sessionStore.getByDigest(cara.tokenDigest), cara);
  assert.equal(handle.sessionStore.getByDigest("' OR 1=1 --"), null);
  assert.equal(handle.sessionStore.deleteExpired(NOW + 3600000), 1);
  assert.equal(handle.sessionStore.getByDigest(cara.tokenDigest), null);
  assert.equal('state' in handle.repository, false);
  assert.equal('db' in handle, false);
  handle.close();
  assert.throws(() => handle.repository.listStories(f.alice), code('STORAGE_CLOSED'));
  assert.throws(() => handle.sessionStore.getByDigest(alice.tokenDigest), code('STORAGE_CLOSED'));
});

test('storage-first composition supports a session authority without exposing an internal store', (t) => {
  const f = fixture(t);
  const storage = openStoryBankStorage({ filename: f.filename });
  t.after(() => storage.close());
  assert.deepEqual(Object.keys(storage).sort(), ['close', 'createRepository', 'sessionStore']);
  const repository = storage.createRepository({ authority: f.authority });
  repository.createStory(f.alice, { text: 'Composed storage fixture' });
  assert.equal(repository.listStories(f.alice).length, 1);
});

test('migrations are versioned, checksummed, idempotent and upgrade version one without data loss', (t) => {
  const f = fixture(t);
  let handle = f.open();
  const story = handle.repository.createStory(f.alice, { text: 'Pre-migration fixture' });
  handle.close();
  let db = new DatabaseSync(f.filename);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, STORYBANK_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 2);
  assert.equal(db.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get().checksum, digest(migration1.sql));
  db.exec('DROP TABLE sessions; DELETE FROM schema_migrations WHERE version = 2; PRAGMA user_version = 1;');
  db.close();
  handle = f.open();
  assert.equal(handle.repository.getStory(f.alice, story.id).text, 'Pre-migration fixture');
  handle.close();
  db = new DatabaseSync(f.filename);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 2);
  db.close();
});

for (const mutation of ['future version', 'checksum mismatch', 'unknown trigger', 'extra column', 'wrong application', 'invalid payload']) {
  test(`storage fails closed for ${mutation}`, (t) => {
    const f = fixture(t);
    const handle = f.open();
    const story = handle.repository.createStory(f.alice, { text: 'Integrity fixture' });
    handle.close();
    const db = new DatabaseSync(f.filename);
    if (mutation === 'future version') db.exec('PRAGMA user_version = 999');
    if (mutation === 'checksum mismatch') db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('tampered');
    if (mutation === 'unknown trigger') db.exec('CREATE TRIGGER unrecognized_trigger AFTER INSERT ON sessions BEGIN SELECT 1; END');
    if (mutation === 'extra column') db.exec('ALTER TABLE repository_records ADD COLUMN unrecognized TEXT');
    if (mutation === 'wrong application') db.exec('PRAGMA application_id = 17');
    if (mutation === 'invalid payload') db.prepare('UPDATE repository_records SET payload = ? WHERE collection = ? AND record_key = ?').run('null', 'stories', JSON.stringify(['alpha', story.id]));
    db.close();
    assert.throws(() => f.open(), code(mutation === 'invalid payload' ? 'STORAGE_CORRUPT' : 'STORAGE_SCHEMA_UNSUPPORTED'));
  });
}

test('unrelated and non-SQLite files are rejected rather than overwritten or reset', (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.filename);
  db.exec('CREATE TABLE unrelated (data TEXT)');
  db.close();
  assert.throws(() => f.open(), code('STORAGE_SCHEMA_UNSUPPORTED'));
  const other = join(f.directory, 'not-sqlite');
  writeFileSync(other, 'Synthetic non-database file');
  assert.throws(() => f.open({ filename: other }), code('STORAGE_OPEN_FAILED'));
});

test('SQL-looking personal text is stored literally by parameterized writes', (t) => {
  const f = fixture(t);
  const handle = f.open();
  const text = `'); DROP TABLE sessions; -- synthetic SQL-looking story`;
  const story = handle.repository.createStory(f.alice, { text });
  assert.equal(handle.repository.getStory(f.alice, story.id).text, text);
  assert.equal(handle.sessionStore.getByDigest(digest('does not exist')), null);
});
