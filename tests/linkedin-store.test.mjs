// All provider responses/identities/credentials in this suite are synthetic.
// Real SQLite exercises SQL/triggers, not a live D1 deployment or LinkedIn.
import test from 'node:test';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { createD1Fixture } from './support/d1-fixture.mjs';
import { createD1StoryBank, personalWorkspaceId } from '../server/hosted-d1.mjs';
import { hostedContext } from '../server/hosted-http.mjs';
import { handleLinkedInRequest } from '../server/linkedin-http.mjs';
import { createLinkedInStore } from '../server/linkedin-store.mjs';
import { linkedinConfiguration, sha256 } from '../server/linkedin-provider.mjs';

const code = (expected) => (error) => error.code === expected;
const ALICE = { userId: 'synthetic-alice', displayName: 'Synthetic Alice' };
const BOB = { userId: 'synthetic-bob', displayName: 'Synthetic Bob' };
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
function fixture(t, extra = {}) {
  const f = createD1Fixture();
  f.sqlite.exec(readFileSync(new URL('../hosted/drizzle/0002_linkedin_publishing.sql', import.meta.url), 'utf8'));
  t.after(() => f.close());
  let now = NOW; const requests = [];
  const env = { ...TEST_DEPLOYMENT_ENV, LINKEDIN_CLIENT_ID: 'synthetic-client', LINKEDIN_CLIENT_SECRET: 'synthetic-client-secret', LINKEDIN_TOKEN_KEY: randomBytes(32).toString('base64'), LINKEDIN_OAUTH_ENABLED: 'true', LINKEDIN_PUBLISHING_ENABLED: 'true', ...extra };
  const config = linkedinConfiguration(env);
  let fetchImpl = async () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123456789' } });
  const fetcher = async (...args) => { requests.push(args); return fetchImpl(...args); };
  const store = createLinkedInStore({ db: f.db, config, fetcher, clock: () => now });
  function domain(user = ALICE) { const { authority, context } = hostedContext(user); const service = createD1StoryBank({ db: f.db, authority, clock: () => new Date(now) }); return (operation, ...args) => service.invoke(context, operation, args); }
  async function attempt(user = ALICE) {
    const stateHash = sha256(randomUUID()); const cookieHash = sha256(randomUUID());
    await store.storeOAuthAttempt(user, { stateHash, cookieHash, nonceHash: sha256('synthetic-nonce'), verifierCiphertext: 'synthetic-envelope' });
    await store.consumeOAuthAttempt(user, { stateHash, cookieHash });
    return { stateHash, cookieHash };
  }
  async function connect(user = ALICE, subject = 'syntheticMember') {
    const pending = await attempt(user);
    return store.saveConnection(user, { subject, personUrn: `urn:li:person:${subject}`, displayName: `Synthetic ${subject}`, accessToken: 'synthetic-provider-token-never-live', expiresAt: now + 60 * 86400_000, scopes: 'openid profile w_member_social' }, pending);
  }
  async function prepared({ user = ALICE, text = '𝗔 real supplied fact. #tag @someone | [test] 𝘪𝘵𝘢𝘭𝘪𝘤', mode = 'now', dueAt = new Date(now).toISOString(), timeZone = 'UTC' } = {}) {
    const connection = (await store.status(user)).connection ?? await connect(user, user === BOB ? 'syntheticBob' : 'syntheticMember');
    const call = domain(user);
    const story = await call('createStory', { title: 'Synthetic integration fixture', text, destinationId: connection.personUrn });
    const approval = await call('approveStory', story.id, { expectedRevision: story.revision });
    const publication = { storyId: story.id, expectedRevision: story.revision, visibility: 'PUBLIC', dueAt, timeZone, mode };
    const preview = await store.preview(user, publication);
    const request = { publication, previewHash: preview.hash, idempotencyKey: randomUUID(), confirmation: 'PUBLISH_EXACT_VERSION' };
    return { story, approval, publication, preview, request, call, connection };
  }
  return { ...f, env, config, store, domain, prepared, connect, attempt, requests, fetcher, setFetch(value) { fetchImpl = value; }, now: () => now, advance(ms) { now += ms; } };
}

