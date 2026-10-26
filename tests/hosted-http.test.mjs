import test from 'node:test';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
import assert from 'node:assert/strict';
import { handleHostedRequest, hostedContext, readBoundedBody } from '../server/hosted-http.mjs';
import { personalWorkspaceId } from '../server/hosted-d1.mjs';
import { createD1Fixture } from './support/d1-fixture.mjs';

function fixture(t) {
  const f = createD1Fixture(); t.after(() => f.close());
  const users = { alice: { userId: 'alice', displayName: 'Alice' }, bob: { userId: 'bob', displayName: 'Bob' } };
  const request = (path, body, headers = {}) => new Request(TEST_SITE_ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin: TEST_SITE_ORIGIN, 'content-type': 'application/json', 'x-storybank-request': '1', 'x-storybank-workspace': personalWorkspaceId('alice'), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = async (user, operation, args = []) => {
    const response = await handleHostedRequest(request('/api/command', { operation, args }, { 'x-storybank-workspace': personalWorkspaceId(users[user].userId) }), { env: TEST_DEPLOYMENT_ENV, user: users[user], db: f.db });
    return { status: response.status, body: await response.json() };
  };
  return { ...f, users, request, call };
}

// The supplied user is already trusted here. Live Sites edge header stripping
// and authentication must be verified separately, not inferred from this test.
test('request handler uses supplied server identity and cannot infer it from browser headers', async (t) => {
  const f = fixture(t);
  const request = f.request('/api/workspace', undefined, { 'oai-authenticated-user-id': 'alice' });
  const response = await handleHostedRequest(request, { env: TEST_DEPLOYMENT_ENV, user: null, db: f.db });
  assert.equal(response.status, 401);
  assert.throws(() => hostedContext({ userId: '' }), (error) => error.code === 'UNAUTHENTICATED');
  const created = await f.call('alice', 'createStory', [{ text: 'Alice supplied fact.' }]);
  assert.equal(created.status, 200);
  const foreign = await f.call('bob', 'getStory', [created.body.result.id]);
  assert.equal(foreign.status, 404);
  const own = await handleHostedRequest(f.request('/api/workspace'), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: f.db });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('cache-control'), 'no-store');
  assert.equal((await own.json()).workspace.data.stories[0].createdBy, 'alice');
});

test('hosted command dispatcher rejects arbitrary method, owner override and unsafe mutation request', async (t) => {
  const f = fixture(t);
  for (const operation of ['constructor', '__proto__', 'publishNow', 'deleteOwnData', 'runDuePlans']) assert.equal((await f.call('alice', operation)).status, 400);
  const extra = await handleHostedRequest(f.request('/api/command', { operation: 'listStories', args: [], ownerId: 'bob' }), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: f.db });
  assert.equal(extra.status, 400);
  for (const headers of [{ origin: 'https://evil.example' }, { 'x-storybank-request': '' }, { 'sec-fetch-site': 'cross-site' }, { 'content-type': 'text/plain' }]) {
    const response = await handleHostedRequest(f.request('/api/command', { operation: 'createStory', args: [{ text: 'No' }] }, headers), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: f.db });
    assert.ok([403, 415].includes(response.status));
  }
  assert.deepEqual((await f.call('alice', 'listStories')).body.result, []);
});

test('stale account headers fail closed in both switch directions and never select the data owner', async (t) => {
  const f = fixture(t);
  const alice = (await f.call('alice', 'createStory', [{ text: 'Alice private fixture.' }])).body.result;
  const bob = (await f.call('bob', 'createStory', [{ text: 'Bob private fixture.' }])).body.result;
  for (const [signedIn, stale] of [['alice', 'bob'], ['bob', 'alice']]) {
    const headers = { 'x-storybank-workspace': personalWorkspaceId(stale) };
    for (const [path, body] of [
      ['/api/command', { operation: 'createStory', args: [{ text: 'Stale form must not be saved.' }] }],
      ['/api/command', { operation: 'updateStory', args: [signedIn === 'alice' ? alice.id : bob.id, { text: 'Stale edit.' }, { expectedRevision: 1 }] }],
      ['/api/delete', { confirmation: 'DELETE_MY_WORKSPACE_DATA' }],
    ]) {
      const response = await handleHostedRequest(f.request(path, body, headers), { env: TEST_DEPLOYMENT_ENV, user: f.users[signedIn], db: f.db });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'WORKSPACE_CHANGED');
    }
    // The header is a mutation precondition, not an identity or read selector.
    const response = await handleHostedRequest(f.request('/api/workspace', undefined, headers), { env: TEST_DEPLOYMENT_ENV, user: f.users[signedIn], db: f.db });
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.user.workspaceKey, personalWorkspaceId(signedIn));
    assert.deepEqual(snapshot.workspace.data.stories.map(story => story.id), [signedIn === 'alice' ? alice.id : bob.id]);
  }
  assert.equal((await f.call('alice', 'getStory', [alice.id])).body.result.text, alice.text);
  assert.equal((await f.call('bob', 'getStory', [bob.id])).body.result.text, bob.text);
  assert.equal((await f.call('alice', 'getStory', [bob.id])).status, 404);
  assert.equal((await f.call('bob', 'getStory', [alice.id])).status, 404);
});

