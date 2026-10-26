import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { AUDIO_MAX_BYTES, AUDIO_MIME_TYPES, cleanupOwnerAudio, handleAudioRequest } from '../server/hosted-audio.mjs';
const STORYBANK_SITE_ORIGIN = 'https://tester.storybank.example';
const ENV = { STORYBANK_SITE_ORIGIN };

const ALICE = { userId: 'synthetic-alice', displayName: 'Alice' };
const BOB = { userId: 'synthetic-bob', displayName: 'Bob' };
const SCHEMA = ['0001_gorgeous_dragon_lord.sql', '0003_audio_resource_limits.sql'].map((name) => readFileSync(new URL(`../hosted/drizzle/${name}`, import.meta.url), 'utf8')).join('\n');
const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]); // Synthetic container fixture, not a real recording.
const keyFor = (owner, id) => `audio/${createHash('sha256').update(owner).digest('hex')}/${id}`;
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** Execute real SQL in SQLite; emulate only D1's async result/session envelope. */
class FakeD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.nowSeconds = 1800000000; // Fixed UTC window for deterministic synthetic rate tests.
    this.sqlite.function('unixepoch', () => this.nowSeconds);
    this.sqlite.exec(SCHEMA);
    this.calls = [];
    this.sessions = [];
    this.fault = null;
  }
  withSession(mode) { this.sessions.push(mode); return this; }
  prepare(sql) {
    const db = this;
    return { bind(...values) {
      async function execute(kind) {
        db.calls.push({ sql, values: [...values], kind });
        const fault = db.fault && db.fault.match(sql, values, kind) ? db.fault : null;
        if (fault) db.fault = null;
        if (fault?.before) throw new Error('Synthetic D1 failure before mutation');
        const beforeChanges = db.sqlite.prepare('SELECT total_changes() AS count').get().count;
        const statement = db.sqlite.prepare(sql);
        let result;
        if (kind === 'first') result = statement.get(...values) ?? null;
        if (kind === 'all') result = { success: true, results: statement.all(...values) };
        if (kind === 'run') { statement.run(...values); result = { success: true }; }
        // D1 uses total_changes, including effects of triggers, unlike the
        // direct statement's SQLite changes count.
        if (kind !== 'first') result.meta = { changes: Number(db.sqlite.prepare('SELECT total_changes() AS count').get().count - beforeChanges) };
        if (fault?.after) throw new Error('Synthetic D1 failure after mutation');
        if (fault?.result) return fault.result;
        return result;
      }
      return { first: () => execute('first'), all: () => execute('all'), run: () => execute('run') };
    } };
  }
  rows() { return this.sqlite.prepare('SELECT * FROM storybank_audio ORDER BY owner_id,id').all().map((row) => ({ ...row })); }
}
class FakeR2 {
  objects = new Map();
  calls = [];
  failPut = null;
  failDelete = null;
  putGate = null;
  putStarted = null;
  async put(key, value, options) {
    this.calls.push({ operation: 'put', key, options });
    this.putStarted?.resolve();
    if (this.putGate) await this.putGate.promise;
    const fault = this.failPut;
    this.failPut = null;
    if (fault === 'before') throw new Error('Synthetic R2 put failed');
    const stored = { key, size: value.byteLength, bytes: new Uint8Array(value), httpMetadata: options.httpMetadata };
    this.objects.set(key, stored);
    if (fault === 'after') throw new Error('Synthetic R2 put outcome unknown');
    return { key, size: stored.size };
  }
  async get(key, options) {
    this.calls.push({ operation: 'get', key, options });
    const object = this.objects.get(key);
    const body = object && options?.range ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length) : object?.bytes;
    return object ? { key, size: object.size, body: new Blob([body]).stream(), httpMetadata: object.httpMetadata, range: options?.range } : null;
  }
  async delete(key) {
    this.calls.push({ operation: 'delete', key });
    const fault = this.failDelete;
    this.failDelete = null;
    if (fault === 'before') throw new Error('Synthetic R2 delete failed');
    this.objects.delete(key);
    if (fault === 'after') throw new Error('Synthetic R2 delete outcome unknown');
  }
}
function fixture(t) {
  const db = new FakeD1();
  const bucket = new FakeR2();
  t.after(() => db.sqlite.close());
  return { db, bucket, user: ALICE, env: ENV };
}
function request(path = '/api/audio', { method = 'GET', body, headers = {}, origin = STORYBANK_SITE_ORIGIN, user = ALICE } = {}) {
  const mutation = ['POST', 'DELETE'].includes(method);
  return new Request(`${origin}${path}`, { method, ...(body !== undefined ? { body } : {}), ...(body instanceof ReadableStream ? { duplex: 'half' } : {}), headers: { 'x-storybank-workspace': `personal_${createHash('sha256').update(user.userId).digest('hex')}`, ...(mutation ? { origin, 'x-storybank-request': '1', 'sec-fetch-site': 'same-origin', 'x-storybank-workspace': `personal_${createHash('sha256').update(user.userId).digest('hex')}` } : {}), ...(body !== undefined ? { 'content-type': 'audio/webm;codecs=opus' } : {}), ...headers } });
}
async function upload(f, user = ALICE, options = {}) {
  const response = await handleAudioRequest(request('/api/audio', { method: 'POST', body: bytes, user, ...options }), { ...f, user });
  return { response, body: await response.json() };
}
async function list(f, user = ALICE) {
  const response = await handleAudioRequest(request('/api/audio', { user }), { ...f, user });
  return { response, body: await response.json() };
}
function seedIncomplete(db, user = ALICE) {
  const id = randomUUID();
  const key = keyFor(user.userId, id);
  db.sqlite.prepare("INSERT INTO storybank_audio VALUES (?, ?, ?, 'audio/webm', 8, ?, 'uploading', 0)").run(user.userId, id, key, new Date().toISOString());
  return { id, key };
}

