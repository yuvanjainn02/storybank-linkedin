import { randomUUID } from 'node:crypto';
import { fail } from './errors.mjs';
import { createD1StoryBank, personalWorkspaceId } from './hosted-d1.mjs';
import { hostedContext } from './hosted-http.mjs';
import { approvalSnapshot, hashSnapshot } from './approval.mjs';
import { equalDigest, MAX_SCHEDULE_LATENESS_MS, openSecret, publishLinkedInText, sealSecret, sha256 } from './linkedin-provider.mjs';

const SAFE_JOB_FIELDS = ['id', 'story_id', 'source_revision', 'source_approval_id', 'snapshot', 'snapshot_hash', 'due_at', 'time_zone', 'status', 'reason', 'post_urn', 'created_at', 'finished_at', 'attempts'];
const publicJob = (row) => row ? Object.fromEntries(SAFE_JOB_FIELDS.map((key) => [key, key === 'snapshot' ? JSON.parse(row[key]) : row[key]])) : null;
const publicConnection = (row, now) => row ? { connectionId: row.connection_id, displayName: row.display_name, personUrn: row.person_urn,
  status: row.expires_at <= now + 60_000 ? 'expired' : 'connected', expiresAt: new Date(row.expires_at).toISOString(), scopes: row.scopes.split(' ') } : null;
const primary = (db) => typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
function checkedDB(db) { if (!db?.prepare) fail('STORAGE_NOT_CONFIGURED', 'LinkedIn connection storage is not configured.', 503); return primary(db); }
async function run(statement) {
  const result = await statement.run();
  if (result?.success !== true || !Number.isSafeInteger(result?.meta?.changes)) fail('STORAGE_OUTCOME_UNKNOWN', 'The update could not be confirmed. Refresh before trying again.', 503);
  return result.meta.changes;
}
function owner(user) { hostedContext(user); return user.userId; }
function strictObject(value, keys) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => !keys.includes(key))) fail('INVALID_PUBLICATION', 'Unsupported publication fields.', 400); }
function validId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 200; }
function safeDate(value, timeZone, now) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) fail('INVALID_DATE', 'Use an ISO time with an explicit offset.', 400);
  const time = Date.parse(value);
  const [y, m, d, h, min, sec] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  if (!Number.isFinite(time) || m < 1 || m > 12 || d < 1 || d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] || h > 23 || min > 59 || sec > 59 || time < now - 60_000 || time > now + 90 * 86400_000) fail('INVALID_DATE', 'Choose a real time within the next 90 days.', 400);
  try {
    if (typeof timeZone !== 'string' || timeZone.length > 100) throw new Error();
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(time).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
    // The supplied offset must describe the user's wall clock in this zone.
    if (`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` !== value.slice(0, 19)) throw new Error();
  } catch { fail('TIMEZONE_MISMATCH', 'The date, offset and timezone do not agree. Check daylight saving time.', 400); }
  return time;
}

