/** Browser-side helpers. They do not store data or call an external provider. */
export class WorkspaceRequestError extends Error {
  constructor(message, { status = 0, code = '', uncertain = false } = {}) {
    super(message);
    this.name = 'WorkspaceRequestError';
    this.status = status;
    this.code = code;
    this.uncertain = uncertain;
  }
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function expectedResponse(path, method, data) {
  if (!object(data)) return false;
  if (path === '/api/command' || path === '/api/delete') return Object.hasOwn(data, 'result');
  if (path === '/api/workspace') return object(data.user) && object(data.workspace?.data) &&
    ['stories', 'writingProfileVersions', 'calibrations', 'writingRevisionProposals', 'jobs'].every(key => Array.isArray(data.workspace.data[key]));
  if (path === '/api/audio') return method === 'POST' ? typeof data.id === 'string' && !!data.id : Array.isArray(data.recordings);
  if (path.startsWith('/api/audio/') && method === 'DELETE') return typeof data.deleted === 'boolean';
  return false;
}

/** Never automatically retry a mutation: a lost response may follow a committed save.
 * @param {string} path
 * @param {RequestInit} options
 * @param {typeof fetch} fetcher
 */
export async function requestWorkspaceJSON(path, options = {}, fetcher = globalThis.fetch) {
  if (!path.startsWith('/api/')) throw new WorkspaceRequestError('Use a StoryBank workspace endpoint.');
  const method = (options.method || 'GET').toUpperCase();
  const mutation = !['GET', 'HEAD'].includes(method);
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  headers.set('X-StoryBank-Request', '1');
  let response;
  try {
    response = await fetcher(path, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new WorkspaceRequestError(mutation
      ? 'We could not confirm whether your change was saved. Refresh and check before trying again.'
      : 'Your workspace could not be loaded. Check your connection and try again.', { uncertain: mutation });
  }
  const uncertain = mutation && (response.ok || response.status >= 500 || response.status === 408);
  let data;
  try { data = await response.json(); } catch {
    throw new WorkspaceRequestError(uncertain
      ? 'The save response was incomplete. Refresh and check your workspace before trying again.'
      : 'The workspace response could not be read. Please try again.', { status: response.status, uncertain });
  }
  if (!response.ok) throw new WorkspaceRequestError(uncertain
    ? 'We could not confirm whether your change was saved. Refresh and check before trying again.'
    : typeof data?.message === 'string' ? data.message : response.status === 401
    ? 'Please reopen StoryBank from your signed-in account, then try again.'
    : 'That request could not be completed safely.', { status: response.status, uncertain, code: typeof data?.error === 'string' ? data.error : '' });
  if (!expectedResponse(path, method, data)) throw new WorkspaceRequestError('The workspace response was incomplete. Refresh and check before trying again.', { status: response.status, uncertain });
  return data;
}

/** An owner-bound requester never adopts an identity returned by a later fetch.
 * @param {string} expectedWorkspaceKey
 * @param {{isActive?: () => boolean, onSessionInvalid?: (error: unknown) => void}} options
 * @param {typeof fetch} [fetcher]
 */
export function createWorkspaceRequest(expectedWorkspaceKey, { isActive = () => true, onSessionInvalid = () => {} } = {}, fetcher = globalThis.fetch) {
  return async (path, options = {}) => {
    const inactive = () => new WorkspaceRequestError('This workspace is no longer active. Reopen StoryBank before continuing.', { code: 'WORKSPACE_CHANGED', status: 409 });
    if (!isActive() || typeof expectedWorkspaceKey !== 'string' || !expectedWorkspaceKey) throw inactive();
    const headers = new Headers(options.headers);
    headers.set('X-StoryBank-Workspace', expectedWorkspaceKey);
    try {
      const result = await requestWorkspaceJSON(path, { ...options, headers }, fetcher);
      if (!isActive()) throw inactive();
      if (path === '/api/workspace' && result.user.workspaceKey !== expectedWorkspaceKey) throw inactive();
      return result;
    } catch (error) {
      if (isActive() && invalidWorkspaceSession(error)) onSessionInvalid(error);
      throw error;
    }
  };
}

export const invalidWorkspaceSession = error => error instanceof WorkspaceRequestError &&
  (error.status === 401 || ['UNAUTHENTICATED', 'WORKSPACE_CHANGED'].includes(error.code));

export const uncertainChange = error => error instanceof WorkspaceRequestError && error.uncertain;
export const requiresWorkspaceRefresh = error => uncertainChange(error) || invalidWorkspaceSession(error) ||
  (error instanceof WorkspaceRequestError && ['REVISION_CONFLICT', 'VERSION_CONFLICT', 'STORAGE_CONFLICT', 'WORKSPACE_CHANGED'].includes(error.code));

/** Keep every supplied line visible. Limits are validated, never silently sliced. */
export function factsFromNote(text) {
  return text.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

export const feedbackHasChanges = (input, originalText) => !!(input.likes || input.dislikes || input.feedback || input.editing || input.editReasons || input.editedText !== originalText);

export const calibrationInputKey = (topic, facts, count) => JSON.stringify([topic, facts, count]);

/** An edited structured profile cannot silently keep an older Markdown override.
 * Earlier saved versions retain the writer's previous custom guidance. */
export function editedWritingProfile(profile, patch) {
  const changed = Object.entries(patch).some(([field, value]) => JSON.stringify(profile[field]) !== JSON.stringify(value));
  return { ...profile, ...patch, ...(changed && Object.hasOwn(profile, 'skillMarkdown') ? { skillMarkdown: '' } : {}) };
}

/** Validate again on submission, not just when the dialog first opened. */
export function validatePlanTime(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return { valid: false, error: 'Choose a valid date and time.', iso: null };
  const date = new Date(value);
  const fields = value.split(/[-T:]/).map(Number);
  if (!Number.isFinite(date.getTime()) || [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].some((part, index) => part !== (fields[index] ?? 0))) {
    return { valid: false, error: 'That time does not exist in your browser’s time zone. Choose another time.', iso: null };
  }
  if (date.getTime() <= now) return { valid: false, error: 'Choose a future time. This plan will not post or send a reminder.', iso: null };
  return { valid: true, error: '', iso: date.toISOString() };
}