test('raw audio upload reserves metadata before R2, lists only public fields, and plays privately', async (t) => {
  const f = fixture(t);
  const originalPut = f.bucket.put.bind(f.bucket);
  f.bucket.put = async (...args) => {
    assert.equal(f.db.rows().length, 1);
    assert.equal(f.db.rows()[0].status, 'uploading');
    assert.equal(f.db.rows()[0].upload_complete, 0);
    assert.deepEqual((await list(f)).body.recordings, []);
    return originalPut(...args);
  };
  const uploaded = await upload(f);
  assert.equal(uploaded.response.status, 201);
  assert.deepEqual(Object.keys(uploaded.body), ['id']);
  const stored = f.db.rows()[0];
  assert.equal(stored.status, 'active');
  assert.equal(stored.upload_complete, 1);
  assert.equal(stored.owner_id, ALICE.userId);
  assert.equal(stored.object_key, keyFor(ALICE.userId, uploaded.body.id));
  assert.ok(!stored.object_key.includes(ALICE.userId));
  const listed = await list(f);
  assert.deepEqual(listed.body.recordings, [{ id: uploaded.body.id, mimeType: 'audio/webm', size: bytes.length, createdAt: stored.created_at }]);
  assert.ok(!JSON.stringify(listed.body).includes(stored.object_key));
  const played = await handleAudioRequest(request(`/api/audio/${uploaded.body.id}`), f);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get('content-type'), 'audio/webm');
  assert.equal(played.headers.get('content-length'), String(bytes.length));
  assert.equal(played.headers.get('cache-control'), 'private, no-store');
  assert.equal(played.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(played.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await played.arrayBuffer()), bytes);
  assert.ok(f.db.sessions.every((mode) => mode === 'first-primary'));
});

test('missing server identity rejects all endpoints before storage or body consumption', async (t) => {
  const f = fixture(t);
  for (const user of [null, undefined, {}, { userId: '' }, { userId: '   ' }, { userId: 'x'.repeat(501) }, { userId: 12 }]) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await handleAudioRequest(request(`/api/audio${method === 'DELETE' ? `/${randomUUID()}` : ''}`, { method, ...(method === 'POST' ? { body: bytes } : {}) }), { ...f, user });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, 'UNAUTHENTICATED');
    }
  }
  assert.equal(f.db.calls.length, 0);
  assert.equal(f.bucket.calls.length, 0);
});

test('foreign IDs, query/header selectors, and missing IDs cannot disclose or delete another owner audio', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  const before = f.bucket.calls.length;
  assert.deepEqual((await list(f, BOB)).body, { recordings: [] });
  const get = await handleAudioRequest(request(`/api/audio/${id}?owner_id=${ALICE.userId}`, { headers: { 'x-user-id': ALICE.userId }, user: BOB }), { ...f, user: BOB });
  assert.equal(get.status, 404);
  const unknown = await handleAudioRequest(request(`/api/audio/${randomUUID()}`), { ...f, user: BOB });
  assert.deepEqual(await get.json(), await unknown.json());
  for (const target of [id, randomUUID()]) {
    const deletion = await handleAudioRequest(request(`/api/audio/${target}`, { method: 'DELETE', headers: { 'x-user-id': ALICE.userId }, user: BOB }), { ...f, user: BOB });
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { deleted: true, remaining: 0 });
  }
  assert.equal(f.bucket.calls.length, before);
  assert.equal(f.db.rows()[0].owner_id, ALICE.userId);
  assert.equal((await list(f)).body.recordings.length, 1);
});

test('POST and DELETE require same-origin and custom header; explicit localhost development stays bounded', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  const before = f.bucket.calls.length;
  for (const method of ['POST', 'DELETE']) {
    for (const headers of [{ origin: 'https://attacker.invalid' }, { origin: '' }, { 'x-storybank-request': '' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const response = await handleAudioRequest(request(method === 'POST' ? '/api/audio' : `/api/audio/${id}`, { method, headers, ...(method === 'POST' ? { body: bytes } : {}) }), f);
      assert.equal(response.status, 403);
    }
  }
  assert.equal(f.bucket.calls.length, before);
  const untrustedHost = await handleAudioRequest(request('/api/audio', { origin: 'https://attacker.invalid', method: 'POST', body: bytes }), f);
  assert.equal(untrustedHost.status, 403);
  assert.equal((await handleAudioRequest(request('/api/audio', { origin: 'http://localhost:3000', method: 'POST', body: bytes }), f)).status, 403);
  assert.equal((await handleAudioRequest(request('/api/audio', { origin: 'http://localhost:3000', method: 'POST', body: bytes }), { ...f, allowLocalDevelopment: true })).status, 201);
  assert.equal((await handleAudioRequest(request('/api/audio', { origin: 'http://attacker.invalid', method: 'POST', body: bytes }), { ...f, allowLocalDevelopment: true })).status, 403);
});

test('MIME allowlist, nonempty body, compression, advertised and streamed length limits are enforced before R2 writes', async (t) => {
  const f = fixture(t);
  for (const mime of ['application/json', 'text/html', 'video/webm', 'multipart/form-data', 'audio/not-supported']) {
    assert.equal((await upload(f, ALICE, { headers: { 'content-type': mime } })).response.status, 415);
  }
  assert.equal((await upload(f, ALICE, { body: new Uint8Array() })).response.status, 400);
  assert.equal((await upload(f, ALICE, { headers: { 'content-encoding': 'gzip' } })).response.status, 415);
  for (const advertised of [String(AUDIO_MAX_BYTES + 1), '-1', 'invalid', '1e9']) {
    assert.equal((await upload(f, ALICE, { headers: { 'content-length': advertised } })).response.status, 413);
  }
  let cancelled = false;
  let part = 0;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(part++ === 0 ? AUDIO_MAX_BYTES : 1)); }, cancel() { cancelled = true; } });
  const oversized = await upload(f, ALICE, { body: stream, headers: { 'content-length': '1' } });
  assert.equal(oversized.response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(f.db.rows().length, 0);
  assert.equal(f.bucket.calls.length, 0);
  for (const type of AUDIO_MIME_TYPES) assert.equal((await upload(f, ALICE, { headers: { 'content-type': type } })).response.status, 201);
  assert.equal((await upload(f, ALICE, { body: new Uint8Array(AUDIO_MAX_BYTES) })).response.status, 201);
});