test('server stream limit does not trust a missing or small content-length header', async (t) => {
  const f = fixture(t);
  const body = JSON.stringify({ operation: 'createStory', args: [{ text: 'x'.repeat(70_000) }] });
  const response = await handleHostedRequest(new Request(TEST_SITE_ORIGIN + '/api/command', { method: 'POST', headers: { origin: TEST_SITE_ORIGIN, 'x-storybank-request': '1', 'content-type': 'application/json', 'content-length': '1', 'x-storybank-workspace': personalWorkspaceId('alice') }, body }), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: f.db });
  assert.equal(response.status, 413);
  let cancelled = false;
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(10)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedBody(new Request('https://test.invalid', { method: 'POST', body: stream, duplex: 'half' }), 15), (error) => error.code === 'BODY_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('hosted own deletion requires explicit phrase and never erases another writer', async (t) => {
  const f = fixture(t);
  await f.call('alice', 'createStory', [{ text: 'Alice data.' }]);
  await f.call('bob', 'createStory', [{ text: 'Bob data.' }]);
  const no = await handleHostedRequest(f.request('/api/delete', {}), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: f.db });
  assert.equal(no.status, 409);
  const yes = await handleHostedRequest(f.request('/api/delete', { confirmation: 'DELETE_MY_WORKSPACE_DATA' }), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: f.db });
  assert.equal(yes.status, 200);
  assert.deepEqual((await f.call('alice', 'listStories')).body.result, []);
  assert.equal((await f.call('bob', 'listStories')).body.result.length, 1);
});

test('missing binding is truthful and provider/storage errors do not expose internals', async (t) => {
  const f = fixture(t);
  const missing = await handleHostedRequest(f.request('/api/workspace'), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, 'STORAGE_NOT_CONFIGURED');
  const broken = await handleHostedRequest(f.request('/api/workspace'), { env: TEST_DEPLOYMENT_ENV, user: f.users.alice, db: { prepare() { throw new Error('SQL secret connection data'); } } });
  assert.equal(broken.status, 503);
  assert.equal((await broken.text()).includes('secret'), false);
});

