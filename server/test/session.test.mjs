import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSessionBoundary, SESSION_COOKIE } from '../session.mjs';
import { StoryBankRepository } from '../repository.mjs';

const code = (expected) => (error) => error.code === expected;
function fixture({ configured = true, ttlMs = 60_000 } = {}) {
  let time = Date.parse('2026-10-22T12:00:00Z');
  const records = new Map();
  const memberships = new Map([
    ['alice', [{ tenantId: 'alpha', role: 'owner' }]],
    ['bob', [{ tenantId: 'beta', role: 'owner' }]],
    ['viewer', [{ tenantId: 'alpha', role: 'viewer' }]],
  ]);
  const store = {
    put(record) { if (records.has(record.tokenDigest)) throw new Error('Duplicate'); records.set(record.tokenDigest, structuredClone(record)); },
    getByDigest(hash) { return structuredClone(records.get(hash) ?? null); },
    deleteByDigest(hash) { records.delete(hash); },
    deleteForUser(subject) { for (const [key, record] of records) if (record.subject === subject) records.delete(key); },
  };
  // Test-only verification: production default intentionally rejects sign-in.
  const verifier = (evidence) => {
    if (!['alice', 'bob', 'viewer'].includes(evidence)) throw Object.assign(new Error('Invalid'), { code: 'UNAUTHENTICATED' });
    return { subject: evidence, authTime: time };
  };
  const boundary = createSessionBoundary({ sessionStore: store, resolveMemberships: (id) => memberships.get(id), ...(configured ? { verifyIdentity: verifier } : {}), origin: 'https://storybank.example', ttlMs, clock: () => time });
  const repo = new StoryBankRepository({ authority: boundary.authority });
  const request = (session, method = 'POST', overrides = {}) => ({ method, headers: { cookie: session.setCookie.split(';')[0], origin: 'https://storybank.example', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, ...overrides } });
  return { boundary, repo, store, records, memberships, request, advance: (ms) => time += ms };
}

test('default identity adapter fails closed and never stores a session', async () => {
  const f = fixture({ configured: false });
  await assert.rejects(f.boundary.establish({ subject: 'alice', verified: true }), code('AUTH_NOT_CONFIGURED'));
  assert.equal(f.records.size, 0);
  assert.equal(f.boundary.status, 'sign_in_disabled');
});

test('verified adapter issues secure host-only cookie and stores digests, not credentials', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  assert.match(session.setCookie, /^__Host-storybank_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=60$/);
  assert.equal(session.setCookie.includes('Domain='), false);
  const token = session.setCookie.split(';')[0].split('=')[1];
  const record = [...f.records.values()][0];
  assert.equal(record.tokenDigest, createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(record).includes(token), false);
  assert.equal(JSON.stringify(record).includes(session.csrfToken), false);
  assert.equal(record.subject, 'alice');
});

test('browser-supplied identity and tenant switches cannot create authority', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  const request = f.request(session);
  request.headers['x-user-id'] = 'bob';
  request.body = { userId: 'bob', tenantId: 'beta' };
  assert.throws(() => f.boundary.contextForRequest(request, 'beta'), code('FORBIDDEN'));
  const context = f.boundary.contextForRequest(request, 'alpha');
  assert.equal(f.repo.createStory(context, { text: 'Owned fact.' }).createdBy, 'alice');
  assert.throws(() => f.repo.listStories({ ...context }), code('UNAUTHENTICATED'));
});

test('current session and membership are rechecked on existing contexts', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  const context = f.boundary.contextForRequest(f.request(session), 'alpha');
  f.memberships.set('alice', []);
  assert.throws(() => f.repo.listStories(context), code('FORBIDDEN'));
  f.memberships.set('alice', [{ tenantId: 'alpha', role: 'owner' }]);
  f.store.deleteForUser('alice');
  assert.throws(() => f.repo.listStories(context), code('UNAUTHENTICATED'));
});

test('GET and HEAD contexts cannot mutate even if a route mistakenly calls a writer', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  for (const method of ['GET', 'HEAD']) {
    const context = f.boundary.contextForRequest(f.request(session, method), 'alpha');
    assert.deepEqual(f.repo.listStories(context), []);
    assert.throws(() => f.repo.createStory(context, { text: 'Unsafe mutation' }), code('READ_ONLY_REQUEST'));
    assert.throws(() => f.repo.revokeIntegration(context), code('READ_ONLY_REQUEST'));
  }
});

test('mutations require exact origin, synchronizer CSRF token and JSON content type', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  for (const origin of ['', 'null', 'https://storybank.example.evil.test', 'http://storybank.example']) {
    assert.throws(() => f.boundary.contextForRequest(f.request(session, 'POST', { origin }), 'alpha'), code('ORIGIN_REJECTED'));
  }
  for (const csrf of ['', 'x'.repeat(43), session.csrfToken + 'x']) {
    assert.throws(() => f.boundary.contextForRequest(f.request(session, 'POST', { 'x-csrf-token': csrf }), 'alpha'), code('CSRF_REJECTED'));
  }
  assert.throws(() => f.boundary.contextForRequest(f.request(session, 'POST', { 'content-type': 'text/plain' }), 'alpha'), code('CONTENT_TYPE_REJECTED'));
  assert.ok(f.boundary.contextForRequest(f.request(session, 'POST', { 'content-type': 'application/json; charset=utf-8' }), 'alpha'));
});