export function createLinkedInStore({ db, config, clock = () => Date.now(), fetcher = fetch } = {}) {
  const connectionRaw = async (ownerId) => checkedDB(db).prepare('SELECT * FROM storybank_linkedin_connections WHERE owner_user_id = ?').bind(ownerId).first();
  async function recoverStale(ownerId) {
    const session = checkedDB(db);
    await run(session.prepare("UPDATE storybank_linkedin_jobs SET status = 'unknown', reason = 'dispatch_interrupted', finished_at = ? WHERE owner_user_id = ? AND status = 'sending' AND lease_until <= ?").bind(clock(), ownerId, clock()));
  }
  async function requireConnection(ownerId) {
    const row = await connectionRaw(ownerId);
    if (!row || row.client_id !== config.clientId || row.expires_at <= clock() + 60_000) fail('LINKEDIN_RECONNECT_REQUIRED', 'Connect or reconnect LinkedIn before publishing.', 409);
    return row;
  }
  async function sourceFor(user, storyId) {
    const { authority, context } = hostedContext(user);
    const service = createD1StoryBank({ db, authority });
    const story = await service.invoke(context, 'getStory', [storyId]);
    if (!story.activeApprovalId) fail('APPROVAL_REQUIRED', 'Approve the current story version before preparing a publication.', 409);
    const approval = await service.invoke(context, 'getApproval', [story.activeApprovalId]);
    if (approval.revokedAt || !equalDigest(hashSnapshot(approvalSnapshot(story)), approval.record.hash)) fail('APPROVAL_CHANGED', 'The story changed. Review and approve it again.', 409);
    if (story.mediaIds.length) fail('MEDIA_NOT_SUPPORTED', 'This integration currently publishes text only.', 409);
    return { story, approval };
  }
  async function makePreview(user, input) {
    strictObject(input, ['storyId', 'expectedRevision', 'visibility', 'dueAt', 'timeZone', 'mode']);
    if (!validId(input.storyId) || !Number.isSafeInteger(input.expectedRevision) || !['PUBLIC', 'CONNECTIONS'].includes(input.visibility) || !['now', 'scheduled'].includes(input.mode)) fail('INVALID_PUBLICATION', 'Choose a story, visibility and publishing time.', 400);
    const ownerId = owner(user);
    const connection = await requireConnection(ownerId);
    const { story, approval } = await sourceFor(user, input.storyId);
    if (story.revision !== input.expectedRevision) fail('APPROVAL_CHANGED', 'The story changed. Review and approve it again.', 409);
    if (story.destinationId !== connection.person_urn) fail('DESTINATION_CHANGED', 'Set the draft destination to your connected LinkedIn identity and approve it again.', 409);
    const dueAt = safeDate(input.dueAt, input.timeZone, clock());
    if (input.mode === 'now' && Math.abs(dueAt - clock()) > 60_000) fail('INVALID_DATE', 'Review the post again immediately before publishing.', 409);
    if (input.mode === 'scheduled' && (!config.schedulerVerified || config.schedulerOwnerId !== ownerId)) fail('SCHEDULER_UNAVAILABLE', 'Automatic scheduling is not configured or verified. No post was queued.', 503);
    if (input.mode === 'scheduled' && dueAt <= clock() + 60_000) fail('INVALID_DATE', 'Schedule at least one minute ahead or choose Publish now.', 400);
    if (connection.expires_at <= dueAt + 60_000) fail('CONNECTION_EXPIRES_BEFORE_POST', 'Reconnect LinkedIn before scheduling beyond this connection’s expiry.', 409);
    const snapshot = { schema: 'storybank.linkedin-publication.v1', ownerId, storyId: story.id, sourceRevision: story.revision,
      sourceApprovalId: approval.record.id, sourceHash: approval.record.hash, connectionId: connection.connection_id,
      author: connection.person_urn, displayName: connection.display_name, text: approval.record.snapshot.text,
      visibility: input.visibility, dueAt: new Date(dueAt).toISOString(), timeZone: input.timeZone, mode: input.mode };
    return { snapshot, hash: sha256(JSON.stringify(snapshot)), connection, story, dueAt };
  }
  async function findJob(ownerId, id) { return checkedDB(db).prepare('SELECT * FROM storybank_linkedin_jobs WHERE owner_user_id = ? AND id = ?').bind(ownerId, id).first(); }

  return Object.freeze({
    async status(user) {
      const ownerId = owner(user); await recoverStale(ownerId);
      const result = await checkedDB(db).prepare('SELECT * FROM storybank_linkedin_jobs WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 100').bind(ownerId).all();
      const active = await checkedDB(db).prepare("SELECT * FROM storybank_linkedin_jobs WHERE owner_user_id = ? AND status IN ('queued', 'sending')").bind(ownerId).all();
      // Never hide an old pending automatic publication behind the history cap:
      // it must remain visible and cancellable even after many finished posts.
      const jobs = [...new Map([...(result.results ?? []), ...(active.results ?? [])].map(row => [row.id, row])).values()]
        .sort((a, b) => b.created_at - a.created_at || String(a.id).localeCompare(String(b.id)));
      return { connection: publicConnection(await connectionRaw(ownerId), clock()), jobs: jobs.map(publicJob), activeStoryIds: [...new Set((active.results ?? []).map(row => row.story_id))] };
    },
    async storeOAuthAttempt(user, attempt) {
      const ownerId = owner(user); const session = checkedDB(db);
      await run(session.prepare('DELETE FROM storybank_linkedin_oauth WHERE expires_at <= ?').bind(clock()));
      await run(session.prepare(`INSERT INTO storybank_linkedin_oauth (state_hash, owner_user_id, cookie_hash, nonce_hash, verifier_ciphertext, expires_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_user_id) DO UPDATE SET state_hash = excluded.state_hash, cookie_hash = excluded.cookie_hash,
        nonce_hash = excluded.nonce_hash, verifier_ciphertext = excluded.verifier_ciphertext, expires_at = excluded.expires_at, consumed_at = NULL`).bind(attempt.stateHash, ownerId, attempt.cookieHash, attempt.nonceHash, attempt.verifierCiphertext, clock() + 600_000));
    },
    async consumeOAuthAttempt(user, { stateHash, cookieHash }) {
      const ownerId = owner(user);
      // Consume atomically but retain a cancellation guard through the async
      // provider exchange. Disconnect/new-connect/privacy deletion removes it.
      const row = await checkedDB(db).prepare('UPDATE storybank_linkedin_oauth SET consumed_at = ? WHERE state_hash = ? AND owner_user_id = ? AND cookie_hash = ? AND expires_at > ? AND consumed_at IS NULL RETURNING *').bind(clock(), stateHash, ownerId, cookieHash, clock()).first();
      if (!row) fail('OAUTH_STATE_INVALID', 'This connection attempt expired or belongs to another browser. Start again.', 403);
      return row;
    },
    async saveConnection(user, connection, { stateHash } = {}) {
      const ownerId = owner(user); await recoverStale(ownerId);
      if (!/^[a-f0-9]{64}$/.test(stateHash ?? '')) fail('OAUTH_STATE_INVALID', 'Restart the LinkedIn connection.', 403);
      const id = randomUUID();
      const cipher = await sealSecret(connection.accessToken, config.tokenKey, `linkedin:token:${ownerId}:${id}`);
      try {
        const changed = await run(checkedDB(db).prepare(`INSERT INTO storybank_linkedin_connections (owner_user_id, connection_id, client_id, subject, person_urn, display_name, token_ciphertext, expires_at, scopes, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM storybank_linkedin_oauth WHERE state_hash = ? AND owner_user_id = ? AND consumed_at IS NOT NULL AND expires_at > ?)
          ON CONFLICT(owner_user_id) DO UPDATE SET connection_id = excluded.connection_id, client_id = excluded.client_id,
          subject = excluded.subject, person_urn = excluded.person_urn, display_name = excluded.display_name, token_ciphertext = excluded.token_ciphertext,
          expires_at = excluded.expires_at, scopes = excluded.scopes, updated_at = excluded.updated_at`).bind(ownerId, id, config.clientId, connection.subject, connection.personUrn, connection.displayName, cipher, connection.expiresAt, connection.scopes, clock(), stateHash, ownerId, clock()));
        if (changed !== 1) fail('OAUTH_CANCELLED', 'This connection attempt was cancelled or replaced. No connection was saved.', 409);
      } catch (error) {
        if (String(error.message).includes('STORYBANK_PUBLISH_IN_FLIGHT')) fail('PUBLISH_IN_FLIGHT', 'A post is already sending. Wait for its result before reconnecting.', 409);
        if (String(error.message).includes('UNIQUE')) fail('LINKEDIN_ALREADY_LINKED', 'This LinkedIn account is already linked to another StoryBank workspace.', 409);
        throw error;
      }
      await run(checkedDB(db).prepare('DELETE FROM storybank_linkedin_oauth WHERE owner_user_id = ? AND state_hash = ?').bind(ownerId, stateHash));
      return publicConnection(await connectionRaw(ownerId), clock());
    },
    async disconnect(user) {
      const ownerId = owner(user); await recoverStale(ownerId);
      // Invalidate async callback completion BEFORE removing the connection.
      // A callback that already committed is removed by the next statement;
      // one that has not committed can no longer pass its insertion guard.
      await run(checkedDB(db).prepare('DELETE FROM storybank_linkedin_oauth WHERE owner_user_id = ?').bind(ownerId));
      try { await run(checkedDB(db).prepare('DELETE FROM storybank_linkedin_connections WHERE owner_user_id = ?').bind(ownerId)); }
      catch (error) { if (String(error.message).includes('STORYBANK_PUBLISH_IN_FLIGHT')) fail('PUBLISH_IN_FLIGHT', 'A post is already sending and cannot be recalled. Check its result before disconnecting.', 409); throw error; }
      return { disconnected: true, remoteGrantRevoked: false, message: 'Stored credentials were removed and queued posts cancelled. This does not revoke LinkedIn’s grant; remove StoryBank in LinkedIn’s permitted-services settings if you want to revoke that grant too.' };
    },
    async preview(user, input) { const value = await makePreview(user, input); return { snapshot: value.snapshot, hash: value.hash }; },
    async enqueue(user, input) {
      strictObject(input, ['publication', 'previewHash', 'idempotencyKey', 'confirmation']);
      if (!config.publishingEnabled) fail('PUBLISHING_DISABLED', 'Live LinkedIn publishing is not enabled.', 503);
      if (input.confirmation !== 'PUBLISH_EXACT_VERSION' || !/^[a-f0-9]{64}$/.test(input.previewHash ?? '') || !/^[A-Za-z0-9_-]{16,100}$/.test(input.idempotencyKey ?? '')) fail('CONFIRMATION_REQUIRED', 'Confirm the exact preview before publishing.', 409);
      const ownerId = owner(user); await recoverStale(ownerId);
      const old = await checkedDB(db).prepare('SELECT * FROM storybank_linkedin_jobs WHERE owner_user_id = ? AND idempotency_key = ?').bind(ownerId, input.idempotencyKey).first();
      if (old) { if (!equalDigest(old.snapshot_hash, input.previewHash)) fail('IDEMPOTENCY_CONFLICT', 'This request key belongs to a different approved version.', 409); return publicJob(old); }
      const value = await makePreview(user, input.publication);
      if (!equalDigest(value.hash, input.previewHash)) fail('PREVIEW_CHANGED', 'The preview changed. Review it again before publishing.', 409);
      const tenantId = personalWorkspaceId(ownerId);
      // Capture revision only after domain integrity validation. The SQL guard
      // below also checks the exact current source revision/approval. Triggers
      // close the final source-edit race after insertion and after dispatch.
      const id = randomUUID(); const contentHash = sha256(JSON.stringify({ author: value.snapshot.author, text: value.snapshot.text, visibility: value.snapshot.visibility }));
      try {
        const inserted = await run(checkedDB(db).prepare(`INSERT INTO storybank_linkedin_jobs
          (id, owner_user_id, tenant_id, story_id, source_revision, source_approval_id, connection_id, snapshot, snapshot_hash, content_hash, idempotency_key, due_at, time_zone, status, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?
          WHERE EXISTS (SELECT 1 FROM storybank_personal_workspaces w, json_each(w.payload, '$.collections.stories') s
            WHERE w.owner_user_id = ? AND w.tenant_id = ? AND json_extract(s.value, '$[1].id') = ?
            AND json_extract(s.value, '$[1].revision') = ? AND json_extract(s.value, '$[1].activeApprovalId') = ?)
          AND EXISTS (SELECT 1 FROM storybank_linkedin_connections WHERE owner_user_id = ? AND connection_id = ? AND expires_at > ?)`)
          .bind(id, ownerId, tenantId, value.story.id, value.story.revision, value.story.activeApprovalId, value.connection.connection_id,
            JSON.stringify(value.snapshot), value.hash, contentHash, input.idempotencyKey, value.dueAt, input.publication.timeZone, clock(),
            ownerId, tenantId, value.story.id, value.story.revision, value.story.activeApprovalId, ownerId, value.connection.connection_id, value.dueAt + 60_000));
        if (inserted !== 1) fail('PREVIEW_CHANGED', 'The story or LinkedIn connection changed. Review again.', 409);
      } catch (error) {
        if (String(error.message).includes('UNIQUE')) {
          const existing = await checkedDB(db).prepare('SELECT * FROM storybank_linkedin_jobs WHERE owner_user_id = ? AND idempotency_key = ?').bind(ownerId, input.idempotencyKey).first();
          if (existing && equalDigest(existing.snapshot_hash, input.previewHash)) return publicJob(existing);
          fail('DUPLICATE_PUBLICATION', 'This content or approval already has a publication. Check its result; do not send a duplicate.', 409);
        }
        throw error;
      }
      return publicJob(await findJob(ownerId, id));
    },
    async cancel(user, id) {
      const ownerId = owner(user); await recoverStale(ownerId);
      if (!validId(id)) fail('NOT_FOUND', 'Publication not found.', 404);
      const changed = await run(checkedDB(db).prepare("UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'user_cancelled', finished_at = ? WHERE owner_user_id = ? AND id = ? AND status = 'queued'").bind(clock(), ownerId, id));
      const row = await findJob(ownerId, id);
      if (!row) fail('NOT_FOUND', 'Publication not found.', 404);
      if (!changed && row.status !== 'cancelled') fail('CANNOT_CANCEL', 'This publication already started or finished. Check its status; it cannot be recalled here.', 409);
      return publicJob(row);
    },
    async dispatch(user, id) {
      const ownerId = owner(user); await recoverStale(ownerId);
      if (!config.publishingEnabled) fail('PUBLISHING_DISABLED', 'Live LinkedIn publishing is not enabled.', 503);
      const current = await findJob(ownerId, id);
      if (!current) fail('NOT_FOUND', 'Publication not found.', 404);
      if (current.status !== 'queued' || (current.due_at > clock() && JSON.parse(current.snapshot).mode !== 'now')) return publicJob(current);
      if (JSON.parse(current.snapshot).mode === 'scheduled' && (!config.schedulerVerified || config.schedulerOwnerId !== ownerId)) fail('SCHEDULER_UNAVAILABLE', 'The recurring runner is not verified.', 503);
      async function cancelLateQueued() {
        await run(checkedDB(db).prepare("UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'scheduled_deadline_missed', finished_at = ? WHERE owner_user_id = ? AND id = ? AND status = 'queued' AND attempts = 0 AND json_extract(snapshot, '$.mode') = 'scheduled' AND due_at < ?")
          .bind(clock(), ownerId, id, clock() - MAX_SCHEDULE_LATENESS_MS));
      }
      if (JSON.parse(current.snapshot).mode === 'scheduled' && current.due_at < clock() - MAX_SCHEDULE_LATENESS_MS) {
        await cancelLateQueued(); return publicJob(await findJob(ownerId, id));
      }
      const connection = await requireConnection(ownerId);
      if (connection.connection_id !== current.connection_id) fail('CONNECTION_CHANGED', 'The LinkedIn account changed. Approve this post again.', 409);
      const { story, approval } = await sourceFor(user, current.story_id);
      const snapshot = JSON.parse(current.snapshot);
      if (!equalDigest(sha256(current.snapshot), current.snapshot_hash) || !equalDigest(approval.record.hash, snapshot.sourceHash) || story.revision !== current.source_revision || story.activeApprovalId !== current.source_approval_id || snapshot.author !== connection.person_urn || snapshot.text !== approval.record.snapshot.text) fail('APPROVAL_CHANGED', 'The approved version is no longer current.', 409);
      const accessToken = await openSecret(connection.token_ciphertext, config.tokenKey, `linkedin:token:${ownerId}:${connection.connection_id}`);
      const lease = randomUUID();
      // One atomic reservation before the network call. A crashed/expired lease
      // becomes UNKNOWN, never QUEUED. We do not claim remote exactly-once.
      const row = await checkedDB(db).prepare(`UPDATE storybank_linkedin_jobs SET status = 'sending', lease_id = ?, lease_until = ?, attempts = attempts + 1
        WHERE owner_user_id = ? AND id = ? AND status = 'queued' AND (due_at <= ? OR json_extract(snapshot, '$.mode') = 'now') AND attempts = 0
        AND (json_extract(snapshot, '$.mode') = 'now' OR due_at >= ?)
        AND EXISTS (SELECT 1 FROM storybank_personal_workspaces w, json_each(w.payload, '$.collections.stories') s
          WHERE w.owner_user_id = ? AND json_extract(s.value, '$[1].id') = storybank_linkedin_jobs.story_id
          AND json_extract(s.value, '$[1].revision') = storybank_linkedin_jobs.source_revision
          AND json_extract(s.value, '$[1].activeApprovalId') = storybank_linkedin_jobs.source_approval_id)
        AND EXISTS (SELECT 1 FROM storybank_linkedin_connections c WHERE c.owner_user_id = ? AND c.connection_id = storybank_linkedin_jobs.connection_id AND c.expires_at > ?)
        RETURNING *`).bind(lease, clock() + 90_000, ownerId, id, clock(), clock() - MAX_SCHEDULE_LATENESS_MS, ownerId, ownerId, clock() + 60_000).first();
      if (!row) { await cancelLateQueued(); return publicJob(await findJob(ownerId, id)); }
      // Reservation responses can be delayed. Never transmit on an expired or
      // recovered lease, even if an earlier response said it was acquired.
      const fresh = await findJob(ownerId, id);
      if (!fresh || fresh.status !== 'sending' || fresh.lease_id !== lease || clock() + 15_000 >= fresh.lease_until) {
        await run(checkedDB(db).prepare("UPDATE storybank_linkedin_jobs SET status = 'unknown', reason = 'dispatch_interrupted', finished_at = ? WHERE owner_user_id = ? AND id = ? AND lease_id = ? AND status = 'sending'").bind(clock(), ownerId, id, lease));
        return publicJob(await findJob(ownerId, id));
      }
      if (snapshot.mode === 'scheduled' && fresh.due_at < clock() - MAX_SCHEDULE_LATENESS_MS) {
        await run(checkedDB(db).prepare("UPDATE storybank_linkedin_jobs SET status = 'cancelled', reason = 'scheduled_deadline_missed', finished_at = ? WHERE owner_user_id = ? AND id = ? AND lease_id = ? AND status = 'sending'").bind(clock(), ownerId, id, lease));
        return publicJob(await findJob(ownerId, id));
      }
      const outcome = await publishLinkedInText(config, { accessToken, snapshot, fetcher });
      try {
        const changed = await run(checkedDB(db).prepare("UPDATE storybank_linkedin_jobs SET status = ?, post_urn = ?, reason = ?, finished_at = ? WHERE owner_user_id = ? AND id = ? AND lease_id = ? AND status IN ('sending', 'unknown')").bind(outcome.status, outcome.postUrn, outcome.reason, clock(), ownerId, id, lease));
        if (changed !== 1) fail('PUBLISH_RESULT_UNRECORDED', 'LinkedIn may have received the post, but its result could not be recorded. Do not retry.', 503);
      } catch { fail('PUBLISH_RESULT_UNRECORDED', 'LinkedIn may have received the post, but its result could not be recorded. Do not retry.', 503); }
      return publicJob(await findJob(ownerId, id));
    },
  });
}