test('upload reservation failures never write R2 and reserve uncertain metadata without exposing it', async (t) => {
  const f = fixture(t);
  f.db.fault = { match: (sql) => sql.startsWith('INSERT'), before: true };
  assert.equal((await upload(f)).response.status, 503);
  assert.equal(f.bucket.calls.length, 0);
  assert.equal(f.db.rows().length, 0);
  f.db.fault = { match: (sql) => sql.startsWith('INSERT'), after: true };
  assert.equal((await upload(f)).response.status, 503);
  assert.equal(f.bucket.calls.length, 0);
  assert.equal(f.db.rows().length, 1);
  assert.equal(f.db.rows()[0].status, 'uploading');
  assert.deepEqual((await list(f)).body.recordings, []);
});

test('failed/uncertain R2 uploads leave hidden cleanup tombstones, never phantom success', async (t) => {
  const f = fixture(t);
  for (const failure of ['before', 'after']) {
    f.bucket.failPut = failure;
    const result = await upload(f);
    assert.equal(result.response.status, 503);
    assert.equal(result.body.error, 'AUDIO_UPLOAD_OUTCOME_UNKNOWN');
  }
  assert.equal(f.db.rows().length, 2);
  assert.ok(f.db.rows().every((row) => row.status === 'deleting' && row.upload_complete === 0));
  assert.deepEqual((await list(f)).body.recordings, []);
  assert.equal(f.bucket.objects.size, 0);
  const cleanup = await cleanupOwnerAudio(f);
  assert.equal(cleanup.deleted, 0);
  assert.equal(cleanup.remaining, 2);
  assert.ok(cleanup.failures.every((failure) => failure.code === 'AUDIO_UPLOAD_PENDING'));
});

test('successful delete hides before removing R2, erases metadata last, and is safely repeatable', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  const originalDelete = f.bucket.delete.bind(f.bucket);
  f.bucket.delete = async (key) => {
    assert.equal(f.db.rows()[0].status, 'deleting');
    assert.deepEqual((await list(f)).body.recordings, []);
    assert.equal((await handleAudioRequest(request(`/api/audio/${id}`), f)).status, 404);
    return originalDelete(key);
  };
  const remove = () => handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE' }), f);
  assert.deepEqual(await (await remove()).json(), { deleted: true, remaining: 0 });
  assert.equal(f.db.rows().length, 0);
  assert.equal(f.bucket.objects.size, 0);
  const calls = f.bucket.calls.length;
  assert.equal((await remove()).status, 200);
  assert.equal(f.bucket.calls.length, calls);
});

test('R2 deletion failure and uncertain outcome remain hidden and converge on a retry', async (t) => {
  for (const failure of ['before', 'after']) {
    const f = fixture(t);
    const { body: { id } } = await upload(f);
    f.bucket.failDelete = failure;
    const remove = () => handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE' }), f);
    const failed = await remove();
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error, 'AUDIO_DELETE_PENDING');
    assert.equal(f.db.rows()[0].status, 'deleting');
    assert.deepEqual((await list(f)).body.recordings, []);
    assert.equal((await handleAudioRequest(request(`/api/audio/${id}`), f)).status, 404);
    assert.equal((await remove()).status, 200);
    assert.equal(f.db.rows().length, 0);
    assert.equal(f.bucket.objects.size, 0);
  }
});

test('metadata erase failure retains retryable tombstone; uncertain erase success also retries safely', async (t) => {
  for (const timing of ['before', 'after']) {
    const f = fixture(t);
    const { body: { id } } = await upload(f);
    f.db.fault = { match: (sql) => sql.startsWith('DELETE'), [timing]: true };
    const remove = () => handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE' }), f);
    assert.equal((await remove()).status, 503);
    assert.equal(f.bucket.objects.size, 0);
    assert.deepEqual((await list(f)).body.recordings, []);
    assert.equal((await remove()).status, 200);
    assert.equal(f.db.rows().length, 0);
  }
});

test('a failed tombstone write does not delete R2; no failure is reported as successful erasure', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  const calls = f.bucket.calls.length;
  f.db.fault = { match: (sql) => sql.includes("SET status = 'deleting'"), before: true };
  const response = await handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE' }), f);
  assert.equal(response.status, 503);
  assert.equal(f.db.rows()[0].status, 'active');
  assert.equal(f.bucket.calls.length, calls);
});

test('owner cleanup deletes only that owner and reports hidden crashed uploads honestly', async (t) => {
  const f = fixture(t);
  await upload(f);
  await upload(f, BOB);
  const crashed = seedIncomplete(f.db);
  f.bucket.objects.set(crashed.key, { key: crashed.key, size: bytes.length, bytes });
  const result = await cleanupOwnerAudio(f);
  assert.equal(result.deleted, 1);
  assert.equal(result.remaining, 1);
  assert.deepEqual(result.failures, [{ id: crashed.id, code: 'AUDIO_UPLOAD_PENDING' }]);
  assert.equal(f.db.rows().find((row) => row.id === crashed.id).status, 'deleting');
  assert.deepEqual((await list(f)).body.recordings, []);
  assert.equal((await list(f, BOB)).body.recordings.length, 1);
  assert.equal(f.bucket.objects.size, 1);
  assert.ok(!JSON.stringify(result).includes('audio/'));
});

test('owner cleanup hides all recordings even when one R2 deletion fails and reports accurate counts', async (t) => {
  const f = fixture(t);
  await upload(f);
  await upload(f);
  f.bucket.failDelete = 'before';
  const cleanup = await cleanupOwnerAudio(f);
  assert.equal(cleanup.deleted, 1);
  assert.equal(cleanup.remaining, 1);
  assert.equal(cleanup.failures[0].code, 'AUDIO_DELETE_PENDING');
  assert.deepEqual((await list(f)).body.recordings, []);
  assert.deepEqual(await cleanupOwnerAudio(f), { deleted: 1, remaining: 0, failures: [] });
});