test('ambiguous cookies/headers, cross-site requests, and missing tokens fail closed', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  const cookie = session.setCookie.split(';')[0];
  for (const badCookie of ['', `${cookie}; ${cookie}`, `${SESSION_COOKIE}=wrong`]) {
    assert.throws(() => f.boundary.contextForRequest(f.request(session, 'GET', { cookie: badCookie }), 'alpha'), code('UNAUTHENTICATED'));
  }
  assert.throws(() => f.boundary.contextForRequest(f.request(session, 'GET', { Cookie: cookie }), 'alpha'), code('INVALID_REQUEST'));
  assert.throws(() => f.boundary.contextForRequest(f.request(session, 'GET', { cookie: [cookie] }), 'alpha'), code('INVALID_REQUEST'));
  assert.throws(() => f.boundary.contextForRequest(f.request(session, 'GET', { 'sec-fetch-site': 'cross-site' }), 'alpha'), code('ORIGIN_REJECTED'));
  assert.throws(() => f.boundary.contextForRequest(f.request(session, 'TRACE'), 'alpha'), code('METHOD_NOT_ALLOWED'));
});

test('expiry invalidates issued contexts and direct requests', async () => {
  const f = fixture();
  const session = await f.boundary.establish('alice');
  const context = f.boundary.contextForRequest(f.request(session), 'alpha');
  f.advance(60_000);
  assert.throws(() => f.repo.listStories(context), code('UNAUTHENTICATED'));
  assert.throws(() => f.boundary.contextForRequest(f.request(session), 'alpha'), code('UNAUTHENTICATED'));
});

test('new verified sign-in rotates previous session rather than adopting it', async () => {
  const f = fixture();
  const first = await f.boundary.establish('alice');
  const oldToken = first.setCookie.split(';')[0].split('=')[1];
  const next = await f.boundary.establish('alice', { previousToken: oldToken });
  assert.notEqual(next.setCookie, first.setCookie);
  assert.equal(f.records.size, 1);
  assert.throws(() => f.boundary.contextForRequest(f.request(first), 'alpha'), code('UNAUTHENTICATED'));
  assert.ok(f.boundary.contextForRequest(f.request(next), 'alpha'));
});

test('sign-out requires protected POST and revokes its cookie', async () => {
  const f = fixture();
  const session = await f.boundary.establish('viewer');
  assert.throws(() => f.boundary.signOut(f.request(session, 'GET')), code('METHOD_NOT_ALLOWED'));
  assert.throws(() => f.boundary.signOut(f.request(session, 'POST', { 'x-csrf-token': '' })), code('CSRF_REJECTED'));
  assert.match(f.boundary.signOut(f.request(session)).setCookie, /Max-Age=0$/);
  assert.throws(() => f.boundary.contextForRequest(f.request(session), 'alpha'), code('UNAUTHENTICATED'));
});

test('revoke own sessions clears only current authenticated user', async () => {
  const f = fixture();
  const a = await f.boundary.establish('alice');
  const a2 = await f.boundary.establish('alice');
  const b = await f.boundary.establish('bob');
  assert.throws(() => f.boundary.revokeOwnSessions(f.request(a, 'GET'), 'alpha'), code('METHOD_NOT_ALLOWED'));
  f.boundary.revokeOwnSessions(f.request(a), 'alpha');
  for (const session of [a, a2]) assert.throws(() => f.boundary.contextForRequest(f.request(session), 'alpha'), code('UNAUTHENTICATED'));
  assert.ok(f.boundary.contextForRequest(f.request(b), 'beta'));
});

test('unsafe origins, lifetime, invalid adapter claims and malformed store records reject', async () => {
  const f = fixture();
  for (const origin of ['http://localhost', 'https://storybank.example/path', 'https://storybank.example/']) {
    assert.throws(() => createSessionBoundary({ sessionStore: f.store, resolveMemberships: () => [], origin }), TypeError);
  }
  assert.throws(() => createSessionBoundary({ sessionStore: f.store, resolveMemberships: () => [], origin: 'https://storybank.example', ttlMs: 9 * 60 * 60_000 }), TypeError);
  const bad = createSessionBoundary({ sessionStore: f.store, resolveMemberships: () => [], verifyIdentity: () => ({ subject: 'alice', authTime: -1 }), origin: 'https://storybank.example' });
  await assert.rejects(bad.establish({}), code('UNAUTHENTICATED'));
  const s = await f.boundary.establish('alice');
  const [key, record] = [...f.records.entries()][0];
  f.records.set(key, { ...record, csrfDigest: 'tampered' });
  assert.throws(() => f.boundary.contextForRequest(f.request(s), 'alpha'), code('UNAUTHENTICATED'));
});
