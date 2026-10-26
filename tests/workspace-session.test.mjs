import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceRequest, invalidWorkspaceSession, uncertainChange } from '../hosted/lib/studio-flow.mjs';
const workspace = key => ({ user: { workspaceKey: key }, workspace: { data: { stories: [], writingProfileVersions: [], calibrations: [], writingRevisionProposals: [], jobs: [] } } });
test('owner-bound requester cannot retarget old form or audio calls', async () => {
  const calls = []; let active = true;
  const request = createWorkspaceRequest('personal_A', { isActive: () => active }, async (path, options) => { calls.push(options); return Response.json(path === '/api/audio' ? { recordings: [] } : { result: {} }); });
  await request('/api/audio'); await request('/api/command', { method: 'POST', headers: { 'x-storybank-workspace': 'personal_B' }, body: '{}' });
  assert.ok(calls.every(options => options.headers.get('X-StoryBank-Workspace') === 'personal_A'));
  active = false; await assert.rejects(request('/api/command', { method: 'POST', body: '{}' }), invalidWorkspaceSession); assert.equal(calls.length, 2);
});
test('mismatched workspace and 401 clear the owning session without adopting returned data', async () => {
  for (const response of [Response.json(workspace('personal_B')), Response.json({ error: 'UNAUTHENTICATED' }, { status: 401 }), new Response('Sign in', { status: 401 })]) {
    let invalid = 0; const request = createWorkspaceRequest('personal_A', { onSessionInvalid: () => invalid++ }, async () => response);
    await assert.rejects(request('/api/workspace'), invalidWorkspaceSession); assert.equal(invalid, 1);
  }
});
test('ordinary uncertain saves retain recovery classification, not session loss', async () => {
  let invalid = 0; const request = createWorkspaceRequest('personal_A', { onSessionInvalid: () => invalid++ }, async () => { throw new Error('synthetic lost response'); });
  await assert.rejects(request('/api/command', { method: 'POST', body: '{}' }), error => uncertainChange(error) && !invalidWorkspaceSession(error)); assert.equal(invalid, 0);
});
test('completion after unmount cannot return private data or invalidate a different live session', async () => {
  let resolve, active = true, invalid = 0; const response = new Promise(done => { resolve = done; });
  const request = createWorkspaceRequest('personal_A', { isActive: () => active, onSessionInvalid: () => invalid++ }, async () => response);
  const pending = request('/api/workspace'); active = false; resolve(Response.json(workspace('personal_A')));
  await assert.rejects(pending, invalidWorkspaceSession); assert.equal(invalid, 0);
});
