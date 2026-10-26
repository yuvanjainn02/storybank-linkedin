import test from 'node:test';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { requestWorkspaceJSON, uncertainChange, requiresWorkspaceRefresh, calibrationInputKey, factsFromNote, feedbackHasChanges, validatePlanTime } from '../hosted/lib/studio-flow.mjs';
import { handleHostedRequest } from '../server/hosted-http.mjs';
import { personalWorkspaceId } from '../server/hosted-d1.mjs';
import { createD1Fixture } from './support/d1-fixture.mjs';

const post = { method: 'POST', body: '{}' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const rejects = (run, uncertain, refresh = uncertain) => assert.rejects(run, error => {
  assert.equal(uncertainChange(error), uncertain);
  assert.equal(requiresWorkspaceRefresh(error), refresh);
  return true;
});

test('a confirmed save keeps its result, forces same-origin credentials, preserves Headers and makes one request', async () => {
  let calls = 0;
  const result = await requestWorkspaceJSON('/api/command', { ...post, credentials: 'include', headers: new Headers({ 'x-test': 'kept', 'X-StoryBank-Request': 'wrong' }) }, async (path, options) => {
    calls++; assert.equal(path, '/api/command'); assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store'); assert.equal(options.headers.get('X-StoryBank-Request'), '1');
    assert.equal(options.headers.get('x-test'), 'kept'); assert.equal(options.headers.get('Content-Type'), 'application/json');
    return json({ result: { id: 'saved' } });
  });
  assert.equal(calls, 1); assert.equal(result.result.id, 'saved');
});

for (const status of [408, 500, 502, 503, 504]) test(`HTTP ${status} mutation is uncertain and is never automatically retried`, async () => {
  let calls = 0;
  await rejects(() => requestWorkspaceJSON('/api/command', post, async () => { calls++; return json({ message: 'Please retry.' }, status); }), true);
  assert.equal(calls, 1);
});

for (const fail of [() => { throw new TypeError('network'); }, () => { throw new DOMException('aborted', 'AbortError'); }, () => new Response('{"result":'), () => json({}), () => json(null), () => json([])]) {
  test(`unconfirmed mutation is locked for recovery: ${String(fail)}`, async () => {
    let calls = 0;
    await rejects(() => requestWorkspaceJSON('/api/command', post, async () => { calls++; return fail(); }), true);
    assert.equal(calls, 1);
  });
}

for (const status of [400, 401, 403, 404, 413, 415, 429]) test(`a definite HTTP ${status} rejection is not reported as a successful or uncertain save`, async () => {
  await rejects(() => requestWorkspaceJSON('/api/command', post, async () => json({ message: 'Rejected.' }, status)), false, status === 401);
});

for (const code of ['REVISION_CONFLICT', 'VERSION_CONFLICT', 'STORAGE_CONFLICT']) test(`${code} requires a fresh workspace without falsely claiming a committed save`, async () => {
  await rejects(() => requestWorkspaceJSON('/api/command', post, async () => json({ error: code, message: 'Refresh first.' }, 409)), false, true);
});

test('a failed read remains retryable, while an incomplete successful read is never used as workspace data', async () => {
  await rejects(() => requestWorkspaceJSON('/api/workspace', {}, async () => { throw new TypeError('offline'); }), false);
  await rejects(() => requestWorkspaceJSON('/api/workspace', {}, async () => json({ user: {}, workspace: { data: {} } })), false);
  const expected = { user: {}, workspace: { data: { stories: [], calibrations: [], writingProfileVersions: [], writingRevisionProposals: [], jobs: [] } } };
  assert.deepEqual(await requestWorkspaceJSON('/api/workspace', {}, async () => json(expected)), expected);
});

test('audio keeps its binary content type and cannot claim success without a returned recording ID', async () => {
  const blob = new Blob(['fictional audio'], { type: 'audio/webm' });
  const options = { method: 'POST', body: blob, headers: { 'Content-Type': blob.type } };
  const result = await requestWorkspaceJSON('/api/audio', options, async (_, input) => {
    assert.equal(input.body, blob); assert.equal(input.headers.get('Content-Type'), 'audio/webm');
    return json({ id: 'recording' }, 201);
  });
  assert.equal(result.id, 'recording');
  for (const body of [{}, { id: '' }, { id: null }]) await rejects(() => requestWorkspaceJSON('/api/audio', options, async () => json(body, 201)), true);
  await rejects(() => requestWorkspaceJSON('/api/audio', options, async () => json({ message: 'Unknown outcome.' }, 503)), true);
});

test('partial cleanup remains explicit and missing deletion receipts are not silently accepted', async () => {
  const partial = { result: { deleted: true }, pendingAudioCleanup: true };
  assert.deepEqual(await requestWorkspaceJSON('/api/delete', post, async () => json(partial, 202)), partial);
  assert.deepEqual(await requestWorkspaceJSON('/api/audio/fixture', { method: 'DELETE' }, async () => json({ deleted: false, pending: true }, 202)), { deleted: false, pending: true });
  await rejects(() => requestWorkspaceJSON('/api/delete', post, async () => json({})), true);
});

test('the workspace client rejects an external endpoint before fetching', async () => {
  let called = false;
  await rejects(() => requestWorkspaceJSON('https://example.com/api/command', post, async () => { called = true; return json({}); }), false);
  assert.equal(called, false);
});

test('notes with more than ten facts stay complete rather than silently losing the final lines', () => {
  const lines = Array.from({ length: 12 }, (_, i) => `Supplied fact ${i + 1}.`);
  assert.equal(factsFromNote(`\n ${lines.join(' \n ')} \n`), lines.join('\n'));
  assert.ok(factsFromNote(lines.join('\n')).endsWith('Supplied fact 12.'));
});

test('calibration dirty-state baseline detects edits and becomes clean only when the exact inputs are acknowledged', () => {
  const baseline = calibrationInputKey('My topic', 'My fact', 3);
  assert.equal(calibrationInputKey('My topic', 'My fact', 3), baseline);
  for (const fields of [['New topic', 'My fact', 3], ['My topic', 'New fact', 3], ['My topic', 'My fact', 5]]) assert.notEqual(calibrationInputKey(...fields), baseline);
  const saved = calibrationInputKey('My topic', 'New fact', 5);
  assert.equal(calibrationInputKey('My topic', 'New fact', 5), saved);
});

test('planning rejects invalid, normalized and expired times and rechecks the actual submit time', () => {
  for (const value of ['', 'invalid', '2026-02-30T10:00', '2026-11-01T25:00', '2026-01-01', null]) assert.equal(validatePlanTime(value, 0).valid, false);
  const local = '2026-12-01T12:00'; const timestamp = new Date(local).getTime();
  assert.equal(validatePlanTime(local, timestamp - 1).valid, true);
  assert.equal(validatePlanTime(local, timestamp).valid, false);
  assert.equal(validatePlanTime(local, timestamp + 60000).valid, false);
  assert.equal(validatePlanTime(local, timestamp - 1).iso, new Date(local).toISOString());
});

test('a daylight-saving gap cannot silently become a different planning time', () => {
  const moduleURL = new URL('../hosted/lib/studio-flow.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { validatePlanTime } from ${JSON.stringify(moduleURL)}; console.log(JSON.stringify(validatePlanTime('2026-03-08T02:30', 0)));`], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, false);
});

test('real request handler preserves independent feedback, profiles and supplied facts through the shared client', async t => {
  const fixture = createD1Fixture(); t.after(() => fixture.close());
  const client = userId => async (operation, args = []) => {
    const data = await requestWorkspaceJSON('/api/command', { method: 'POST', headers: { 'X-StoryBank-Workspace': personalWorkspaceId(userId) }, body: JSON.stringify({ operation, args }) }, async (path, options) => {
      const headers = new Headers(options.headers); headers.set('Origin', TEST_SITE_ORIGIN);
      return handleHostedRequest(new Request(TEST_SITE_ORIGIN + path, { ...options, headers }), { env: TEST_DEPLOYMENT_ENV, user: { userId }, db: fixture.db });
    });
    return data.result;
  };
  const alice = client('fictional-alice'), bob = client('fictional-bob');
  const facts = ['I tested a fictional form.', 'Three fictional volunteers gave feedback.'];
  const first = await alice('createCalibration', [{ topic: 'Fictional testing', facts, count: 3 }]);
  await alice('addCalibrationFeedback', [first.id, { variantId: first.variants[0].id, likes: ['Short paragraphs'], dislikes: ['Invented claims'], feedback: 'Alice-only guidance.' }]);
  await assert.rejects(() => bob('getCalibration', [first.id]), error => error.status === 404 && !uncertainChange(error));
  const proposal = await alice('proposeWritingRevision', [first.id]);
  await alice('applyWritingRevision', [proposal.id, { expectedVersion: 0 }]);
  const next = await alice('createCalibration', [{ topic: 'Fictional testing', facts, count: 3 }]);
  const separate = await bob('createCalibration', [{ topic: 'Fictional testing', facts, count: 3 }]);
  assert.equal(next.profileVersion, 1); assert.equal(separate.profileVersion, 0);
  assert.notDeepEqual(next.variants.map(item => item.text), separate.variants.map(item => item.text));
  assert.deepEqual(next.facts, facts); assert.deepEqual(separate.feedback, []);
  for (const variant of next.variants) for (const fact of facts) assert.ok(variant.text.includes(fact), 'Supplied evidence retained');
  const own = await alice('exportOwnData'); const other = await bob('exportOwnData');
  assert.match(JSON.stringify(own), /Alice-only guidance/); assert.doesNotMatch(JSON.stringify(other), /Alice-only guidance/);
});


test('feedback is considered unsaved even when its edited-example section is hidden again', () => {
  const original = 'Supplied example.';
  const clean = { likes: '', dislikes: '', feedback: '', editing: false, editedText: original, editReasons: '' };
  assert.equal(feedbackHasChanges(clean, original), false);
  for (const change of [{ likes: 'Clear' }, { dislikes: 'Formal' }, { feedback: 'Be direct' }, { editing: true }, { editedText: 'My revision' }, { editReasons: 'Less repetition' }]) assert.equal(feedbackHasChanges({ ...clean, ...change }, original), true);
});
