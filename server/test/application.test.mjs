import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStoryBankStorage } from '../persistence.mjs';
import { createSessionBoundary } from '../session.mjs';
import { createStoryBankApplication } from '../application.mjs';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'storybank-api-test-'));
  const filename = join(dir, 'fictional.sqlite');
  let storage, boundary, repository, app;
  const now = Date.parse('2026-10-22T12:00:00Z');
  const memberships = { alice: [{ tenantId: 'alpha', role: 'owner' }], cara: [{ tenantId: 'alpha', role: 'owner' }], bob: [{ tenantId: 'beta', role: 'owner' }] };
  function open() {
    storage = openStoryBankStorage({ filename });
    boundary = createSessionBoundary({ sessionStore: storage.sessionStore, origin: 'https://storybank.example', clock: () => now,
      resolveMemberships: (subject) => memberships[subject],
      verifyIdentity: (subject) => { if (!memberships[subject]) throw new Error('Test identity rejected'); return { subject, authTime: now }; },
    });
    repository = storage.createRepository({ authority: boundary.authority, clock: () => new Date(now) });
    app = createStoryBankApplication({ repository, sessionBoundary: boundary });
  }
  open();
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  const sessions = Object.fromEntries(await Promise.all(Object.keys(memberships).map(async (user) => [user, await boundary.establish(user)])));
  const call = (user, method, route, body, overrides = {}) => app.handle({ method, url: `/v1/workspaces/${user === 'bob' ? 'beta' : 'alpha'}/${route}`,
    headers: { cookie: sessions[user].setCookie.split(';')[0], origin: 'https://storybank.example', 'x-csrf-token': sessions[user].csrfToken, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { rawBody: JSON.stringify(body) }), ...overrides });
  return { call, sessions, get boundary() { return boundary; }, restart() { storage.close(); open(); }, get app() { return app; }, get repository() { return repository; } };
}

test('durable API survives restart while same-tenant and cross-tenant users stay isolated', async (t) => {
  const f = await fixture(t);
  const created = f.call('alice', 'POST', 'stories', { text: 'Fictional Alice fact.' });
  assert.equal(created.status, 201);
  const id = created.body.id;
  f.restart();
  assert.equal(f.call('alice', 'GET', `stories/${id}`).body.text, 'Fictional Alice fact.');
  for (const user of ['cara', 'bob']) {
    assert.deepEqual(f.call(user, 'GET', 'stories').body, []);
    assert.equal(f.call(user, 'GET', `stories/${id}`).status, 404);
    assert.equal(f.call(user, 'PATCH', `stories/${id}`, { patch: { text: 'Overwrite' }, expectedRevision: 1 }).status, 404);
  }
  const switched = f.call('alice', 'GET', 'stories', undefined, { url: '/v1/workspaces/beta/stories' });
  assert.equal(switched.status, 403);
});

test('API enforces safe read/mutation methods, CSRF and no-store responses', async (t) => {
  const f = await fixture(t);
  const denied = f.call('alice', 'POST', 'stories', { text: 'No' }, { headers: { cookie: f.sessions.alice.setCookie.split(';')[0] } });
  assert.equal(denied.status, 403);
  assert.equal(f.call('alice', 'GET', 'stories', { text: 'Unsafe' }).status, 400);
  assert.deepEqual(f.call('alice', 'GET', 'stories').body, []);
  const read = f.call('alice', 'GET', 'stories');
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(read.headers['x-content-type-options'], 'nosniff');
  assert.equal('access-control-allow-origin' in read.headers, false);
  assert.equal(f.call('alice', 'POST', 'stories', { text: 'No', tenantId: 'beta' }).status, 400);
});

