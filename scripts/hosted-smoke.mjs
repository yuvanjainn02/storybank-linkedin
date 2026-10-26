/** Local request-level integration suite. Uses only loopback, fictional data,
 * built-in local mock sign-in, and local D1/R2. Refuses nonempty workspaces.
 * Run from any directory: node scripts/hosted-smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'http://127.0.0.1:4176';
const report = [];
const marker = `FICTIONAL_HOSTED_SMOKE_${Date.now()}`;
let server, serverLog = '', cookie = '', workspaceKey = '', safeToDelete = false, passed = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function log(message) { report.push(message); process.stdout.write(message + '\n'); }
function pass(message) { passed++; log(`PASS ${passed}: ${message}`); }
async function start() {
  server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4176'], { cwd: `${root}hosted`, env: { ...process.env, VINEXT_NO_DEV_LOCK: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (data) => { serverLog += data; });
  server.stderr.on('data', (data) => { serverLog += data; });
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}: ${serverLog.slice(-5000)}`);
    try { const response = await fetch(`${origin}/api/workspace`, { signal: AbortSignal.timeout(2000) }); if (response.status === 401) return; }
    catch {}
    await sleep(500);
  }
  throw new Error(`Server startup deadline: ${serverLog.slice(-5000)}`);
}
async function stop() {
  if (!server) return;
  const child = server;
  server = null;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  if (child.exitCode === null) await Promise.race([once(child, 'exit'), sleep(5000)]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await sleep(300);
}
async function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method, headers: { ...(auth && cookie ? { cookie } : {}), ...(body !== undefined && !(body instanceof Uint8Array) ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin, 'x-storybank-request': '1', ...(auth && workspaceKey ? { 'x-storybank-workspace': workspaceKey } : {}) } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(30000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let data;
  try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { data = null; }
  return { status: response.status, headers: response.headers, data, bytes };
}
function expect(response, status, code) {
  assert.equal(response.status, status, JSON.stringify({ expected: status, actual: response.status, data: response.data }));
  if (code) assert.equal(response.data?.error, code);
  return response.data;
}
async function command(operation, args = [], expectedStatus = 200, code) {
  return expect(await request('/api/command', { method: 'POST', body: { operation, args } }), expectedStatus, code)?.result;
}
function assertEmpty(data) {
  for (const [field, records] of Object.entries(data)) {
    if (field === 'auditEvents') { assert.ok(records.every((record) => record.type === 'privacy.deleted'), 'Non-test activity exists; refusing cleanup'); }
    else assert.deepEqual(records, [], `Workspace contains existing ${field}; refusing tests or cleanup`);
  }
}
function wav() {
  const bytes = Buffer.alloc(60);
  bytes.write('RIFF'); bytes.writeUInt32LE(52, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(16, 40);
  return bytes;
}
log(`StoryBank hosted runtime smoke | ${new Date().toISOString()}`);
log('Scope: actual Vinext dev HTTP routes, local mock identity local_seedy, local D1/R2, fictional data only. No deploy, external API, model call, credentials, or live publishing.');
try {
  await start();
  expect(await request('/api/workspace', { auth: false }), 401, 'UNAUTHENTICATED');
  expect(await request('/api/audio', { auth: false }), 401, 'UNAUTHENTICATED');
  expect(await request('/api/command', { auth: false, method: 'POST', body: { operation: 'listStories', args: [] } }), 401, 'UNAUTHENTICATED');
  pass('Unauthenticated workspace, audio, and command requests return 401.');
  expect(await request('/api/workspace', { auth: false, headers: { 'oai-authenticated-user-id': 'fake-owner', 'oai-authenticated-user-email': 'fake@example.invalid' } }), 401, 'UNAUTHENTICATED');
  pass('Caller-supplied identity headers are stripped; spoofing does not authenticate.');
  const signIn = await request('/signin-with-chatgpt?return_to=/', { auth: false });
  expect(signIn, 302);
  assert.match(signIn.headers.get('set-cookie'), /__sites_local_auth=1/);
  cookie = signIn.headers.get('set-cookie').split(';')[0];
  const initial = expect(await request('/api/workspace'), 200);
  assert.equal(initial.workspace.userId, 'local_seedy');
  assert.match(initial.user.workspaceKey, /^personal_/); workspaceKey = initial.user.workspaceKey;
  assert.equal(initial.creatorResearch.automaticResearchAvailable, false);
  assert.equal(initial.creatorResearch.referenceCount, 0);
  assertEmpty(initial.workspace.data);
  assert.deepEqual(expect(await request('/api/audio'), 200).recordings, []);
  safeToDelete = true;
  pass('Supported loopback mock sign-in succeeds; test workspace and audio are initially empty.');
  const spoofed = expect(await request('/api/workspace', { headers: { 'oai-authenticated-user-id': 'fake-owner', 'oai-authenticated-user-email': 'fake@example.invalid' } }), 200);
  assert.equal(spoofed.workspace.userId, 'local_seedy');
  pass('Spoof headers cannot switch the signed-in local identity.');
  expect(await request('/api/command', { method: 'POST', body: { operation: 'listStories', args: [] }, headers: { 'x-storybank-workspace': '' } }), 409, 'WORKSPACE_CHANGED');
  expect(await request('/api/command', { method: 'POST', body: { operation: 'listStories', args: [] }, headers: { 'x-storybank-workspace': 'personal_foreign' } }), 409, 'WORKSPACE_CHANGED');
  expect(await request('/api/audio', { method: 'POST', body: wav(), headers: { 'content-type': 'audio/wav', 'x-storybank-workspace': '' } }), 409, 'WORKSPACE_CHANGED');
  pass('Missing and foreign workspace preconditions reject commands and audio before writes.');
  const providerStatus = expect(await request('/api/linkedin/status'), 200);
  assert.equal(providerStatus.readiness.oauthEnabled, false);
  assert.equal(providerStatus.readiness.publishingEnabled, false);
  assert.equal(providerStatus.connection, null); assert.deepEqual(providerStatus.jobs, []);
  pass('Official connection status is honest: no connection, jobs, OAuth or publishing enabled.');
  expect(await request('/api/command', { method: 'POST', body: { operation: 'listStories', args: [] }, headers: { origin: 'https://attacker.invalid' } }), 403);
  expect(await request('/api/command', { method: 'POST', body: { operation: 'listStories', args: [] }, headers: { 'x-storybank-request': '' } }), 403, 'ORIGIN_REJECTED');
  expect(await request('/api/command', { method: 'POST', body: { operation: 'listStories', args: [], userId: 'fake-owner' } }), 400, 'INVALID_COMMAND');
  expect(await request('/api/delete', { method: 'POST', body: {} }), 409, 'CONFIRMATION_REQUIRED');
  pass('Wrong origin, missing mutation marker, injected identity, and unconfirmed delete are rejected.');
  const story = await command('createStory', [{ title: marker, text: `${marker}: An imaginary team wrote down its process.`, source: 'Fictional smoke test' }]);
  assert.equal(story.createdBy, 'local_seedy');
  assert.equal((await command('getStory', [story.id])).text, story.text);
  assert.equal((await command('listStories')).length, 1);
  assert.equal((await request('/api/workspace')).headers.get('cache-control'), 'no-store');
  await command('updateStory', [story.id, { text: 'Stale edit' }, { expectedRevision: 0 }], 409, 'REVISION_CONFLICT');
  pass('Notes persist across independent HTTP requests; ownership and stale-edit guard hold.');
  const profile = await command('saveWritingProfile', [{ displayName: 'Fictional Smoke Writer', voice: 'Concise and clear', preferredFormats: 'Short paragraphs', avoid: 'Invented claims' }, { expectedVersion: 0 }]);
  assert.equal(profile.version, 1);
  assert.equal((await command('getWritingProfile')).preferences.voice, 'Concise and clear');
  await command('saveWritingProfile', [{ voice: 'Stale' }, { expectedVersion: 0 }], 409, 'VERSION_CONFLICT');
  pass('Personal profile persists; version compare-and-set rejects stale saves.');
  const calibration = await command('createCalibration', [{ topic: `${marker} process`, facts: ['An imaginary team wrote a checklist.', 'The imaginary checklist had three steps.'], count: 3 }]);
  assert.equal(calibration.variants.length, 3);
  assert.equal(calibration.mode, 'non_ai_template_preview');
  await command('addCalibrationFeedback', [calibration.id, { variantId: calibration.variants[0].id, likes: ['short paragraphs'], dislikes: ['invented statistics'], feedback: `${marker} Keep only supplied facts.`, editedText: 'The imaginary team wrote a three-step checklist.', editReasons: 'More direct' }]);
  const proposal = await command('proposeWritingRevision', [calibration.id]);
  assert.equal(proposal.status, 'proposed');
  assert.equal((await command('getWritingProfile')).version, 1);
  const revised = await command('applyWritingRevision', [proposal.id, { expectedVersion: 1 }]);
  assert.equal(revised.version, 2);
  assert.match(revised.preferences.feedbackGuidance, /Prefer: short paragraphs/);
  assert.equal((await command('getCalibration', [calibration.id])).feedback.length, 1);
  assert.equal((await command('getWritingRevision', [proposal.id])).status, 'applied');
  assert.equal((await command('listWritingProfileVersions')).length, 2);
  assert.match((await command('exportWritingSkill')).content, /short paragraphs/);
  pass('Calibration previews, feedback, reviewed proposal, applied revision, history, and skill export persist.');
  const approval = await command('approveStory', [story.id, { expectedRevision: 1 }]);
  assert.equal(approval.record.snapshot.text, story.text);
  const planArgs = { storyId: story.id, approvalId: approval.record.id, dueAt: new Date(Date.now() + 86400000).toISOString(), idempotencyKey: `${marker}-plan` };
  const plan = await command('schedulePlan', [planArgs]);
  assert.equal(plan.mode, 'local_plan_only'); assert.equal(plan.publishAttempts, 0);
  assert.equal((await command('schedulePlan', [planArgs])).id, plan.id);
  const integrations = await command('integrationStatus');
  assert.equal(integrations.livePublishing, false);
  await command('publishNow', [story.id, approval.record.id], 400, 'INVALID_COMMAND');
  pass('Exact draft approval and idempotent manual plan persist; publishing remains unavailable.');
  const audio = wav();
  expect(await request('/api/audio', { method: 'POST', body: audio, headers: { 'content-type': 'text/plain' } }), 415, 'AUDIO_TYPE_REJECTED');
  expect(await request('/api/audio', { method: 'POST', body: new Uint8Array(), headers: { 'content-type': 'audio/wav' } }), 400, 'AUDIO_EMPTY');
  const uploaded = expect(await request('/api/audio', { method: 'POST', body: audio, headers: { 'content-type': 'audio/wav' } }), 201);
  const recording = expect(await request('/api/audio'), 200).recordings;
  assert.equal(recording.length, 1); assert.equal(recording[0].id, uploaded.id); assert.equal(recording[0].size, audio.length);
  const playback = await request(`/api/audio/${uploaded.id}`);
  expect(playback, 200); assert.deepEqual(playback.bytes, new Uint8Array(audio));
  assert.equal(playback.headers.get('content-type'), 'audio/wav');
  assert.equal(playback.headers.get('cache-control'), 'private, no-store');
  assert.ok(playback.headers.get('vary').split(',').map((value) => value.trim().toLowerCase()).includes('cookie'));
  assert.equal(playback.headers.get('cross-origin-resource-policy'), 'same-origin');
  const range = await request(`/api/audio/${uploaded.id}`, { headers: { range: 'bytes=4-11' } });
  expect(range, 206); assert.deepEqual(range.bytes, new Uint8Array(audio.subarray(4, 12))); assert.equal(range.headers.get('content-range'), `bytes 4-11/${audio.length}`);
  const suffix = await request(`/api/audio/${uploaded.id}`, { headers: { range: 'bytes=-6' } });
  expect(suffix, 206); assert.deepEqual(suffix.bytes, new Uint8Array(audio.subarray(-6)));
  expect(await request(`/api/audio/${uploaded.id}`, { headers: { range: 'bytes=1000-' } }), 416, 'AUDIO_RANGE_REJECTED');
  const ifRange = await request(`/api/audio/${uploaded.id}`, { headers: { range: 'bytes=4-11', 'if-range': 'unissued-validator' } });
  expect(ifRange, 200); assert.deepEqual(ifRange.bytes, new Uint8Array(audio));
  expect(await request(`/api/audio/${uploaded.id}`, { auth: false }), 401, 'UNAUTHENTICATED');
  pass('Actual local R2 WAV upload/list/playback works; byte range, suffix, invalid range, If-Range, private headers, and auth hold.');
  await stop();
  await start();
  assert.equal((await command('getStory', [story.id])).text, story.text);
  assert.equal((await command('getWritingProfile')).version, 2);
  assert.equal((await command('getCalibration', [calibration.id])).feedback.length, 1);
  assert.equal((await command('getWritingRevision', [proposal.id])).status, 'applied');
  assert.equal((await command('getApproval', [approval.record.id])).record.snapshot.text, story.text);
  assert.equal((await command('getJob', [plan.id])).status, 'planned');
  const restartedAudio = await request(`/api/audio/${uploaded.id}`);
  expect(restartedAudio, 200); assert.deepEqual(restartedAudio.bytes, new Uint8Array(audio));
  pass('Full dev-server process restart preserves D1 note/profile/feedback/revision/approval/plan and R2 audio bytes.');
  const edited = await command('updateStory', [story.id, { text: `${marker}: The imaginary team revised its checklist.` }, { expectedRevision: 1 }]);
  assert.equal(edited.revision, 2); assert.equal(edited.activeApprovalId, null);
  assert.equal((await command('getJob', [plan.id])).status, 'cancelled');
  assert.equal((await command('getApproval', [approval.record.id])).revocationReason, 'story_changed');
  pass('Editing an approved draft revokes approval and cancels its manual plan.');
  expect(await request(`/api/audio/${uploaded.id}`, { method: 'DELETE' }), 200);
  expect(await request(`/api/audio/${uploaded.id}`), 404, 'NOT_FOUND');
  assert.deepEqual(expect(await request('/api/audio'), 200).recordings, []);
  expect(await request(`/api/audio/${uploaded.id}`, { method: 'DELETE' }), 200);
  pass('Recording deletion removes playback/list visibility and is idempotent.');
  const uploadedForCleanup = expect(await request('/api/audio', { method: 'POST', body: audio, headers: { 'content-type': 'audio/wav' } }), 201);
  const deleted = expect(await request('/api/delete', { method: 'POST', body: { confirmation: 'DELETE_MY_WORKSPACE_DATA' } }), 200);
  assert.equal(deleted.result.deleted, true); assert.equal(deleted.pendingAudioCleanup, false);
  assert.equal(deleted.audioCleanup.remaining, 0); assert.equal(deleted.audioCleanup.deleted, 1);
  assertEmpty(expect(await request('/api/workspace'), 200).workspace.data);
  assert.deepEqual(expect(await request('/api/audio'), 200).recordings, []);
  expect(await request(`/api/audio/${uploadedForCleanup.id}`), 404, 'NOT_FOUND');
  await command('getWritingProfile', [], 404, 'NOT_FOUND');
  safeToDelete = false;
  pass('Confirmed deletion clears only this suite’s content/history/plans and remaining R2 recording; content-free receipt remains.');
  await stop();
  await start();
  assertEmpty(expect(await request('/api/workspace'), 200).workspace.data);
  assert.deepEqual(expect(await request('/api/audio'), 200).recordings, []);
  pass('Deleted data remains absent after a second full restart.');
  log(`RESULT: PASS (${passed} grouped integration checks). Local production-like routing only; real Sites gateway and remote D1/R2 were not tested.`);
} catch (error) {
  log(`RESULT: FAIL after ${passed} grouped checks: ${error.stack}`);
  process.exitCode = 1;
  if (safeToDelete && server) {
    try {
      const cleaned = await request('/api/delete', { method: 'POST', body: { confirmation: 'DELETE_MY_WORKSPACE_DATA' } });
      log(`Fictional suite cleanup: HTTP ${cleaned.status}; ${JSON.stringify(cleaned.data)}`);
    } catch (cleanupError) { log(`Fictional suite cleanup needs follow-up: ${cleanupError.message}`); }
  }
  log(`Server diagnostics (last 6000 chars):\n${serverLog.slice(-6000)}`);
} finally {
  await stop();
  log('Owned dev-server process group stopped.');
  await writeFile(`${root}qa/hosted-runtime-smoke.txt`, `${report.join('\n')}\n`);
}
