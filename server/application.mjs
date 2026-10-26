import { StoryBankError, fail } from './errors.mjs';

const RESPONSE_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});
const ownObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
function fields(body, allowed) {
  if (!ownObject(body) || Object.keys(body).some((key) => !allowed.includes(key))) fail('INVALID_FIELD', 'Unsupported request fields.');
  return body;
}

/**
 * HTTP-independent API adapter. No listener, login route, CORS grant, model,
 * external fetch, or publishing enable switch. The hosting adapter must enforce
 * HTTPS and reject oversized bodies WHILE streaming, before this JSON boundary.
 * Do not feed authenticated identity from a browser into its constructor.
 */
export function createStoryBankApplication({ repository, sessionBoundary, maxBodyBytes = 65_536 } = {}) {
  if (!repository || typeof sessionBoundary?.contextForRequest !== 'function') throw new TypeError('A trusted repository and session boundary are required.');
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 1_048_576) throw new TypeError('A bounded request size is required.');
  return Object.freeze({
    handle(request) {
      try {
        if (!request || typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 2048) fail('INVALID_REQUEST', 'A relative application path is required.');
        const path = new URL(request.url, 'https://routing.invalid');
        if (path.search || path.hash) fail('INVALID_REQUEST', 'Query parameters are not supported here.');
        const match = /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,100})\/(.+)$/.exec(path.pathname);
        if (!match) fail('NOT_FOUND', 'This endpoint was not found.', 404);
        const [, tenantId, route] = match;
        const context = sessionBoundary.contextForRequest(request, tenantId);
        const method = request.method;
        const rawBody = request.rawBody ?? '';
        if (typeof rawBody !== 'string') fail('INVALID_REQUEST', 'The hosting adapter must supply a bounded raw JSON string.');
        if (Buffer.byteLength(rawBody, 'utf8') > maxBodyBytes) fail('BODY_TOO_LARGE', 'This request is too large.', 413);
        let body = {};
        if (rawBody) {
          if (['GET', 'HEAD'].includes(method)) fail('INVALID_REQUEST', 'Read requests do not accept bodies.');
          try { body = JSON.parse(rawBody); } catch { fail('INVALID_JSON', 'Send valid JSON.'); }
          if (!ownObject(body)) fail('INVALID_JSON', 'Send a JSON object.');
        }
        let result;
        let status = 200;
        const item = /^(stories|plans|calibrations|revisions)\/([A-Za-z0-9_-]{1,100})(?:\/(approval|feedback|proposal))?$/.exec(route);
        if (route === 'stories' && method === 'GET') result = repository.listStories(context);
        else if (route === 'stories' && method === 'POST') { result = repository.createStory(context, body); status = 201; }
        else if (item?.[1] === 'stories' && !item[3] && method === 'GET') result = repository.getStory(context, item[2]);
        else if (item?.[1] === 'stories' && !item[3] && method === 'PATCH') {
          fields(body, ['patch', 'expectedRevision']);
          result = repository.updateStory(context, item[2], body.patch, { expectedRevision: body.expectedRevision });
        } else if (item?.[1] === 'stories' && !item[3] && method === 'DELETE') {
          fields(body, []); result = repository.deleteStory(context, item[2]);
        } else if (item?.[1] === 'stories' && item[3] === 'approval' && method === 'POST') {
          fields(body, ['expectedRevision']); result = repository.approveStory(context, item[2], { expectedRevision: body.expectedRevision });
        } else if (item?.[1] === 'stories' && item[3] === 'approval' && method === 'DELETE') {
          fields(body, []); result = repository.revokeApproval(context, item[2]);
        } else if (route === 'plans' && method === 'GET') result = repository.listJobs(context);
        else if (route === 'plans' && method === 'POST') {
          fields(body, ['storyId', 'approvalId', 'dueAt', 'idempotencyKey']); result = repository.schedulePlan(context, body); status = 201;
        } else if (item?.[1] === 'plans' && !item[3] && method === 'DELETE') { fields(body, []); result = repository.cancelJob(context, item[2]); }
        else if (route === 'profile' && method === 'GET') result = repository.getWritingProfile(context);
        else if (route === 'profile' && method === 'PUT') {
          fields(body, ['profile', 'expectedVersion']); result = repository.saveWritingProfile(context, body.profile, { expectedVersion: body.expectedVersion });
        } else if (route === 'profile/versions' && method === 'GET') result = repository.listWritingProfileVersions(context);
        else if (route === 'profile/skill' && method === 'GET') result = repository.exportWritingSkill(context);
        else if (route === 'profile/reset' && method === 'POST') { fields(body, ['expectedVersion']); result = repository.resetWritingProfile(context, { expectedVersion: body.expectedVersion }); }
        else if (route === 'calibrations' && method === 'POST') { result = repository.createCalibration(context, body); status = 201; }
        else if (item?.[1] === 'calibrations' && !item[3] && method === 'GET') result = repository.getCalibration(context, item[2]);
        else if (item?.[1] === 'calibrations' && item[3] === 'feedback' && method === 'POST') result = repository.addCalibrationFeedback(context, item[2], body);
        else if (item?.[1] === 'calibrations' && item[3] === 'proposal' && method === 'POST') { fields(body, []); result = repository.proposeWritingRevision(context, item[2]); }
        else if (item?.[1] === 'revisions' && !item[3] && method === 'GET') result = repository.getWritingRevision(context, item[2]);
        else if (item?.[1] === 'revisions' && !item[3] && method === 'POST') { fields(body, ['expectedVersion']); result = repository.applyWritingRevision(context, item[2], { expectedVersion: body.expectedVersion }); }
        else if (route === 'privacy/export' && method === 'GET') result = repository.exportOwnData(context);
        else if (route === 'privacy/delete' && method === 'POST') {
          fields(body, ['confirmation']);
          if (body.confirmation !== 'DELETE_MY_WORKSPACE_DATA') fail('CONFIRMATION_REQUIRED', 'Explicit confirmation is required before clearing your workspace data.', 409);
          result = repository.deleteOwnData(context);
        } else if (route === 'integrations' && method === 'GET') result = repository.integrationStatus(context);
        else fail('NOT_FOUND', 'This endpoint or method is not supported.', 404);
        return { status, headers: { ...RESPONSE_HEADERS }, body: result };
      } catch (error) {
        // Never serialize stack traces, SQL, sessions, raw request bodies or
        // provider diagnostics. Hosting logs must apply the same redaction.
        return {
          status: error instanceof StoryBankError ? error.status : 503,
          headers: { ...RESPONSE_HEADERS },
          body: { error: error instanceof StoryBankError ? error.code : 'SERVICE_UNAVAILABLE', message: error instanceof StoryBankError ? error.message : 'This operation could not be completed safely.' },
        };
      }
    },
  });
}
