// Entirely synthetic credentials, identities and provider responses. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createD1Fixture } from './support/d1-fixture.mjs';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
import { createD1StoryBank } from '../server/hosted-d1.mjs';
import { hostedContext } from '../server/hosted-http.mjs';
import { createLinkedInStore } from '../server/linkedin-store.mjs';
import { linkedinConfiguration, linkedinRunnerConfiguration, publicReadiness, sha256 } from '../server/linkedin-provider.mjs';
import { handleLinkedInRunnerRequest, MAX_SCHEDULE_LATENESS_MS } from '../server/linkedin-runner.mjs';

const ALICE = { userId: 'synthetic-runner-alice' };
const BOB = { userId: 'synthetic-runner-bob' };
const NOW = Date.parse('2026-10-24T10:00:00Z');
function fixture(t) {
  const f = createD1Fixture(); t.after(() => f.close());
  f.sqlite.exec(readFileSync(new URL('../hosted/drizzle/0002_linkedin_publishing.sql', import.meta.url), 'utf8'));
  let now = NOW; const calls = []; const token = randomBytes(32).toString('base64url');
  const env = { ...TEST_DEPLOYMENT_ENV, LINKEDIN_CLIENT_ID: 'synthetic-client', LINKEDIN_CLIENT_SECRET: 'synthetic-secret',
    LINKEDIN_TOKEN_KEY: randomBytes(32).toString('base64'), LINKEDIN_OAUTH_ENABLED: 'true', LINKEDIN_PUBLISHING_ENABLED: 'true',
    LINKEDIN_RUNNER_ENABLED: 'true', LINKEDIN_RUNNER_OWNER_ID: ALICE.userId, LINKEDIN_RUNNER_TOKEN_SHA256: sha256(token), LINKEDIN_SCHEDULER_VERIFIED: 'true' };
  let fetchImpl = async () => new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:77' } });
  const fetcher = async (...args) => { calls.push(args); return fetchImpl(...args); };
  const storeFor = (user = ALICE) => createLinkedInStore({ db: f.db, config: linkedinConfiguration({ ...env, LINKEDIN_RUNNER_OWNER_ID: user.userId }), clock: () => now, fetcher });
  const store = storeFor();
  async function queue({ user = ALICE, mode = 'scheduled', after = 120_000, text = randomUUID() } = {}) {
    const localStore = storeFor(user);
    let connection = (await localStore.status(user)).connection;
    if (!connection) {
      const stateHash = sha256(randomUUID()), cookieHash = sha256(randomUUID());
      await localStore.storeOAuthAttempt(user, { stateHash, cookieHash, nonceHash: sha256('nonce'), verifierCiphertext: 'synthetic' });
      await localStore.consumeOAuthAttempt(user, { stateHash, cookieHash });
      connection = await localStore.saveConnection(user, { subject: user.userId, personUrn: `urn:li:person:${user.userId}`, displayName: 'Synthetic member', accessToken: 'synthetic-access-token-not-live', expiresAt: NOW + 86400_000, scopes: 'openid profile w_member_social' }, { stateHash });
    }
    const { authority, context } = hostedContext(user);
    const service = createD1StoryBank({ db: f.db, authority, clock: () => new Date(now) });
    const invoke = (operation, ...args) => service.invoke(context, operation, args);
    const story = await invoke('createStory', { title: 'Synthetic scheduled story', text, destinationId: connection.personUrn });
    await invoke('approveStory', story.id, { expectedRevision: story.revision });
    const publication = { storyId: story.id, expectedRevision: story.revision, visibility: 'PUBLIC', mode, dueAt: new Date(now + (mode === 'now' ? 0 : after)).toISOString(), timeZone: 'UTC' };
    const preview = await localStore.preview(user, publication);
    const job = await localStore.enqueue(user, { publication, previewHash: preview.hash, idempotencyKey: randomUUID(), confirmation: 'PUBLISH_EXACT_VERSION' });
    return { job, story, invoke, publication, localStore };
  }
  const request = (body = { mode: 'dispatch-one' }, { headers = {}, url = `${TEST_SITE_ORIGIN}/api/linkedin/runner`, method = 'POST' } = {}) => new Request(url, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const call = (body, requestOptions, options = {}) => handleLinkedInRunnerRequest(request(body, requestOptions), { db: f.db, env, clock: () => now, fetcher, ...options });
  return { ...f, env, token, store, queue, calls, request, call, advance(ms) { now += ms; }, setFetch(fn) { fetchImpl = fn; }, now: () => now };
}

test('runner configuration fails closed and scheduler flag alone never advertises readiness', () => {
  assert.equal(linkedinRunnerConfiguration({}).enabled, false);
  for (const owner of ['', ' a', 'a ', 'a\n', 'x'.repeat(501)]) assert.equal(linkedinRunnerConfiguration({ LINKEDIN_RUNNER_OWNER_ID: owner, LINKEDIN_RUNNER_TOKEN_SHA256: '1'.repeat(64), LINKEDIN_RUNNER_ENABLED: 'true' }).enabled, false);
  assert.equal(linkedinConfiguration({ ...TEST_DEPLOYMENT_ENV, LINKEDIN_SCHEDULER_VERIFIED: 'true' }).schedulerVerified, false);
});

test('readiness exposes scheduling only to the configured owner and leaks no runner capability', (t) => {
  const f = fixture(t); const config = linkedinConfiguration(f.env);
  assert.equal(publicReadiness(config, ALICE.userId).schedulerVerified, true);
  assert.equal(publicReadiness(config, BOB.userId).schedulerVerified, false);
  assert.equal(publicReadiness(config).schedulerVerified, false);
  const text = JSON.stringify(publicReadiness(config, ALICE.userId));
  for (const secret of [f.token, f.env.LINKEDIN_RUNNER_TOKEN_SHA256, ALICE.userId]) assert.ok(!text.includes(secret));
});

test('runner rejects missing, bad, combined and URL credentials, even with spoofed visitor identity', async (t) => {
  const f = fixture(t);
  for (const authorization of ['', 'Bearer wrong', `Bearer ${f.token}, Bearer ${f.token}`, `Bearer ${'a'.repeat(43)}`]) {
    const response = await f.call(undefined, { headers: { authorization, 'oai-authenticated-user-id': ALICE.userId } });
    assert.equal(response.status, 401);
  }
  assert.equal((await f.call(undefined, { url: `${TEST_SITE_ORIGIN}/api/linkedin/runner?token=${f.token}` })).status, 404);
  assert.equal(f.calls.length, 0);
});

test('runner validates exact HTTPS origin, POST, service-only headers, strict bounded body', async (t) => {
  const f = fixture(t);
  assert.equal((await f.call(undefined, { method: 'GET' })).status, 404);
  assert.equal((await f.call(undefined, { url: 'https://example.invalid/api/linkedin/runner' })).status, 403);
  assert.equal((await f.call(undefined, { headers: { origin: TEST_SITE_ORIGIN } })).status, 403);
  assert.equal((await f.call(undefined, { headers: { 'sec-fetch-site': 'same-origin' } })).status, 403);
  for (const body of [{}, [], { mode: 'dispatch-one', ownerId: BOB.userId }, { mode: 'dispatch-one', jobId: 'any' }, { mode: 'dispatch-one', text: 'tampered' }, { mode: 'dispatch-one', now: NOW }]) assert.equal((await f.call(body)).status, 400);
  assert.equal((await f.call('{bad')).status, 400);
  assert.equal((await f.call('x'.repeat(1025))).status, 413);
  assert.equal((await f.call(undefined, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal(f.calls.length, 0);
});

test('disabled runner, publishing kill switch and unverified scheduler cannot send', async (t) => {
  const f = fixture(t); await f.queue(); f.advance(120_000);
  for (const key of ['LINKEDIN_RUNNER_ENABLED', 'LINKEDIN_PUBLISHING_ENABLED', 'LINKEDIN_SCHEDULER_VERIFIED']) {
    assert.equal((await f.call(undefined, undefined, { env: { ...f.env, [key]: 'false' } })).status, 503);
  }
  assert.equal(f.calls.length, 0);
});

test('dry-run returns only own aggregate counts without mutation or provider calls', async (t) => {
  const f = fixture(t); const a = await f.queue(); await f.queue({ user: BOB }); f.advance(120_000);
  const before = f.sqlite.prepare('SELECT * FROM storybank_linkedin_jobs ORDER BY id').all();
  const response = await f.call({ mode: 'dry-run' }); const body = await response.json();
  assert.equal(response.status, 200); assert.deepEqual(body.counts, { due: 1, overdue: 0, sending: 0, unknown: 0 });
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM storybank_linkedin_jobs ORDER BY id').all(), before);
  for (const secret of [a.job.id, a.story.text, ALICE.userId, BOB.userId, f.token]) assert.ok(!JSON.stringify(body).includes(secret));
  assert.equal(f.calls.length, 0);
});

test('dry-run is usable before live publication and verified scheduler gates are enabled', async (t) => {
  const f = fixture(t);
  const response = await f.call({ mode: 'dry-run' }, undefined, { env: { ...f.env, LINKEDIN_PUBLISHING_ENABLED: 'false', LINKEDIN_SCHEDULER_VERIFIED: 'false' } });
  assert.equal(response.status, 200); assert.equal((await response.json()).dispatchEnabled, false); assert.equal(f.calls.length, 0);
});

test('runner dispatches only one due scheduled post for its server-bound owner', async (t) => {
  const f = fixture(t); const a = await f.queue(); const b = await f.queue({ user: BOB }); const future = await f.queue({ after: 240_000 }); const immediate = await f.queue({ mode: 'now' });
  assert.equal((await (await f.call()).json()).outcome, 'idle'); f.advance(120_000);
  assert.equal((await (await f.call()).json()).outcome, 'published');
  assert.equal(f.calls.length, 1);
  assert.equal(f.sqlite.prepare('SELECT status FROM storybank_linkedin_jobs WHERE id = ?').get(a.job.id).status, 'published');
  for (const id of [b.job.id, future.job.id, immediate.job.id]) assert.equal(f.sqlite.prepare('SELECT status FROM storybank_linkedin_jobs WHERE id = ?').get(id).status, 'queued');
  assert.equal((await (await f.call()).json()).outcome, 'idle'); assert.equal(f.calls.length, 1);
});

test('another owner cannot preview a scheduled post using globally enabled scheduler flags', async (t) => {
  const f = fixture(t); const bob = await f.queue({ user: BOB });
  await assert.rejects(f.store.preview(BOB, bob.publication), (error) => error.code === 'SCHEDULER_UNAVAILABLE');
});

test('overdue jobs are cancelled rather than posted late after an outage', async (t) => {
  const f = fixture(t); const a = await f.queue(); f.advance(120_000 + MAX_SCHEDULE_LATENESS_MS + 1);
  assert.equal((await (await f.call()).json()).outcome, 'missed_deadline');
  const row = f.sqlite.prepare('SELECT * FROM storybank_linkedin_jobs WHERE id = ?').get(a.job.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.reason, 'scheduled_deadline_missed'); assert.equal(row.attempts, 0); assert.equal(f.calls.length, 0);
});

test('concurrent ticks never duplicate a post and report an in-flight sender as busy', async (t) => {
  const f = fixture(t); await f.queue(); f.advance(120_000);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; });
  f.setFetch(async () => { entered(); await gate; return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:99' } }); });
  const first = f.call(); await started;
  assert.equal((await (await f.call()).json()).outcome, 'busy');
  release(); assert.equal((await (await first).json()).outcome, 'published'); assert.equal(f.calls.length, 1);
});

test('unknown provider result never retries on later ticks', async (t) => {
  const f = fixture(t); await f.queue(); f.advance(120_000); f.setFetch(async () => { throw new Error('synthetic network interruption'); });
  assert.equal((await (await f.call()).json()).outcome, 'unknown');
  assert.equal((await (await f.call()).json()).outcome, 'idle'); assert.equal(f.calls.length, 1);
});

test('stale sending lease becomes unknown without any transmission', async (t) => {
  const f = fixture(t); const a = await f.queue(); f.advance(120_000);
  f.sqlite.prepare("UPDATE storybank_linkedin_jobs SET status='sending', attempts=1, lease_id='synthetic-lease', lease_until=? WHERE id=?").run(f.now() - 1, a.job.id);
  const before = f.sqlite.prepare('SELECT status FROM storybank_linkedin_jobs WHERE id=?').get(a.job.id).status;
  await f.call({ mode: 'dry-run' }); assert.equal(f.sqlite.prepare('SELECT status FROM storybank_linkedin_jobs WHERE id=?').get(a.job.id).status, before);
  assert.equal((await (await f.call()).json()).outcome, 'idle');
  assert.equal(f.sqlite.prepare('SELECT status FROM storybank_linkedin_jobs WHERE id=?').get(a.job.id).status, 'unknown'); assert.equal(f.calls.length, 0);
});

test('source editing, explicit cancellation and disconnect invalidate a scheduled post', async (t) => {
  for (const action of ['edit', 'cancel', 'disconnect']) {
    const f = fixture(t); const a = await f.queue();
    if (action === 'edit') await a.invoke('updateStory', a.story.id, { text: 'Changed' }, { expectedRevision: 1 });
    if (action === 'cancel') await f.store.cancel(ALICE, a.job.id);
    if (action === 'disconnect') await f.store.disconnect(ALICE);
    f.advance(120_000); assert.equal((await (await f.call()).json()).outcome, 'idle'); assert.equal(f.calls.length, 0);
  }
});

test('expired token blocks dispatch without decrypting or transmitting', async (t) => {
  const f = fixture(t); await f.queue(); f.advance(120_000);
  f.sqlite.prepare('UPDATE storybank_linkedin_connections SET expires_at=? WHERE owner_user_id=?').run(f.now(), ALICE.userId);
  const response = await f.call(); assert.equal(response.status, 409); assert.equal((await response.json()).error, 'LINKEDIN_RECONNECT_REQUIRED'); assert.equal(f.calls.length, 0);
});

test('exactly fifteen minutes late is allowed; one millisecond later is not', async (t) => {
  for (const extra of [0, 1]) {
    const f = fixture(t); await f.queue(); f.advance(120_000 + MAX_SCHEDULE_LATENESS_MS + extra);
    assert.equal((await (await f.call()).json()).outcome, extra ? 'missed_deadline' : 'published');
    assert.equal(f.calls.length, extra ? 0 : 1);
  }
});

test('cutoff crossed before reservation cancels with zero attempts', async (t) => {
  const f = fixture(t); const a = await f.queue(); f.advance(120_000 + MAX_SCHEDULE_LATENESS_MS - 1000);
  let connectionReads = 0;
  const db = { prepare(sql) { const statement = f.db.prepare(sql); return { bind(...args) { const bound = statement.bind(...args); return { ...bound, async first(...more) {
    const row = await bound.first(...more);
    if (sql.includes('SELECT * FROM storybank_linkedin_connections') && ++connectionReads === 2) f.advance(2000);
    return row;
  } }; } }; } };
  assert.equal((await (await f.call(undefined, undefined, { db })).json()).outcome, 'cancelled');
  const row = f.sqlite.prepare('SELECT status, attempts FROM storybank_linkedin_jobs WHERE id=?').get(a.job.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.attempts, 0); assert.equal(f.calls.length, 0);
});

test('cutoff crossed after reservation cancels the lease without a provider call', async (t) => {
  const f = fixture(t); const a = await f.queue(); f.advance(120_000 + MAX_SCHEDULE_LATENESS_MS - 1000);
  let delayed = false;
  const db = { prepare(sql) { const statement = f.db.prepare(sql); return { bind(...args) { const bound = statement.bind(...args); return { ...bound, async first(...more) {
    const row = await bound.first(...more);
    if (!delayed && sql.includes("SET status = 'sending'")) { delayed = true; f.advance(2000); }
    return row;
  } }; } }; } };
  assert.equal((await (await f.call(undefined, undefined, { db })).json()).outcome, 'cancelled');
  const row = f.sqlite.prepare('SELECT status, attempts FROM storybank_linkedin_jobs WHERE id=?').get(a.job.id);
  assert.equal(row.status, 'cancelled'); assert.equal(row.attempts, 1); assert.equal(f.calls.length, 0);
  await f.call(); assert.equal(f.calls.length, 0);
});

test('ticks starting at the same instant reserve at most one provider attempt', async (t) => {
  const f = fixture(t); await f.queue(); f.advance(120_000);
  const results = await Promise.all([f.call(), f.call(), f.call()]);
  assert.ok(results.every(response => response.status === 200));
  assert.equal(f.calls.length, 1);
});

test('owner-scoped history keeps an old pending job visible and cancellable after one hundred newer finished jobs', async (t) => {
  const f = fixture(t); const old = await f.queue(); const bob = await f.queue({ user: BOB });
  const row = f.sqlite.prepare('SELECT * FROM storybank_linkedin_jobs WHERE id=?').get(old.job.id);
  const keys = Object.keys(row); const statement = f.sqlite.prepare(`INSERT INTO storybank_linkedin_jobs (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`);
  for (let i = 1; i <= 101; i++) {
    const copy = { ...row, id: `synthetic-history-${i}`, source_approval_id: `synthetic-approval-${i}`, idempotency_key: `synthetic-key-${i}`, status: 'cancelled', created_at: NOW + i };
    statement.run(...keys.map(key => copy[key]));
  }
  const status = await f.store.status(ALICE);
  assert.equal(status.jobs.length, 101); assert.ok(status.jobs.some(job => job.id === old.job.id));
  assert.deepEqual(status.activeStoryIds, [old.story.id]); assert.ok(!status.activeStoryIds.includes(bob.story.id));
  assert.equal((await f.store.cancel(ALICE, old.job.id)).status, 'cancelled');
  assert.deepEqual((await f.store.status(ALICE)).activeStoryIds, []);
  assert.equal(f.calls.length, 0);
});