test('hosted writer journey persists profile feedback, changes future previews, and invalidates old plans', async (t) => {
  const f = fixture(t);
  const call = async (operation, args = []) => {
    const response = await f.call('alice', operation, args);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result;
  };
  const profile = await call('saveWritingProfile', [{ displayName: 'Alice', creators: [{ name: 'A public writer', profileUrl: 'https://www.linkedin.com/in/example', notes: 'I admire clear explanations.' }] }, { expectedVersion: 0 }]);
  assert.equal(profile.version, 1);
  const facts = ['We tested the first version with five people.', 'Their feedback changed the order of the tasks.'];
  const input = { topic: 'A small usability test', facts, count: 5 };
  const before = await call('createCalibration', [input]);
  assert.equal(before.variants.length, 5);
  await call('addCalibrationFeedback', [before.id, { variantId: before.variants[0].id, likes: ['Short paragraphs'], dislikes: ['Invented statistics'], feedback: 'Keep my real facts.' }]);
  const proposal = await call('proposeWritingRevision', [before.id]);
  assert.equal(proposal.baseVersion, 1);
  const revised = await call('applyWritingRevision', [proposal.id, { expectedVersion: 1 }]);
  assert.equal(revised.version, 2);
  const after = await call('createCalibration', [input]);
  assert.equal(after.profileVersion, 2);
  assert.notEqual(after.variants[0].text, before.variants[0].text);
  for (const variant of after.variants) {
    assert.equal(variant.kind, 'non_ai_template_preview');
    for (const fact of facts) assert.ok(variant.text.includes(fact));
    assert.equal(variant.text.includes('statistics'), false);
  }
  assert.equal((await f.call('bob', 'getWritingProfile')).status, 404);
  assert.equal((await f.call('bob', 'getCalibration', [before.id])).status, 404);
  const story = await call('createStory', [{ title: input.topic, text: after.variants[0].text, source: `draft:${after.id}` }]);
  const approved = await call('approveStory', [story.id, { expectedRevision: story.revision }]);
  const plan = await call('schedulePlan', [{ storyId: story.id, approvalId: approved.record.id, dueAt: '2030-01-01T12:00:00.000Z', idempotencyKey: 'qa-one-manual-plan' }]);
  const duplicate = await call('schedulePlan', [{ storyId: story.id, approvalId: approved.record.id, dueAt: '2030-01-01T12:00:00.000Z', idempotencyKey: 'qa-one-manual-plan' }]);
  assert.equal(plan.id, duplicate.id);
  const changed = await call('updateStory', [story.id, { text: story.text + '\nMy own added conclusion.' }, { expectedRevision: story.revision }]);
  assert.equal(changed.activeApprovalId, null);
  assert.equal((await call('getJob', [plan.id])).status, 'cancelled');
  assert.equal((await f.call('alice', 'approveStory', [story.id, { expectedRevision: story.revision }])).status, 409);
  const skill = await call('exportWritingSkill');
  assert.ok(skill.content.includes('Alice'));
  assert.ok(skill.content.includes('Prefer: Short paragraphs'));
  const snapshot = await call('exportOwnData');
  assert.equal(snapshot.data.writingProfileVersions.length, 2);
  assert.equal(snapshot.data.calibrations[0].feedback.length, 1);
});

test('hosted draft attachments reject unvalidated audio IDs rather than trusting a client reference', async (t) => {
  const f = fixture(t);
  const response = await f.call('alice', 'createStory', [{ text: 'A real supplied fact.', mediaIds: ['some-other-writer-recording'] }]);
  assert.equal(response.status, 409);
  assert.equal(response.body.error, 'MEDIA_LINKING_NOT_READY');
  assert.deepEqual((await f.call('alice', 'listStories')).body.result, []);
});

test('approval binds the exact plain export plus original editor text and blocks equivalent content duplicates', async (t) => {
  const f = fixture(t);
  const first = (await f.call('alice', 'createStory', [{ text: '**My actual story.** *One lesson.*' }])).body.result;
  const approval = (await f.call('alice', 'approveStory', [first.id, { expectedRevision: 1 }])).body.result;
  assert.equal(approval.record.snapshot.schema, 'storybank.approval.v2');
  assert.equal(approval.record.snapshot.text, 'My actual story. One lesson.');
  assert.equal(approval.record.snapshot.editorText, first.text);
  const request = { storyId: first.id, approvalId: approval.record.id, dueAt: '2030-01-01T12:00:00.000Z', idempotencyKey: 'first-plain-plan' };
  assert.equal((await f.call('alice', 'schedulePlan', [request])).status, 200);
  const second = (await f.call('alice', 'createStory', [{ text: 'My actual story. One lesson.' }])).body.result;
  const other = (await f.call('alice', 'approveStory', [second.id, { expectedRevision: 1 }])).body.result;
  const duplicate = await f.call('alice', 'schedulePlan', [{ ...request, storyId: second.id, approvalId: other.record.id, idempotencyKey: 'second-plain-plan' }]);
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, 'DUPLICATE_CONTENT');
});

test('plain output approval rejects blank markers, excessive length and unresolved placeholders', async (t) => {
  const f = fixture(t);
  for (const [text, error] of [['****', 'EMPTY_CONTENT'], ['x'.repeat(3001), 'CONTENT_TOO_LONG'], ['My story [insert metric]', 'UNRESOLVED_PLACEHOLDER']]) {
    const created = (await f.call('alice', 'createStory', [{ text }])).body.result;
    const rejected = await f.call('alice', 'approveStory', [created.id, { expectedRevision: 1 }]);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, error);
  }
});