test('cleanup racing an upload retains its tombstone until late put is removed, never activates or orphans audio', async (t) => {
  const f = fixture(t);
  f.bucket.putGate = deferred();
  f.bucket.putStarted = deferred();
  const uploading = upload(f);
  await f.bucket.putStarted.promise;
  const pending = await cleanupOwnerAudio(f);
  assert.equal(pending.remaining, 1);
  assert.equal(f.db.rows()[0].status, 'deleting');
  // A second cleanup must not erase the reference while the R2 put is in flight.
  assert.equal((await cleanupOwnerAudio(f)).remaining, 1);
  f.bucket.putGate.resolve();
  const finished = await uploading;
  assert.equal(finished.response.status, 409);
  assert.equal(finished.body.error, 'AUDIO_UPLOAD_CANCELLED');
  assert.equal(f.db.rows().length, 0);
  assert.equal(f.bucket.objects.size, 0);
  assert.deepEqual((await list(f)).body.recordings, []);
});

test('forged stored key and owner metadata fail closed without R2 access or leaking private keys', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  f.db.sqlite.prepare('UPDATE storybank_audio SET object_key = ? WHERE id = ?').run(`audio/foreign/private-${id}`, id);
  const calls = f.bucket.calls.length;
  for (const method of ['GET', 'DELETE']) {
    const response = await handleAudioRequest(request(`/api/audio/${id}`, { method }), f);
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.ok(!body.includes('foreign'));
    assert.ok(!body.includes(id));
  }
  assert.equal(f.bucket.calls.length, calls);
});

test('missing bindings, malformed IDs, unsupported methods, and missing R2 files are handled safely', async (t) => {
  const f = fixture(t);
  for (const option of [{ db: null }, { bucket: null }, { bucket: {} }]) assert.equal((await handleAudioRequest(request(), { ...f, ...option })).status, 503);
  for (const path of ['/api/audio/nope', '/api/audio/..%2Fsecret', '/api/audio/x/y', '/api/unknown']) assert.equal((await handleAudioRequest(request(path), f)).status, 404);
  assert.equal((await handleAudioRequest(request('/api/audio', { method: 'PATCH' }), f)).status, 405);
  const { body: { id } } = await upload(f);
  f.bucket.objects.clear();
  assert.equal((await handleAudioRequest(request(`/api/audio/${id}`), f)).status, 404);
});

test('completion and activation failures keep recovery references and never retry an uncertain mutation', async (t) => {
  for (const sqlFragment of ['SET upload_complete = 1', "SET status = 'active'"]) {
    for (const timing of ['before', 'after']) {
      const f = fixture(t);
      f.db.fault = { match: (sql) => sql.includes(sqlFragment), [timing]: true };
      const result = await upload(f);
      assert.equal(result.response.status, 503);
      assert.equal(result.body.error, 'AUDIO_STORAGE_OUTCOME_UNKNOWN');
      assert.equal(f.bucket.calls.filter((call) => call.operation === 'put').length, 1);
      assert.equal(f.db.calls.filter((call) => call.sql.includes(sqlFragment)).length, 1);
      assert.equal(f.db.rows().length, 1);
      // An activation that committed despite a lost acknowledgment may be in the
      // owner's list. The error tells the caller to refresh, never to auto-retry.
      const wasActivated = sqlFragment.includes("'active'") && timing === 'after';
      assert.equal((await list(f)).body.recordings.length, wasActivated ? 1 : 0);
      const cleanup = await cleanupOwnerAudio(f);
      assert.equal(cleanup.remaining, sqlFragment.includes('upload_complete') && timing === 'before' ? 1 : 0);
      assert.equal(f.bucket.objects.size, 0);
    }
  }
});

test('SQL-looking verified user IDs remain literal and every record read/write is owner scoped', async (t) => {
  const f = fixture(t);
  await upload(f, BOB);
  const user = { userId: "owner'); DELETE FROM storybank_audio; --" };
  const result = await upload(f, user);
  assert.equal(result.response.status, 201);
  assert.equal((await list(f, user)).body.recordings.length, 1);
  assert.equal((await list(f, BOB)).body.recordings.length, 1);
  assert.equal((await cleanupOwnerAudio({ ...f, user })).remaining, 0);
  assert.equal((await list(f, BOB)).body.recordings.length, 1);
  assert.ok(f.db.calls.filter((call) => !call.sql.startsWith('INSERT')).every((call) => /WHERE owner_id = \?/.test(call.sql)));
});