test('synthetic durable publication preserves exact Unicode, stores encrypted token and records provider URN once', async (t) => {
  const f = fixture(t); const s = await f.prepared();
  const job = await f.store.enqueue(ALICE, s.request);
  assert.equal(job.snapshot.text, s.approval.record.snapshot.text);
  assert.equal(job.snapshot_hash, s.preview.hash);
  const row = f.sqlite.prepare('SELECT * FROM storybank_linkedin_connections').get();
  assert.ok(!row.token_ciphertext.includes('synthetic-provider-token'));
  assert.ok(!JSON.stringify(await f.store.status(ALICE)).includes('token_ciphertext'));
  const result = await f.store.dispatch(ALICE, job.id);
  assert.equal(result.status, 'published'); assert.equal(result.attempts, 1); assert.equal(result.post_urn, 'urn:li:share:123456789');
  assert.equal(f.requests.length, 1);
  const body = JSON.parse(f.requests[0][1].body);
  assert.equal(body.author, s.connection.personUrn);
  assert.equal(body.commentary, '𝗔 real supplied fact. \\#tag \\@someone \\| \\[test\\] 𝘪𝘵𝘢𝘭𝘪𝘤');
  assert.equal((await f.store.enqueue(ALICE, s.request)).id, job.id);
  await f.store.dispatch(ALICE, job.id); assert.equal(f.requests.length, 1);
});

test('synthetic queue is owner isolated and rejects modified approval/hash/destination', async (t) => {
  const f = fixture(t); const s = await f.prepared();
  await assert.rejects(f.store.enqueue(ALICE, { ...s.request, previewHash: '0'.repeat(64) }), code('PREVIEW_CHANGED'));
  await assert.rejects(f.store.preview(BOB, s.publication), code('LINKEDIN_RECONNECT_REQUIRED'));
  const job = await f.store.enqueue(ALICE, s.request);
  await assert.rejects(f.store.dispatch(BOB, job.id), code('NOT_FOUND'));
  await assert.rejects(f.store.cancel(BOB, job.id), code('NOT_FOUND'));
  assert.deepEqual((await f.store.status(BOB)).jobs, []);
  await s.call('updateStory', s.story.id, { destinationId: 'urn:li:person:wrong' }, { expectedRevision: 1 });
  assert.equal((await f.store.status(ALICE)).jobs[0].status, 'cancelled');
  assert.equal(f.requests.length, 0);
});

test('synthetic exact content edit/revocation cancels queued version; old final review cannot publish', async (t) => {
  const f = fixture(t); const s = await f.prepared();
  const job = await f.store.enqueue(ALICE, s.request);
  await s.call('updateStory', s.story.id, { text: 'Changed exact Unicode: 𝗕' }, { expectedRevision: 1 });
  assert.equal((await f.store.dispatch(ALICE, job.id)).status, 'cancelled');
  await assert.rejects(f.store.enqueue(ALICE, { ...s.request, idempotencyKey: randomUUID() }), code('APPROVAL_REQUIRED'));
  const other = await f.prepared({ text: 'Second synthetic story.' });
  const second = await f.store.enqueue(ALICE, other.request);
  await other.call('revokeApproval', other.story.id);
  assert.equal((await f.store.dispatch(ALICE, second.id)).status, 'cancelled');
  assert.equal(f.requests.length, 0);
});