test('API bounds JSON input and hides internal storage details', async (t) => {
  const f = await fixture(t);
  assert.equal(f.call('alice', 'POST', 'stories', undefined, { rawBody: 'x'.repeat(65_537) }).status, 413);
  assert.equal(f.call('alice', 'POST', 'stories', undefined, { rawBody: '{bad' }).status, 400);
  assert.equal(f.call('alice', 'POST', 'stories', undefined, { rawBody: '[]' }).status, 400);
  for (const url of ['https://evil.test/v1/workspaces/alpha/stories', '//evil.test', '/v1/workspaces/alpha/stories?user=bob']) {
    assert.equal(f.call('alice', 'GET', 'stories', undefined, { url }).status, 400);
  }
  const broken = createStoryBankApplication({ repository: { listStories() { throw new Error('SECRET SQL token=password'); } }, sessionBoundary: { contextForRequest() { return {}; } } });
  const response = broken.handle({ method: 'GET', url: '/v1/workspaces/alpha/stories', headers: {} });
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response).includes('password'), false);
});

test('approval and scheduling persist; stale update fails and real publishing route is absent', async (t) => {
  const f = await fixture(t);
  const story = f.call('alice', 'POST', 'stories', { text: 'Fictional test experience.' }).body;
  const approval = f.call('alice', 'POST', `stories/${story.id}/approval`, { expectedRevision: 1 }).body;
  const body = { storyId: story.id, approvalId: approval.record.id, dueAt: '2026-10-23T12:00:00Z', idempotencyKey: 'test-request-0001' };
  const plan = f.call('alice', 'POST', 'plans', body).body;
  f.restart();
  assert.equal(f.call('alice', 'POST', 'plans', body).body.id, plan.id);
  assert.equal(f.call('alice', 'PATCH', `stories/${story.id}`, { patch: { text: 'New approved facts required.' }, expectedRevision: 0 }).status, 409);
  assert.equal(f.call('alice', 'PATCH', `stories/${story.id}`, { patch: { text: 'New approved facts required.' }, expectedRevision: 1 }).status, 200);
  assert.equal(f.call('alice', 'GET', 'plans').body[0].status, 'cancelled');
  assert.equal(f.call('alice', 'POST', `stories/${story.id}/publish`, {}).status, 404);
  assert.equal(f.call('alice', 'GET', 'integrations').body.livePublishing, false);
});

test('profile compare-and-set and own data export/delete work through authenticated API', async (t) => {
  const f = await fixture(t);
  f.call('alice', 'POST', 'stories', { text: 'Fictional private Alice story.' });
  f.call('cara', 'POST', 'stories', { text: 'Fictional private Cara story.' });
  const profile = f.call('alice', 'PUT', 'profile', { profile: { voice: 'Clear and brief' }, expectedVersion: 0 });
  assert.equal(profile.status, 200);
  assert.equal(f.call('alice', 'PUT', 'profile', { profile: {}, expectedVersion: 0 }).status, 409);
  const exported = f.call('alice', 'GET', 'privacy/export');
  assert.equal(exported.status, 200);
  assert.equal(JSON.stringify(exported).includes('Cara story'), false);
  assert.equal(f.call('alice', 'POST', 'privacy/delete', {}).status, 409);
  const deleted = f.call('alice', 'POST', 'privacy/delete', { confirmation: 'DELETE_MY_WORKSPACE_DATA' });
  assert.equal(deleted.status, 200);
  f.restart();
  assert.deepEqual(f.call('alice', 'GET', 'stories').body, []);
  assert.equal(f.call('alice', 'GET', 'profile').status, 404);
  assert.equal(f.call('cara', 'GET', 'stories').body.length, 1);
});

test('persisted sessions remain revoked across database reopen', async (t) => {
  const f = await fixture(t);
  const session = f.sessions.alice;
  f.boundary.signOut({ method: 'POST', headers: { cookie: session.setCookie.split(';')[0], origin: 'https://storybank.example', 'content-type': 'application/json', 'x-csrf-token': session.csrfToken } });
  f.restart();
  assert.equal(f.call('alice', 'GET', 'stories').status, 401);
  assert.equal(f.call('cara', 'GET', 'stories').status, 200);
});
