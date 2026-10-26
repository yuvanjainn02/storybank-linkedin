import { fail } from './errors.mjs';
import { verifyDeploymentRequest } from './deployment-config.mjs';
import { jsonResponse, readBoundedBody, safeError } from './hosted-http.mjs';
import { equalDigest, linkedinConfiguration, linkedinRunnerConfiguration, MAX_SCHEDULE_LATENESS_MS, sha256 } from './linkedin-provider.mjs';
import { createLinkedInStore } from './linkedin-store.mjs';

export const LINKEDIN_RUNNER_PATH = '/api/linkedin/runner';
export { MAX_SCHEDULE_LATENESS_MS } from './linkedin-provider.mjs';
const primary = (db) => typeof db?.withSession === 'function' ? db.withSession('first-primary') : db;

async function readCommand(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) fail('CONTENT_TYPE_REJECTED', 'Send JSON.', 415);
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 1024))); }
  catch (error) { if (error.code) throw error; fail('INVALID_JSON', 'Send a valid JSON object.', 400); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => key !== 'mode')
    || !['dry-run', 'dispatch-one'].includes(value.mode)) fail('INVALID_RUNNER_COMMAND', 'Choose dry-run or dispatch-one. No owner or post fields are accepted.', 400);
  return value.mode;
}

/** A bounded, synchronous, single-owner worker entrypoint, NOT a recurring timer.
 * The caller must await its response. Never use browser polling as a runner.
 * Tokens must be generated/configured through the approved secure setup flow.
 * @param {Request} request
 * @param {{db?: any, env?: any, fetcher?: typeof fetch, clock?: () => number}} options
 */
export async function handleLinkedInRunnerRequest(request, { db, env = {}, fetcher = fetch, clock = () => Date.now() } = {}) {
  try {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== LINKEDIN_RUNNER_PATH || url.search) fail('NOT_FOUND', 'This endpoint does not exist.', 404);
    verifyDeploymentRequest(request, { env });
    const runner = linkedinRunnerConfiguration(env);
    if (!runner.enabled) fail('RUNNER_UNAVAILABLE', 'The publishing runner has not been enabled.', 503);
    // Separate capability, not the platform bypass header and not a visitor
    // identity. Strict syntax rejects duplicate/combined headers and URL tokens.
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '');
    if (!match || !equalDigest(sha256(match[1]), runner.tokenHash)) fail('RUNNER_UNAUTHORIZED', 'Runner authorization is required.', 401);
    // This is a service-only route. Browser contexts cannot acquire authority by
    // possessing a normal signed-in user session or spoofing the owner header.
    if (request.headers.has('origin') || (request.headers.get('sec-fetch-site') && request.headers.get('sec-fetch-site') !== 'none')) fail('RUNNER_SERVICE_ONLY', 'Use the authorized server runner.', 403);
    const mode = await readCommand(request);
    const session = primary(db);
    if (!session?.prepare) fail('STORAGE_NOT_CONFIGURED', 'Runner storage is not configured.', 503);
    const now = clock();
    // Aggregate-only dry-run is strictly read-only: no lease recovery, token
    // decryption, provider call, owner identity, post text or job IDs returned.
    const summary = await session.prepare(`SELECT
      SUM(CASE WHEN status = 'queued' AND attempts = 0 AND due_at <= ? AND json_extract(snapshot, '$.mode') = 'scheduled' THEN 1 ELSE 0 END) AS due,
      SUM(CASE WHEN status = 'queued' AND attempts = 0 AND due_at < ? AND json_extract(snapshot, '$.mode') = 'scheduled' THEN 1 ELSE 0 END) AS overdue,
      SUM(CASE WHEN status = 'sending' THEN 1 ELSE 0 END) AS sending,
      SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
      FROM storybank_linkedin_jobs WHERE owner_user_id = ?`).bind(now, now - MAX_SCHEDULE_LATENESS_MS, runner.ownerId).first();
    const counts = Object.fromEntries(['due', 'overdue', 'sending', 'unknown'].map((key) => [key, Number(summary?.[key] ?? 0)]));
    const config = linkedinConfiguration(env);
    if (mode === 'dry-run') return jsonResponse({ mode, checkedAt: new Date(now).toISOString(), counts,
      dispatchEnabled: config.publishingEnabled && config.schedulerVerified, maximumLatenessMinutes: 15 });
    if (!config.publishingEnabled) fail('PUBLISHING_DISABLED', 'Live LinkedIn publishing is not enabled.', 503);
    if (!config.schedulerVerified) fail('SCHEDULER_UNAVAILABLE', 'The recurring runner has not been verified.', 503);
    const ownerId = runner.ownerId;
    // No caller-supplied owner, content, audience, job selection or timestamp.
    // The server only dispatches a durable, previously confirmed scheduled job.
    const store = createLinkedInStore({ db, config, fetcher, clock });
    const user = Object.freeze({ userId: ownerId });
    // Reuse established stale-lease recovery; an interrupted send becomes
    // unknown, never queued. Current sends are never duplicated or cancelled.
    await store.status(user);
    const sending = await session.prepare("SELECT id FROM storybank_linkedin_jobs WHERE owner_user_id = ? AND status = 'sending' LIMIT 1").bind(ownerId).first();
    if (sending) return jsonResponse({ mode, outcome: 'busy' });
    const next = await session.prepare(`SELECT id, due_at FROM storybank_linkedin_jobs WHERE owner_user_id = ? AND status = 'queued'
      AND attempts = 0 AND due_at <= ? AND json_extract(snapshot, '$.mode') = 'scheduled' ORDER BY due_at ASC, id ASC LIMIT 1`).bind(ownerId, clock()).first();
    if (!next) return jsonResponse({ mode, outcome: 'idle' });
    if (next.due_at < clock() - MAX_SCHEDULE_LATENESS_MS) {
      const result = await session.prepare("UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'scheduled_deadline_missed', finished_at = ? WHERE owner_user_id = ? AND id = ? AND status = 'queued' AND attempts = 0")
        .bind(clock(), ownerId, next.id).run();
      if (result?.success !== true || !Number.isSafeInteger(result?.meta?.changes)) fail('STORAGE_OUTCOME_UNKNOWN', 'The cancellation result could not be confirmed. Check publication history.', 503);
      return jsonResponse({ mode, outcome: result.meta.changes === 1 ? 'missed_deadline' : 'changed' });
    }
    // dispatch rechecks source approval/hash, connection generation/expiry and
    // atomically reserves one attempt immediately before its fixed provider POST.
    const result = await store.dispatch(user, next.id);
    return jsonResponse({ mode, outcome: result.status, reason: result.reason });
  } catch (error) { return safeError(error); }
}