test('private playback supports bounded byte ranges for seeking without widening owner access', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  for (const [header, offset, length] of [['bytes=0-1', 0, 2], ['bytes=2-', 2, 6], ['bytes=-3', 5, 3], ['bytes=3-99', 3, 5], ['bytes=-99', 0, 8]]) {
    const response = await handleAudioRequest(request(`/api/audio/${id}`, { headers: { range: header } }), f);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${offset}-${offset + length - 1}/${bytes.length}`);
    assert.equal(response.headers.get('content-length'), String(length));
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes.slice(offset, offset + length));
  }
  for (const header of ['bytes=', 'bytes=-0', 'bytes=99-', 'bytes=5-2', 'bytes=0-1,3-4', 'bytes=9007199254740993-']) {
    const calls = f.bucket.calls.length;
    const response = await handleAudioRequest(request(`/api/audio/${id}`, { headers: { range: header } }), f);
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.equal(f.bucket.calls.length, calls);
  }
  const foreign = await handleAudioRequest(request(`/api/audio/${id}`, { headers: { range: 'bytes=0-1' } }), { ...f, user: BOB });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.headers.get('content-range'), null);
  const conditional = await handleAudioRequest(request(`/api/audio/${id}`, { headers: { range: 'bytes=0-1', 'if-range': 'unknown-validator' } }), f);
  assert.equal(conditional.status, 200);
  assert.deepEqual(new Uint8Array(await conditional.arrayBuffer()), bytes);
});

test('audio consistency header blocks account-switched upload and delete before storage side effects', async (t) => {
  const f = fixture(t);
  const staleKey = `personal_${createHash('sha256').update(ALICE.userId).digest('hex')}`;
  const refused = await upload(f, BOB, { headers: { 'x-storybank-workspace': staleKey } });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.error, 'WORKSPACE_CHANGED');
  assert.deepEqual(f.db.calls, []);
  assert.deepEqual(f.bucket.calls, []);
  const uploaded = await upload(f, BOB);
  assert.equal(uploaded.response.status, 201);
  const dbCalls = f.db.calls.length;
  const bucketCalls = f.bucket.calls.length;
  const deleted = await handleAudioRequest(request(`/api/audio/${uploaded.body.id}`, { method: 'DELETE', headers: { 'x-storybank-workspace': staleKey } }), { ...f, user: BOB });
  assert.equal(deleted.status, 409);
  assert.equal(f.db.calls.length, dbCalls);
  assert.equal(f.bucket.calls.length, bucketCalls);
  assert.equal(f.db.rows().length, 1);
});

function policy(db, values) {
  const keys = Object.keys(values);
  const allowed = new Set(['owner_max_bytes', 'owner_max_objects', 'project_max_bytes', 'project_max_objects', 'owner_window_attempts', 'project_window_attempts']);
  assert.ok(keys.every((key) => allowed.has(key)));
  db.sqlite.prepare(`UPDATE storybank_audio_policy SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = 1`).run(...Object.values(values));
}
function rateRows(db) { return db.sqlite.prepare('SELECT * FROM storybank_audio_rate ORDER BY scope,subject').all().map((row) => ({ ...row })); }
function knownUploadRequest(user = ALICE) { return request('/api/audio', { method: 'POST', body: bytes, user, headers: { 'content-length': String(bytes.length) } }); }

// These exercise real SQLite statements/triggers, not mocked quota decisions.
test('migration defaults are application budgets and root/hosted copies stay identical', (t) => {
  const f = fixture(t);
  assert.deepEqual({ ...f.db.sqlite.prepare('SELECT * FROM storybank_audio_policy').get() }, {
    id: 1, owner_max_bytes: 50 * 1024 * 1024, owner_max_objects: 20,
    project_max_bytes: 500 * 1024 * 1024, project_max_objects: 200,
    owner_window_attempts: 12, project_window_attempts: 120,
  });
  assert.equal(readFileSync(new URL('../drizzle/0003_audio_resource_limits.sql', import.meta.url), 'utf8'), readFileSync(new URL('../hosted/drizzle/0003_audio_resource_limits.sql', import.meta.url), 'utf8'));
});

test('simultaneous owner reservations cannot overrun bytes or count before reading bodies', async (t) => {
  for (const limits of [{ owner_max_bytes: bytes.length * 2 }, { owner_max_objects: 2 }]) {
    const f = fixture(t);
    policy(f.db, limits);
    f.bucket.putGate = deferred();
    f.bucket.putStarted = deferred();
    const requests = Array.from({ length: 8 }, () => knownUploadRequest());
    const running = requests.map((req) => handleAudioRequest(req, f));
    await f.bucket.putStarted.promise;
    assert.equal(f.db.rows().length, 2);
    assert.ok(f.db.rows().every((row) => row.status === 'uploading'));
    assert.equal(rateRows(f.db).find((row) => row.scope === 'project').attempts, 2);
    f.bucket.putGate.resolve();
    const responses = await Promise.all(running);
    assert.equal(responses.filter((response) => response.status === 201).length, 2);
    assert.equal(responses.filter((response) => response.status === 429).length, 6);
    for (const [index, response] of responses.entries()) if (response.status === 429) {
      assert.equal((await response.json()).error, 'AUDIO_OWNER_QUOTA_REACHED');
      assert.equal(requests[index].bodyUsed, false);
    }
    assert.equal(f.bucket.calls.filter((call) => call.operation === 'put').length, 2);
  }
});

test('simultaneous cross-owner reservations enforce project bytes and object count', async (t) => {
  for (const limits of [{ project_max_bytes: bytes.length * 2 }, { project_max_objects: 2 }]) {
    const f = fixture(t);
    policy(f.db, limits);
    f.bucket.putGate = deferred();
    f.bucket.putStarted = deferred();
    const users = Array.from({ length: 8 }, (_, index) => ({ userId: `synthetic-project-${index}` }));
    const requests = users.map((user) => knownUploadRequest(user));
    const running = requests.map((req, index) => handleAudioRequest(req, { ...f, user: users[index] }));
    await f.bucket.putStarted.promise;
    assert.equal(f.db.rows().length, 2);
    f.bucket.putGate.resolve();
    const responses = await Promise.all(running);
    assert.equal(responses.filter((response) => response.status === 201).length, 2);
    for (const [index, response] of responses.entries()) if (response.status !== 201) {
      assert.equal(response.status, 429);
      assert.equal((await response.json()).error, 'AUDIO_PROJECT_QUOTA_REACHED');
      assert.equal(requests[index].bodyUsed, false);
    }
    assert.equal(f.bucket.objects.size, 2);
  }
});

test('owner quota is isolated while uploading, active, deleting, and uncertain reservations all count', async (t) => {
  for (const status of ['uploading', 'active', 'deleting']) {
    const f = fixture(t);
    const seeded = seedIncomplete(f.db);
    f.db.sqlite.prepare('UPDATE storybank_audio SET status = ?, upload_complete = ? WHERE id = ?').run(status, status === 'active' ? 1 : 0, seeded.id);
    policy(f.db, { owner_max_bytes: bytes.length });
    const req = knownUploadRequest();
    const denied = await handleAudioRequest(req, f);
    assert.equal(denied.status, 429);
    assert.equal((await denied.json()).error, 'AUDIO_OWNER_QUOTA_REACHED');
    assert.equal(req.bodyUsed, false);
    assert.equal((await handleAudioRequest(knownUploadRequest(BOB), { ...f, user: BOB })).status, 201);
    assert.equal(f.db.rows().filter((row) => row.owner_id === ALICE.userId).length, 1);
  }
});

test('unknown sizes reserve the maximum before reads, then shrink without admitting understated lengths', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_max_bytes: AUDIO_MAX_BYTES - 1 });
  const unknown = request('/api/audio', { method: 'POST', body: bytes });
  const refused = await handleAudioRequest(unknown, f);
  assert.equal(refused.status, 429);
  assert.equal(unknown.bodyUsed, false);
  assert.equal(f.db.rows().length, 0);
  policy(f.db, { owner_max_bytes: AUDIO_MAX_BYTES });
  let reserveAtRead;
  const streamed = new ReadableStream({
    pull(controller) {
      // Request streams can be prefetched upstream; record only the state seen
      // once the application starts consuming, not a claim about network reads.
      if (f.db.rows().length) reserveAtRead = f.db.rows()[0].size;
      controller.enqueue(bytes);
      controller.close();
    },
  }, { highWaterMark: 0 });
  assert.equal((await upload(f, ALICE, { body: streamed })).response.status, 201);
  assert.equal(reserveAtRead, AUDIO_MAX_BYTES);
  assert.equal(f.db.rows()[0].size, bytes.length);
  const understated = await upload(f, ALICE, { headers: { 'content-length': '1' } });
  assert.equal(understated.response.status, 413);
  const overstated = await upload(f, ALICE, { headers: { 'content-length': String(bytes.length + 1) } });
  assert.equal(overstated.response.status, 400);
  assert.equal(overstated.body.error, 'AUDIO_LENGTH_MISMATCH');
  assert.equal(f.db.rows().length, 1);
  assert.equal(f.bucket.calls.filter((call) => call.operation === 'put').length, 1);
});

test('a failed counter mutation rolls back reservation and both rate charges atomically', async (t) => {
  const f = fixture(t);
  f.db.sqlite.exec("CREATE TRIGGER synthetic_counter_failure BEFORE INSERT ON storybank_audio_rate WHEN NEW.scope = 'project' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
  const req = knownUploadRequest();
  const response = await handleAudioRequest(req, f);
  assert.equal(response.status, 503);
  assert.equal(req.bodyUsed, false);
  assert.equal(f.db.rows().length, 0);
  assert.deepEqual(rateRows(f.db), []);
  assert.equal(f.bucket.calls.length, 0);
});

test('unknown reservation acknowledgment preserves aggregate quota and rate but never starts body or R2', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_max_objects: 1 });
  f.db.fault = { match: (sql) => sql.startsWith('INSERT INTO storybank_audio'), after: true };
  const req = knownUploadRequest();
  assert.equal((await handleAudioRequest(req, f)).status, 503);
  assert.equal(req.bodyUsed, false);
  assert.equal(f.db.rows().length, 1);
  assert.equal(rateRows(f.db).find((row) => row.scope === 'owner').attempts, 1);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  assert.equal(f.bucket.calls.length, 0);
});

test('empty, aborted, and oversize bodies release no-object reservations but do not refund rate', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_window_attempts: 3 });
  const aborted = new ReadableStream({ pull(controller) { controller.error(new Error('Synthetic transport abort')); } });
  for (const body of [new Uint8Array(), aborted, new Uint8Array(AUDIO_MAX_BYTES + 1)]) {
    const result = await upload(f, ALICE, { body });
    assert.notEqual(result.response.status, 201);
    assert.equal(f.db.rows().length, 0);
  }
  assert.equal(f.bucket.calls.length, 0);
  const req = knownUploadRequest();
  const limited = await handleAudioRequest(req, f);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, 'AUDIO_UPLOAD_RATE_LIMITED');
  assert.equal(req.bodyUsed, false);
  assert.equal(rateRows(f.db).find((row) => row.scope === 'owner').attempts, 3);
});

test('failed release before put conservatively retains quota without claiming object deletion', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_max_objects: 1 });
  f.db.fault = { match: (sql) => sql.startsWith('DELETE FROM storybank_audio'), before: true };
  assert.equal((await upload(f, ALICE, { body: new Uint8Array() })).response.status, 400);
  assert.equal(f.db.rows().length, 1);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  assert.equal(f.bucket.calls.length, 0);
});

test('uncertain puts and incomplete cleanup retain quota, even when best-effort deletion succeeds', async (t) => {
  for (const failure of ['before', 'after']) {
    const f = fixture(t);
    policy(f.db, { owner_max_objects: 1 });
    f.bucket.failPut = failure;
    assert.equal((await upload(f)).response.status, 503);
    assert.equal(f.db.rows()[0].status, 'deleting');
    assert.equal((await cleanupOwnerAudio(f)).remaining, 1);
    const refused = await handleAudioRequest(knownUploadRequest(), f);
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error, 'AUDIO_OWNER_QUOTA_REACHED');
    assert.equal(f.bucket.calls.filter((call) => call.operation === 'put').length, 1);
  }
});

test('quota is freed only after confirmed R2 removal and confirmed metadata erasure', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_max_objects: 1 });
  const { body: { id } } = await upload(f);
  const remove = () => handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE' }), f);
  f.bucket.failDelete = 'after';
  assert.equal((await remove()).status, 503);
  assert.equal(f.bucket.objects.size, 0);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  f.db.fault = { match: (sql) => sql.startsWith('DELETE FROM storybank_audio'), before: true };
  assert.equal((await remove()).status, 503);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  assert.equal((await remove()).status, 200);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 201);
  // Two admitted uploads, not a fresh rate allowance after deletion.
  assert.equal(rateRows(f.db).find((row) => row.scope === 'owner').attempts, 2);
});

test('rate windows are durable, owner-isolated, globally bounded, and do not reset on deletion', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_window_attempts: 1, project_window_attempts: 2 });
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 201);
  await cleanupOwnerAudio(f);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  assert.equal((await handleAudioRequest(knownUploadRequest(BOB), { ...f, user: BOB })).status, 201);
  const third = { userId: 'synthetic-third' };
  const blocked = knownUploadRequest(third);
  assert.equal((await handleAudioRequest(blocked, { ...f, user: third })).status, 429);
  assert.equal(blocked.bodyUsed, false);
  f.db.nowSeconds += 599;
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  f.db.nowSeconds += 1;
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 201);
  assert.equal(rateRows(f.db).length, 2); // Previous owners are pruned on admission.
  assert.ok(rateRows(f.db).every((row) => row.attempts === 1 && row.window_start === f.db.nowSeconds));
  f.db.nowSeconds -= 1200;
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
});

test('simultaneous rate reservations allow only the bounded owner/project budget', async (t) => {
  for (const ownerScoped of [true, false]) {
    const f = fixture(t);
    policy(f.db, { owner_window_attempts: ownerScoped ? 2 : 12, project_window_attempts: ownerScoped ? 120 : 2 });
    const users = Array.from({ length: 10 }, (_, index) => ownerScoped ? ALICE : { userId: `synthetic-rate-${index}` });
    const requests = users.map(knownUploadRequest);
    const responses = await Promise.all(requests.map((req, index) => handleAudioRequest(req, { ...f, user: users[index] })));
    assert.equal(responses.filter((response) => response.status === 201).length, 2);
    for (const [index, response] of responses.entries()) if (response.status !== 201) {
      assert.equal(response.status, 429);
      assert.equal((await response.json()).error, 'AUDIO_UPLOAD_RATE_LIMITED');
      assert.equal(requests[index].bodyUsed, false);
    }
    assert.equal(rateRows(f.db).find((row) => row.scope === 'project').attempts, 2);
  }
});

test('missing policy or migration trigger fails closed before reading or storing bytes', async (t) => {
  for (const sql of ['DROP TABLE storybank_audio_policy', 'DELETE FROM storybank_audio_policy', 'DROP TRIGGER audio_reserve_budget', 'DROP TRIGGER audio_charge_attempt', 'DROP TRIGGER audio_reservation_immutable']) {
    const f = fixture(t);
    f.db.sqlite.exec(sql);
    const req = knownUploadRequest();
    assert.equal((await handleAudioRequest(req, f)).status, 503);
    assert.equal(req.bodyUsed, false);
    assert.equal(f.db.rows().length, 0);
    assert.equal(f.bucket.calls.length, 0);
  }
});

test('migration accounts for old active and incomplete reservations without deleting them', (t) => {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../hosted/drizzle/0001_gorgeous_dragon_lord.sql', import.meta.url), 'utf8'));
  const old = seedIncomplete({ sqlite });
  sqlite.exec(readFileSync(new URL('../hosted/drizzle/0003_audio_resource_limits.sql', import.meta.url), 'utf8'));
  policy({ sqlite }, { owner_max_objects: 1 });
  assert.throws(() => seedIncomplete({ sqlite }), /STORYBANK_AUDIO_OWNER_QUOTA/);
  assert.equal(sqlite.prepare('SELECT id FROM storybank_audio').get().id, old.id);
  assert.deepEqual(rateRows({ sqlite }), []);
  assert.throws(() => sqlite.prepare('UPDATE storybank_audio SET size = size + 1').run(), /STORYBANK_AUDIO_RESERVATION_IMMUTABLE/);
});

test('cleanup during body consumption holds quota until the uploader proves no put can start', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_max_objects: 1 });
  const reading = deferred();
  const finishRead = deferred();
  const body = new ReadableStream({ async pull(controller) {
    reading.resolve();
    await finishRead.promise;
    controller.enqueue(bytes);
    controller.close();
  } }, { highWaterMark: 0 });
  const pending = upload(f, ALICE, { body });
  await reading.promise;
  assert.equal(f.db.rows()[0].size, AUDIO_MAX_BYTES);
  assert.equal((await cleanupOwnerAudio(f)).remaining, 1);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 429);
  finishRead.resolve();
  const cancelled = await pending;
  assert.equal(cancelled.response.status, 409);
  assert.equal(cancelled.body.error, 'AUDIO_UPLOAD_CANCELLED');
  assert.equal(f.db.rows().length, 0);
  assert.equal(f.bucket.calls.filter((call) => call.operation === 'put').length, 0);
  assert.equal((await handleAudioRequest(knownUploadRequest(), f)).status, 201);
});

test('resize failures before or after commit release only no-put reservations and retain rate charges', async (t) => {
  for (const timing of ['before', 'after']) {
    const f = fixture(t);
    f.db.fault = { match: (sql) => sql.includes('SET size = ?'), [timing]: true };
    const failed = await upload(f);
    assert.equal(failed.response.status, 503);
    assert.equal(failed.body.error, 'AUDIO_STORAGE_OUTCOME_UNKNOWN');
    assert.equal(f.db.rows().length, 0);
    assert.equal(f.bucket.calls.length, 0);
    assert.equal(rateRows(f.db).find((row) => row.scope === 'owner').attempts, 1);
  }
});

test('malformed reservation acknowledgments never cause body consumption, R2 writes, or automatic retries', async (t) => {
  for (const result of [{ success: false }, { success: true }, { success: true, results: [{ owner_id: 'foreign', id: 'wrong', size: 8 }] }]) {
    const f = fixture(t);
    f.db.fault = { match: (sql) => sql.startsWith('INSERT INTO storybank_audio'), result };
    const req = knownUploadRequest();
    const response = await handleAudioRequest(req, f);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, 'AUDIO_STORAGE_OUTCOME_UNKNOWN');
    assert.equal(req.bodyUsed, false);
    assert.equal(f.bucket.calls.length, 0);
    assert.equal(f.db.rows().length, 1);
    assert.equal(f.db.calls.filter((call) => call.sql.startsWith('INSERT INTO storybank_audio')).length, 1);
  }
});

test('audio reads fail closed on missing or foreign deployment configuration before database access', async (t) => {
  const f = fixture(t);
  const before = f.db.calls.length;
  for (const [req, env, status] of [[request(), {}, 503], [request('/api/audio', { origin: 'https://foreign.example' }), ENV, 403]]) {
    assert.equal((await handleAudioRequest(req, { ...f, env })).status, status);
  }
  assert.equal(f.db.calls.length, before);
  assert.equal(f.bucket.calls.length, 0);
});

test('missing and foreign workspace preconditions reject audio mutations before consuming bodies or charging budgets', async (t) => {
  const f = fixture(t);
  const { body: { id } } = await upload(f);
  const originalRows = f.db.rows();
  const originalRates = rateRows(f.db);
  const dbCalls = f.db.calls.length;
  const bucketCalls = f.bucket.calls.length;
  for (const method of ['POST', 'DELETE']) {
    for (const workspace of [null, '', `personal_${createHash('sha256').update(BOB.userId).digest('hex')}`]) {
      const req = request(method === 'POST' ? '/api/audio' : `/api/audio/${id}`, { method, ...(method === 'POST' ? { body: bytes } : {}) });
      if (workspace === null) req.headers.delete('x-storybank-workspace');
      else req.headers.set('x-storybank-workspace', workspace);
      const response = await handleAudioRequest(req, f);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'WORKSPACE_CHANGED');
      assert.equal(req.bodyUsed, false);
    }
  }
  assert.equal(f.db.calls.length, dbCalls);
  assert.equal(f.bucket.calls.length, bucketCalls);
  assert.deepEqual(f.db.rows(), originalRows);
  assert.deepEqual(rateRows(f.db), originalRates);
});

test('malformed upload headers never consume either owner or project budgets', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_window_attempts: 1, project_window_attempts: 1 });
  for (const [headers, status] of [
    [{ 'content-type': 'text/html' }, 415],
    [{ 'content-encoding': 'gzip' }, 415],
    [{ 'content-length': '0' }, 400],
    [{ 'content-length': '9007199254740992' }, 413],
    [{ 'content-length': '8, 8' }, 413],
    [{ 'content-length': '+8' }, 413],
  ]) {
    const req = request('/api/audio', { method: 'POST', body: bytes, headers });
    assert.equal((await handleAudioRequest(req, f)).status, status);
    assert.equal(req.bodyUsed, false);
  }
  assert.deepEqual(f.db.rows(), []);
  assert.deepEqual(rateRows(f.db), []);
  assert.equal(f.db.calls.length, 0);
  assert.equal(f.bucket.calls.length, 0);
  assert.equal((await handleAudioRequest(knownUploadRequest(BOB), { ...f, user: BOB })).status, 201);
  assert.equal(rateRows(f.db).find((row) => row.scope === 'project').attempts, 1);
  assert.equal(rateRows(f.db).some((row) => row.subject === ALICE.userId), false);
});

test('a short upload body releases shared storage quota while retaining only its admitted attempt charges', async (t) => {
  const f = fixture(t);
  policy(f.db, { owner_window_attempts: 1, project_window_attempts: 2, project_max_bytes: bytes.length, project_max_objects: 1 });
  const short = await upload(f, ALICE, { body: bytes.slice(0, -1), headers: { 'content-length': String(bytes.length) } });
  assert.equal(short.response.status, 400);
  assert.equal(short.body.error, 'AUDIO_LENGTH_MISMATCH');
  assert.deepEqual(f.db.rows(), []);
  assert.equal(f.bucket.calls.length, 0);
  const aliceRetry = knownUploadRequest();
  const refused = await handleAudioRequest(aliceRetry, f);
  assert.equal(refused.status, 429);
  assert.equal((await refused.json()).error, 'AUDIO_UPLOAD_RATE_LIMITED');
  assert.equal(aliceRetry.bodyUsed, false);
  assert.equal((await handleAudioRequest(knownUploadRequest(BOB), { ...f, user: BOB })).status, 201);
  assert.equal(f.db.rows().length, 1);
  assert.equal(f.db.rows()[0].owner_id, BOB.userId);
  assert.equal(rateRows(f.db).find((row) => row.scope === 'project').attempts, 2);
  assert.equal(rateRows(f.db).find((row) => row.scope === 'owner' && row.subject === ALICE.userId).attempts, 1);
  assert.equal(f.bucket.calls.filter((call) => call.operation === 'put').length, 1);
});

test('failed deletion retains shared project quota and foreign cleanup cannot release it', async (t) => {
  for (const limit of [{ project_max_bytes: bytes.length }, { project_max_objects: 1 }]) {
    for (const timing of ['before', 'after']) {
      const f = fixture(t);
      policy(f.db, limit);
      const uploaded = await handleAudioRequest(knownUploadRequest(), f);
      assert.equal(uploaded.status, 201);
      const { id } = await uploaded.json();
      f.bucket.failDelete = timing;
      const remove = () => handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE' }), f);
      const failed = await remove();
      assert.equal(failed.status, 503);
      assert.equal((await failed.json()).error, 'AUDIO_DELETE_PENDING');
      assert.equal(f.db.rows()[0].status, 'deleting');
      const bucketCalls = f.bucket.calls.length;
      const foreignDelete = await handleAudioRequest(request(`/api/audio/${id}`, { method: 'DELETE', user: BOB }), { ...f, user: BOB });
      assert.deepEqual(await foreignDelete.json(), { deleted: true, remaining: 0 });
      assert.deepEqual(await cleanupOwnerAudio({ ...f, user: BOB }), { deleted: 0, remaining: 0, failures: [] });
      assert.equal(f.bucket.calls.length, bucketCalls);
      const blocked = knownUploadRequest(BOB);
      const refused = await handleAudioRequest(blocked, { ...f, user: BOB });
      assert.equal(refused.status, 429);
      assert.equal((await refused.json()).error, 'AUDIO_PROJECT_QUOTA_REACHED');
      assert.equal(blocked.bodyUsed, false);
      assert.equal(rateRows(f.db).find((row) => row.scope === 'project').attempts, 1);
      assert.equal((await remove()).status, 200);
      assert.equal((await handleAudioRequest(knownUploadRequest(BOB), { ...f, user: BOB })).status, 201);
      assert.equal(f.db.rows().length, 1);
      assert.equal(f.db.rows()[0].owner_id, BOB.userId);
      assert.equal(rateRows(f.db).find((row) => row.scope === 'project').attempts, 2);
    }
  }
});

test('audio collection rejects a stale or missing displayed workspace before reading private metadata', async t => {
  const f = fixture(t); const count = f.db.calls.length;
  for (const workspace of [null, '', `personal_${createHash('sha256').update(BOB.userId).digest('hex')}`]) {
    const req = request(); if (workspace === null) req.headers.delete('x-storybank-workspace'); else req.headers.set('x-storybank-workspace', workspace);
    const response = await handleAudioRequest(req, f); assert.equal(response.status, 409); assert.equal((await response.json()).error, 'WORKSPACE_CHANGED');
  }
  assert.equal(f.db.calls.length, count); assert.equal(f.bucket.calls.length, 0);
});
