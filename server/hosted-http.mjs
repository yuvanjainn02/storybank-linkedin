import { createContextAuthority } from './context.mjs';
import { createD1StoryBank, personalWorkspaceId } from './hosted-d1.mjs';
import { fail, StoryBankError } from './errors.mjs';
import { verifyDeploymentRequest } from './deployment-config.mjs';
import { deriveCreatorResearchStatus } from './creator-research-status.mjs';

const NO_STORE = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const COMMANDS = new Map([
  ['createStory', 1], ['getStory', 1], ['listStories', 0], ['updateStory', 3], ['deleteStory', 1],
  ['approveStory', 2], ['getApproval', 1], ['revokeApproval', 1], ['schedulePlan', 1], ['getJob', 1], ['listJobs', 0], ['cancelJob', 1],
  ['integrationStatus', 0], ['saveWritingProfile', 2], ['getWritingProfile', 0], ['listWritingProfileVersions', 0], ['exportWritingSkill', 0], ['resetWritingProfile', 1],
  ['createCalibration', 1], ['getCalibration', 1], ['addCalibrationFeedback', 2], ['proposeWritingRevision', 1], ['getWritingRevision', 1], ['applyWritingRevision', 2], ['deleteCalibration', 1], ['exportOwnData', 0],
]);
export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: NO_STORE });
export function safeError(error) {
  return jsonResponse({ error: error instanceof StoryBankError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof StoryBankError ? error.message : 'This operation could not be completed safely. Please try again.' }, error instanceof StoryBankError ? error.status : 503);
}

export function verifyMutationRequest(request, { env = {}, allowLocalDevelopment = false } = {}) {
  const origin = verifyDeploymentRequest(request, { env, allowLocalDevelopment });
  if (request.headers.get('origin') !== origin || request.headers.get('x-storybank-request') !== '1') fail('ORIGIN_REJECTED', 'Refresh StoryBank before making changes.', 403);
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) fail('ORIGIN_REJECTED', 'This request must come from StoryBank.', 403);
}

// This is a stale-view precondition, not an identity selector. Authenticated
// server identity remains the only authority. All tester mutations require it.
export function verifyWorkspaceRequest(request, userId) {
  const expected = request.headers.get('x-storybank-workspace');
  if (expected !== personalWorkspaceId(userId)) fail('WORKSPACE_CHANGED', 'Your signed-in workspace changed. Refresh before saving to avoid mixing accounts.', 409);
}

export async function readBoundedBody(request, limit) {
  const advertised = request.headers.get('content-length');
  if (advertised && (!/^\d+$/.test(advertised) || Number(advertised) > limit)) fail('BODY_TOO_LARGE', 'This request is too large.', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); fail('BODY_TOO_LARGE', 'This request is too large.', 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}

async function readJSON(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) fail('CONTENT_TYPE_REJECTED', 'Send a JSON request.', 415);
  // Profiles include a resumable demo, revision, and up to 15 samples. Keep a
  // bounded stream while retaining the original smaller limit for other calls.
  const bytes = await readBoundedBody(request, 524_288);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_JSON', 'Send a valid JSON object.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON', 'Send a JSON object.');
  if (bytes.byteLength > 65_536 && value.operation !== 'saveWritingProfile') fail('BODY_TOO_LARGE', 'This request is too large.', 413);
  return value;
}

/** user comes ONLY from Sites' server-only getChatGPTUser helper. Never a body/header parsed in browser code. */
export function hostedContext(user, { readOnly = false } = {}) {
  if (!user || typeof user.userId !== 'string' || !user.userId.trim() || user.userId.length > 500) fail('UNAUTHENTICATED', 'Sign in to StoryBank to continue.', 401);
  const tenantId = personalWorkspaceId(user.userId);
  const handle = Object.freeze({});
  const authority = createContextAuthority({ resolveSession: (session) => session === handle ? { subject: user.userId, memberships: [{ tenantId, role: 'owner' }] } : null });
  return { authority, context: authority.authenticate(handle, tenantId, { readOnly }) };
}

/** Framework adapter: no custom login endpoints and no provider key or external API.
 * @param {Request} request
 * @param {{user?: {userId: string, displayName?: string} | null, db?: any, env?: any, allowLocalDevelopment?: boolean}} options
 * @returns {Promise<Response>}
 */
export async function handleHostedRequest(request, { user, db, env = {}, allowLocalDevelopment = false } = {}) {
  try {
    const path = new URL(request.url).pathname;
    const readOnly = request.method === 'GET';
    const { authority, context } = hostedContext(user, { readOnly });
    verifyDeploymentRequest(request, { env, allowLocalDevelopment });
    if (!db) fail('STORAGE_NOT_CONFIGURED', 'Your secure workspace storage is not configured yet.', 503);
    const service = createD1StoryBank({ db, authority });
    if (path === '/api/workspace' && request.method === 'GET') {
      const workspace = await service.invoke(context, 'exportOwnData');
      return jsonResponse({ user: { displayName: user.displayName || 'Your workspace', workspaceKey: personalWorkspaceId(user.userId) }, workspace, creatorResearch: deriveCreatorResearchStatus(workspace.data.writingProfileVersions.at(-1)) });
    }
    if (!['/api/command', '/api/delete'].includes(path) || request.method !== 'POST') fail('NOT_FOUND', 'This endpoint is not supported.', 404);
    verifyMutationRequest(request, { env, allowLocalDevelopment });
    verifyWorkspaceRequest(request, user.userId);
    const body = await readJSON(request);
    if (path === '/api/delete') {
      if (Object.keys(body).length !== 1 || body.confirmation !== 'DELETE_MY_WORKSPACE_DATA') fail('CONFIRMATION_REQUIRED', 'Confirm that you want to delete your workspace data.', 409);
      return jsonResponse({ result: await service.invoke(context, 'deleteOwnData') });
    }
    if (Object.keys(body).some((field) => !['operation', 'args'].includes(field)) || !COMMANDS.has(body.operation) || !Array.isArray(body.args) || body.args.length !== COMMANDS.get(body.operation)) fail('INVALID_COMMAND', 'This action is not supported.');
    const mediaIds = body.operation === 'createStory' ? body.args[0]?.mediaIds : body.operation === 'updateStory' ? body.args[1]?.mediaIds : undefined;
    if (Array.isArray(mediaIds) && mediaIds.length) fail('MEDIA_LINKING_NOT_READY', 'Save recordings separately until secure draft attachment support is ready.', 409);
    return jsonResponse({ result: await service.invoke(context, body.operation, body.args) });
  } catch (error) { return safeError(error); }
}