test('synthetic concurrent dispatch reserves only one provider call and blocks edit/cancel/disconnect in flight', async (t) => {
  const f = fixture(t); const s = await f.prepared(); const job = await f.store.enqueue(ALICE, s.request);
  let release; const gate = new Promise((r) => { release = r; });
  let entered; const started = new Promise((r) => { entered = r; });
  f.setFetch(async () => { entered(); await gate; return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:ugcPost:99' } }); });
  const first = f.store.dispatch(ALICE, job.id); await started;
  assert.equal((await f.store.dispatch(ALICE, job.id)).status, 'sending');
  await assert.rejects(s.call('updateStory', s.story.id, { text: 'Race update' }, { expectedRevision: 1 }), code('PUBLISH_IN_FLIGHT'));
  await assert.rejects(f.store.cancel(ALICE, job.id), code('CANNOT_CANCEL'));
  await assert.rejects(f.store.disconnect(ALICE), code('PUBLISH_IN_FLIGHT'));
  release(); assert.equal((await first).status, 'published'); assert.equal(f.requests.length, 1);
  await s.call('updateStory', s.story.id, { text: 'Allowed after result.' }, { expectedRevision: 1 });
});

test('synthetic ambiguous provider outcome never retries or permits duplicate content', async (t) => {
  const f = fixture(t); const s = await f.prepared(); const job = await f.store.enqueue(ALICE, s.request);
  f.setFetch(async () => { throw new Error('synthetic network timeout'); });
  assert.equal((await f.store.dispatch(ALICE, job.id)).status, 'unknown');
  await f.store.dispatch(ALICE, job.id); assert.equal(f.requests.length, 1);
  const duplicate = await f.prepared();
  await assert.rejects(f.store.enqueue(ALICE, duplicate.request), code('DUPLICATE_PUBLICATION'));
  await assert.rejects(f.store.cancel(ALICE, job.id), code('CANNOT_CANCEL'));
});

test('synthetic crashed lease recovers to unknown, never requeues, and releases edit lock', async (t) => {
  const f = fixture(t); const s = await f.prepared(); const job = await f.store.enqueue(ALICE, s.request);
  f.sqlite.prepare("UPDATE storybank_linkedin_jobs SET status='sending', lease_id='synthetic', lease_until=?, attempts=1 WHERE id=?").run(f.now() + 1000, job.id);
  f.advance(1001);
  assert.equal((await f.store.status(ALICE)).jobs[0].status, 'unknown');
  await f.store.dispatch(ALICE, job.id); assert.equal(f.requests.length, 0);
  await s.call('updateStory', s.story.id, { text: 'Edit after interrupted dispatch.' }, { expectedRevision: 1 });
});

test('synthetic disconnect deletes token and cancels queue without claiming grant revocation', async (t) => {
  const f = fixture(t); const s = await f.prepared(); await f.store.enqueue(ALICE, s.request);
  const result = await f.store.disconnect(ALICE);
  assert.equal(result.remoteGrantRevoked, false);
  const state = await f.store.status(ALICE); assert.equal(state.connection, null); assert.equal(state.jobs[0].status, 'cancelled');
});

test('synthetic cancellation consumes its final approval; a deliberate fresh review can prepare again', async (t) => {
  const f = fixture(t); const s = await f.prepared(); const job = await f.store.enqueue(ALICE, s.request);
  assert.equal((await f.store.cancel(ALICE, job.id)).status, 'cancelled');
  assert.equal((await f.store.enqueue(ALICE, s.request)).status, 'cancelled');
  await assert.rejects(f.store.enqueue(ALICE, { ...s.request, idempotencyKey: randomUUID() }), code('DUPLICATE_PUBLICATION'));
  await s.call('approveStory', s.story.id, { expectedRevision: s.story.revision });
  const preview = await f.store.preview(ALICE, s.publication);
  const fresh = await f.store.enqueue(ALICE, { ...s.request, previewHash: preview.hash, idempotencyKey: randomUUID() });
  assert.equal(fresh.status, 'queued'); assert.notEqual(fresh.source_approval_id, job.source_approval_id); assert.equal(f.requests.length, 0);
});

test('synthetic reconnect changes generation and cancels old queued posts even for the same LinkedIn identity', async (t) => {
  const f = fixture(t); const s = await f.prepared(); await f.store.enqueue(ALICE, s.request);
  const reconnected = await f.connect(); assert.notEqual(reconnected.connectionId, s.connection.connectionId);
  assert.equal((await f.store.status(ALICE)).jobs[0].status, 'cancelled');
  await assert.rejects(f.store.enqueue(ALICE, { ...s.request, idempotencyKey: randomUUID() }), code('PREVIEW_CHANGED'));
});

test('synthetic OAuth attempt is owner/browser-bound, one-use, expiring and replacement-safe', async (t) => {
  const f = fixture(t); const stateHash = sha256('state'), cookieHash = sha256('browser');
  await f.store.storeOAuthAttempt(ALICE, { stateHash, cookieHash, nonceHash: sha256('nonce'), verifierCiphertext: 'synthetic' });
  await assert.rejects(f.store.consumeOAuthAttempt(BOB, { stateHash, cookieHash }), code('OAUTH_STATE_INVALID'));
  await assert.rejects(f.store.consumeOAuthAttempt(ALICE, { stateHash, cookieHash: sha256('wrong') }), code('OAUTH_STATE_INVALID'));
  await f.store.consumeOAuthAttempt(ALICE, { stateHash, cookieHash });
  await assert.rejects(f.store.consumeOAuthAttempt(ALICE, { stateHash, cookieHash }), code('OAUTH_STATE_INVALID'));
  await f.store.storeOAuthAttempt(ALICE, { stateHash, cookieHash, nonceHash: sha256('nonce'), verifierCiphertext: 'synthetic' });
  f.advance(600001);
  await assert.rejects(f.store.consumeOAuthAttempt(ALICE, { stateHash, cookieHash }), code('OAUTH_STATE_INVALID'));
});

test('synthetic disconnected/replaced OAuth attempt cannot resurrect credentials after async callback', async (t) => {
  const f = fixture(t); const pending = await f.attempt();
  await f.store.disconnect(ALICE);
  const connection = { subject: 'synthetic', personUrn: 'urn:li:person:synthetic', displayName: 'Synthetic', accessToken: 'synthetic-token-long', expiresAt: f.now() + 1000000, scopes: 'openid profile w_member_social' };
  await assert.rejects(f.store.saveConnection(ALICE, connection, pending), code('OAUTH_CANCELLED'));
  const old = await f.attempt(); await f.attempt();
  await assert.rejects(f.store.saveConnection(ALICE, connection, old), code('OAUTH_CANCELLED'));
  assert.equal((await f.store.status(ALICE)).connection, null);
});

test('synthetic own-data deletion erases connections, pending OAuth and publication content, including initially empty workspace', async (t) => {
  const f = fixture(t); const s = await f.prepared(); await f.store.enqueue(ALICE, s.request); await f.attempt();
  await s.call('deleteOwnData');
  for (const table of ['storybank_linkedin_oauth', 'storybank_linkedin_connections', 'storybank_linkedin_jobs']) assert.equal(f.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  await f.connect(BOB, 'newSynthetic'); await f.attempt(BOB); await f.domain(BOB)('deleteOwnData');
  assert.equal((await f.store.status(BOB)).connection, null);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM storybank_linkedin_oauth').get().n, 0);
});

test('synthetic scheduling is unavailable by default, timezone/DST offsets and connection expiry are enforced', async (t) => {
  const f = fixture(t); const s = await f.prepared();
  await assert.rejects(f.store.preview(ALICE, { ...s.publication, mode: 'scheduled', dueAt: '2026-10-24T12:00:00Z' }), code('SCHEDULER_UNAVAILABLE'));
  await assert.rejects(f.store.preview(ALICE, { ...s.publication, dueAt: '2026-02-30T12:00:00Z' }), code('INVALID_DATE'));
  await assert.rejects(f.store.preview(ALICE, { ...s.publication, timeZone: 'Asia/Kolkata' }), code('TIMEZONE_MISMATCH'));
  const g = fixture(t, { LINKEDIN_SCHEDULER_VERIFIED: 'true', LINKEDIN_RUNNER_ENABLED: 'true', LINKEDIN_RUNNER_OWNER_ID: ALICE.userId, LINKEDIN_RUNNER_TOKEN_SHA256: sha256('synthetic-runner-secret') });
  const scheduled = await g.prepared({ mode: 'scheduled', dueAt: '2026-10-24T17:30:00+05:30', timeZone: 'Asia/Kolkata' });
  assert.equal(scheduled.preview.snapshot.dueAt, '2026-10-24T12:00:00.000Z');
  const queued = await g.store.enqueue(ALICE, scheduled.request);
  assert.equal((await g.store.dispatch(ALICE, queued.id)).status, 'queued'); assert.equal(g.requests.length, 0);
  await assert.rejects(g.store.preview(ALICE, { ...scheduled.publication, dueAt: '2027-01-01T17:30:00+05:30' }), code('CONNECTION_EXPIRES_BEFORE_POST'));
});

test('synthetic HTTP endpoints enforce session, origin, workspace, exact consent and never expose provider secrets', async (t) => {
  const f = fixture(t);
  const request = (path, body, headers = {}) => new Request(TEST_SITE_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin: TEST_SITE_ORIGIN, 'x-storybank-request': '1', 'x-storybank-workspace': personalWorkspaceId(ALICE.userId), 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const call = (req, options = {}) => handleLinkedInRequest(req, { user: ALICE, db: f.db, env: f.env, clock: f.now, ...options });
  assert.equal((await call(request('/api/linkedin/status'), { user: null })).status, 401);
  for (const headers of [{ origin: 'https://evil.invalid' }, { 'x-storybank-workspace': personalWorkspaceId(BOB.userId) }]) assert.ok([403, 409].includes((await call(request('/api/linkedin/connect', { confirmation: 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING' }, headers))).status));
  assert.equal((await call(request('/api/linkedin/connect', {}))).status, 409);
  const response = await call(request('/api/linkedin/connect', { confirmation: 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING' }, {
    host: 'foreign.storybank.example', 'x-forwarded-host': 'foreign.storybank.example',
    forwarded: 'host=foreign.storybank.example;proto=http', 'x-forwarded-proto': 'http',
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Lax/);
  const data = await response.json(); const url = new URL(data.authorizationUrl);
  assert.equal(url.origin, 'https://www.linkedin.com'); assert.equal(url.searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(url.searchParams.get('redirect_uri'), `${TEST_SITE_ORIGIN}/api/linkedin/callback`);
  assert.ok(!JSON.stringify(data).includes('synthetic-client-secret'));
  assert.equal((await call(request('/api/linkedin/callback?state=' + url.searchParams.get('state') + '&code=synthetic'))).status, 403);
  const status = await call(request('/api/linkedin/status')); assert.equal(status.status, 200); assert.ok(!(await status.text()).includes('synthetic-client-secret'));
});

test('synthetic simultaneous connect requests leave only one current owner attempt', async (t) => {
  const f = fixture(t);
  const attempts = Array.from({ length: 5 }, () => ({ stateHash: sha256(randomUUID()), cookieHash: sha256(randomUUID()), nonceHash: sha256(randomUUID()), verifierCiphertext: 'synthetic' }));
  await Promise.all(attempts.map((attempt) => f.store.storeOAuthAttempt(ALICE, attempt)));
  const rows = f.sqlite.prepare('SELECT * FROM storybank_linkedin_oauth').all(); assert.equal(rows.length, 1);
  for (const attempt of attempts.filter((value) => value.stateHash !== rows[0].state_hash)) await assert.rejects(f.store.consumeOAuthAttempt(ALICE, attempt), code('OAUTH_STATE_INVALID'));
});

test('synthetic delayed reservation response past lease expiry cannot send a post', async (t) => {
  const f = fixture(t); const s = await f.prepared(); const job = await f.store.enqueue(ALICE, s.request);
  const delayed = { prepare(sql) {
    const statement = f.db.prepare(sql);
    return { bind(...args) {
      const bound = statement.bind(...args);
      return { ...bound, async first(...params) {
        const result = await bound.first(...params);
        if (sql.includes("SET status = 'sending'")) { f.advance(90_001); await f.store.status(ALICE); await f.store.disconnect(ALICE); }
        return result;
      } };
    } };
  } };
  const slow = createLinkedInStore({ db: delayed, config: f.config, clock: f.now, fetcher: f.fetcher });
  assert.equal((await slow.dispatch(ALICE, job.id)).status, 'unknown'); assert.equal(f.requests.length, 0);
});

test('synthetic complete HTTP OAuth callback validates signed nonce, stores identity and refuses replay', async (t) => {
  const f = fixture(t); const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-http-key', alg: 'RS256', use: 'sig' };
  const request = (path, body, headers = {}) => new Request(TEST_SITE_ORIGIN + path, { method: body === undefined ? 'GET' : 'POST', headers: { origin: TEST_SITE_ORIGIN, 'x-storybank-request': '1', 'x-storybank-workspace': personalWorkspaceId(ALICE.userId), 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const call = (req) => handleLinkedInRequest(req, { user: ALICE, db: f.db, env: f.env, clock: f.now, fetcher: f.fetcher });
  const begin = await call(request('/api/linkedin/connect', { confirmation: 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING' }));
  const browserCookie = begin.headers.get('set-cookie').split(';')[0];
  const authorization = new URL((await begin.json()).authorizationUrl);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: 'https://www.linkedin.com/oauth', aud: f.env.LINKEDIN_CLIENT_ID, sub: 'syntheticHttpMember', iat: f.now() / 1000, exp: f.now() / 1000 + 300, nonce: authorization.searchParams.get('nonce') })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const idToken = `${signingInput}.${sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url')}`;
  f.setFetch(async (url, options) => {
    if (url.endsWith('/accessToken')) {
      assert.equal(options.body.get('redirect_uri'), `${TEST_SITE_ORIGIN}/api/linkedin/callback`);
      return Response.json({ access_token: 'synthetic-http-access-token', expires_in: 3600, scope: 'openid profile w_member_social', id_token: idToken });
    }
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/userinfo')) return Response.json({ sub: 'syntheticHttpMember', name: 'Synthetic HTTP Member' });
    throw new Error('Unexpected synthetic endpoint');
  });
  const callback = '/api/linkedin/callback?state=' + authorization.searchParams.get('state') + '&code=synthetic-code&redirect_uri=https://foreign.storybank.example/callback';
  const forgedHeaders = { cookie: browserCookie, host: 'foreign.storybank.example', 'x-forwarded-host': 'foreign.storybank.example', forwarded: 'host=foreign.storybank.example;proto=https' };
  const foreign = await call(new Request('https://foreign.storybank.example' + callback, { headers: { ...forgedHeaders, host: 'tester.storybank.example', 'x-forwarded-host': 'tester.storybank.example' } }));
  assert.equal(foreign.status, 403); assert.equal(f.requests.length, 0);
  assert.equal(f.sqlite.prepare('SELECT consumed_at FROM storybank_linkedin_oauth').get().consumed_at, null);
  const complete = await call(request(callback, undefined, forgedHeaders));
  assert.equal(complete.status, 303); assert.equal(complete.headers.get('location'), TEST_SITE_ORIGIN + '/publishing?linkedin=connected');
  assert.equal((await f.store.status(ALICE)).connection.personUrn, 'urn:li:person:syntheticHttpMember');
  const replay = await call(request(callback, undefined, { cookie: browserCookie })); assert.equal(replay.status, 403);
  assert.equal(f.requests.length, 3);
  assert.ok(!(await replay.text()).includes('synthetic-http-access-token'));
});
