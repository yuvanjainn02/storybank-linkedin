/**
 * Private audio storage, used only by trusted server routes. The `user` argument
 * MUST come from Sites' server-only getChatGPTUser(), never a client selector.
 * This module does not record audio, transcribe, call AI, or publish R2 objects.
 *
 * D1 schema is owned by the hosted migrations. Required table: storybank_audio
 * (owner_id, id, object_key UNIQUE, mime_type, size, created_at, status,
 * upload_complete DEFAULT 0); primary key (owner_id,id). Status is one of
 * uploading/active/deleting. Size must be 1..10485760; upload_complete is 0/1.
 *
 * Migration 0003 atomically enforces durable owner and project byte/object quotas
 * plus fixed-window admitted-attempt budgets on every reservation INSERT. All
 * states count. Unknown body sizes reserve the full per-file maximum before
 * reading; known sizes are bounded to their declared length. See
 * docs/audio-resource-limits.md for configuration and conservative recovery.
 *
 * An upload reservation precedes request-body consumption and R2 put. Only a confirmed put can set
 * upload_complete=1, and only an uploading row can become active. Deletion first
 * tombstones the row, then deletes R2, then erases metadata ONLY if the upload
 * was already complete before that R2 deletion. This prevents late uploads from
 * becoming visible or losing their cleanup reference. Crashed/uncertain uploads
 * retain hidden tombstones and count as remaining until explicitly reconciled;
 * do not clear them based merely on age. There is no distributed transaction,
 * backup erasure, or guarantee against a new upload after a cleanup snapshot.
 *
 * APIs: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
 * https://developers.cloudflare.com/d1/worker-api/d1-database/
 */
import { createHash, randomUUID } from 'node:crypto';
import { fail, StoryBankError } from './errors.mjs';
import { verifyDeploymentRequest } from './deployment-config.mjs';
import { verifyMutationRequest, verifyWorkspaceRequest, readBoundedBody, safeError, jsonResponse } from './hosted-http.mjs';

export const AUDIO_MAX_BYTES = 10 * 1024 * 1024;
export const AUDIO_MIME_TYPES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/flac']);
const MIME_TYPES = new Set(AUDIO_MIME_TYPES);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FIELDS = 'owner_id, id, object_key, mime_type, size, created_at, status, upload_complete';
const SELECT = `SELECT ${FIELDS} FROM storybank_audio WHERE owner_id = ? AND id = ?`;
const LIST = `SELECT ${FIELDS} FROM storybank_audio WHERE owner_id = ? ORDER BY created_at DESC, id DESC`;
const INSERT = `INSERT INTO storybank_audio (owner_id, id, object_key, mime_type, size, created_at, status, upload_complete)
  SELECT ?, ?, ?, ?, ?, ?, 'uploading', 0 FROM storybank_audio_policy WHERE id = 1
    AND (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN ('audio_reserve_budget', 'audio_charge_attempt', 'audio_reservation_immutable')) = 3
  RETURNING owner_id, id, size`;
const RESIZE = "UPDATE storybank_audio SET size = ? WHERE owner_id = ? AND id = ? AND status = 'uploading' AND upload_complete = 0";
// Only the original uploader may call this, and only before invoking R2 put.
const RELEASE_UNSTARTED = 'DELETE FROM storybank_audio WHERE owner_id = ? AND id = ? AND upload_complete = 0';
const COMPLETE = 'UPDATE storybank_audio SET upload_complete = 1 WHERE owner_id = ? AND id = ?';
const ACTIVATE = "UPDATE storybank_audio SET status = 'active' WHERE owner_id = ? AND id = ? AND status = 'uploading' AND upload_complete = 1";
const TOMBSTONE = "UPDATE storybank_audio SET status = 'deleting' WHERE owner_id = ? AND id = ?";
const TOMBSTONE_ALL = "UPDATE storybank_audio SET status = 'deleting' WHERE owner_id = ?";
const ERASE = "DELETE FROM storybank_audio WHERE owner_id = ? AND id = ? AND status = 'deleting' AND upload_complete = 1";

function ownerFor(user) {
  if (!user || typeof user.userId !== 'string' || !user.userId.trim() || user.userId.length > 500) fail('UNAUTHENTICATED', 'Sign in to StoryBank to continue.', 401);
  return user.userId;
}
function storageFor(db, bucket) {
  if (!db || typeof db.prepare !== 'function' || !bucket || ['put', 'get', 'delete'].some((method) => typeof bucket[method] !== 'function')) fail('STORAGE_NOT_CONFIGURED', 'Your private audio storage is not configured yet.', 503);
  // Every request starts at the primary so an old replica cannot restore access
  // to a deleted recording. Related queries then remain sequentially consistent.
  return typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
}
function keyFor(owner, id) { return `audio/${createHash('sha256').update(owner, 'utf8').digest('hex')}/${id}`; }
function corrupt() { fail('AUDIO_STORAGE_CORRUPT', 'Stored audio metadata could not be verified safely.', 503); }
function checkRow(row, owner, id) {
  if (!row || row.owner_id !== owner || !ID.test(row.id) || (id !== undefined && row.id !== id) || row.object_key !== keyFor(owner, row.id) || !MIME_TYPES.has(row.mime_type) || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > AUDIO_MAX_BYTES || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at)) || new Date(row.created_at).toISOString() !== row.created_at || !['uploading', 'active', 'deleting'].includes(row.status) || ![0, 1].includes(row.upload_complete) || (row.status === 'active' && row.upload_complete !== 1)) corrupt();
  return row;
}
async function readRow(db, owner, id) {
  const row = await db.prepare(SELECT).bind(owner, id).first();
  return row === null ? null : checkRow(row, owner, id);
}
async function readRows(db, owner) {
  const result = await db.prepare(LIST).bind(owner).all();
  if (result?.success !== true || !Array.isArray(result.results)) corrupt();
  return result.results.map((row) => checkRow(row, owner));
}
function reservationFailure(error) {
  // D1 wraps SQLite errors in a cause. Inspect only known trigger sentinels;
  // never send raw SQL, bound owner IDs, object keys, or backend messages.
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    const message = typeof current.message === 'string' ? current.message : '';
    if (/\bSTORYBANK_AUDIO_OWNER_QUOTA\b/.test(message)) fail('AUDIO_OWNER_QUOTA_REACHED', 'Your tester audio storage is full. Delete recordings and finish any pending cleanup before uploading more.', 429);
    if (/\bSTORYBANK_AUDIO_PROJECT_QUOTA\b/.test(message)) fail('AUDIO_PROJECT_QUOTA_REACHED', 'The tester audio storage budget is full. New uploads are paused; existing recordings can still be played or deleted.', 429);
    if (/\bSTORYBANK_AUDIO_RATE_LIMIT\b/.test(message)) fail('AUDIO_UPLOAD_RATE_LIMITED', 'The tester upload budget for this 10-minute window is used. Wait for the next window before trying again.', 429);
    if (/\bSTORYBANK_AUDIO_POLICY_MISSING\b/.test(message)) fail('AUDIO_LIMITS_NOT_CONFIGURED', 'Audio upload limits are not configured. Uploads are paused.', 503);
  }
}
async function reserve(db, values) {
  let result;
  try { result = await db.prepare(INSERT).bind(...values).all(); }
  catch (error) {
    reservationFailure(error);
    fail('AUDIO_STORAGE_OUTCOME_UNKNOWN', 'The audio reservation could not be confirmed. Refresh before retrying; it may have been applied.', 503);
  }
  // D1 meta.changes includes trigger writes and expired-counter pruning. Use
  // RETURNING, not an assumed change count, to confirm this exact reservation.
  if (result?.success !== true || !Array.isArray(result.results) || result.results.length > 1) fail('AUDIO_STORAGE_OUTCOME_UNKNOWN', 'The audio reservation returned an unrecognized result. Refresh before retrying.', 503);
  if (result.results.length === 0) fail('AUDIO_LIMITS_NOT_CONFIGURED', 'Audio upload limits are not configured. Uploads are paused.', 503);
  const row = result.results[0];
  if (row.owner_id !== values[0] || row.id !== values[1] || row.size !== values[4]) fail('AUDIO_STORAGE_OUTCOME_UNKNOWN', 'The audio reservation could not be verified. Refresh before retrying.', 503);
}
async function write(db, sql, values, { multiple = false } = {}) {
  let result;
  try { result = await db.prepare(sql).bind(...values).run(); }
  catch { fail('AUDIO_STORAGE_OUTCOME_UNKNOWN', 'The audio storage change could not be confirmed. Refresh before retrying; it may have been applied.', 503); }
  if (result?.success !== true || !Number.isSafeInteger(result?.meta?.changes) || result.meta.changes < 0 || (!multiple && result.meta.changes > 1)) fail('AUDIO_STORAGE_OUTCOME_UNKNOWN', 'The audio storage change returned an unrecognized result. Refresh before retrying.', 503);
  return result.meta.changes;
}
function publicRecording(row) { return { id: row.id, mimeType: row.mime_type, size: row.size, createdAt: row.created_at }; }
function audioMime(request) {
  // Browser MediaRecorder adds codecs parameters. Persist only a known base
  // media type; never replay caller-supplied header parameters in playback.
  const type = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!MIME_TYPES.has(type)) fail('AUDIO_TYPE_REJECTED', 'Choose a WebM, Ogg, MP4/M4A, MP3, WAV, AAC, or FLAC audio file.', 415);
  return type;
}
function playbackRange(request, size) {
  const header = request.headers.get('range');
  // No validators are issued, so an If-Range condition cannot match. Send the
  // complete object instead of incorrectly confirming an unknown validator.
  if (!header || request.headers.has('if-range')) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    const length = Math.min(size, suffix);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(requestedEnd) || offset >= size || requestedEnd < offset) return false;
  return { offset, length: Math.min(size - 1, requestedEnd) - offset + 1 };
}

/**
 * Idempotent owner-scoped deletion. Unknown and foreign IDs are identical no-ops.
 * A tombstone with an incomplete upload MUST survive even a successful delete:
 * the uploader could still write its object after this deletion returns.
 */
async function deleteRecording(db, bucket, owner, id) {
  let row = await readRow(db, owner, id);
  if (!row) return { deleted: true, remaining: 0 };
  await write(db, TOMBSTONE, [owner, id]);
  row = await readRow(db, owner, id);
  if (!row) return { deleted: true, remaining: 0 };
  if (row.status !== 'deleting') fail('AUDIO_DELETE_CONFLICT', 'Audio changed while deletion was starting. Retry deletion.', 409);
  // Capture this BEFORE deleting R2. Re-reading a newly completed upload after
  // delete could erase its metadata while a late put has recreated the object.
  const uploadWasComplete = row.upload_complete === 1;
  try { await bucket.delete(row.object_key); }
  catch { fail('AUDIO_DELETE_PENDING', 'Audio is hidden, but file deletion could not be confirmed. Retry deletion to finish cleanup.', 503); }
  if (!uploadWasComplete) return { deleted: false, pending: true, remaining: 1 };
  await write(db, ERASE, [owner, id]);
  const remaining = await readRow(db, owner, id);
  if (remaining) fail('AUDIO_DELETE_PENDING', 'Audio is hidden, but metadata cleanup is still pending. Retry deletion.', 503);
  return { deleted: true, remaining: 0 };
}

async function upload(request, db, bucket, owner) {
  const mimeType = audioMime(request);
  if (request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') fail('AUDIO_ENCODING_REJECTED', 'Send the original audio bytes without HTTP compression.', 415);
  const advertised = request.headers.get('content-length');
  if (advertised !== null && (!/^\d+$/.test(advertised) || !Number.isSafeInteger(Number(advertised)) || Number(advertised) > AUDIO_MAX_BYTES)) fail('BODY_TOO_LARGE', 'This request is too large.', 413);
  if (advertised !== null && Number(advertised) === 0) fail('AUDIO_EMPTY', 'Choose a nonempty audio recording.');
  const reservedBytes = advertised === null ? AUDIO_MAX_BYTES : Number(advertised);
  const id = randomUUID();
  const objectKey = keyFor(owner, id);
  const createdAt = new Date().toISOString();
  await reserve(db, [owner, id, objectKey, mimeType, reservedBytes, createdAt]);
  let bytes;
  try {
    bytes = await readBoundedBody(request, reservedBytes);
    if (bytes.byteLength === 0) fail('AUDIO_EMPTY', 'Choose a nonempty audio recording.');
    if (advertised !== null && bytes.byteLength !== reservedBytes) fail('AUDIO_LENGTH_MISMATCH', 'The audio length did not match the request. Choose the recording again.');
    if (await write(db, RESIZE, [bytes.byteLength, owner, id]) !== 1) fail('AUDIO_UPLOAD_CANCELLED', 'This upload was cancelled while audio deletion was in progress.', 409);
  } catch (error) {
    // No R2 put has been invoked by this uploader. Even if a concurrent cleanup
    // tombstoned the reservation, it is now safe to release it. Never refund the
    // attempt. A failed/uncertain release remains charged until reconciled.
    try { await write(db, RELEASE_UNSTARTED, [owner, id]); } catch { /* Conservative reservation retained if deletion failed. */ }
    throw error;
  }
  let object;
  try {
    object = await bucket.put(objectKey, bytes, { httpMetadata: { contentType: mimeType, cacheControl: 'private, no-store' } });
    if (!object || object.key !== objectKey || object.size !== bytes.byteLength) throw new Error('Unconfirmed R2 put');
  } catch {
    // Do not assume a failed put wrote nothing. Preserve the reservation and
    // hide it, then make a best-effort delete without claiming erasure.
    try { await deleteRecording(db, bucket, owner, id); } catch { /* A later owner cleanup can retry. */ }
    fail('AUDIO_UPLOAD_OUTCOME_UNKNOWN', 'The upload could not be confirmed and is hidden. Workspace deletion can retry private file cleanup.', 503);
  }
  if (await write(db, COMPLETE, [owner, id]) !== 1) {
    // This cannot happen through the supported deletion path. Never leave an
    // object intentionally live if metadata was removed by another system.
    try { await bucket.delete(objectKey); } catch { /* Report failure, never claim erasure. */ }
    fail('AUDIO_UPLOAD_CONFLICT', 'The upload metadata changed before the file could be saved.', 409);
  }
  const activated = await write(db, ACTIVATE, [owner, id]);
  if (activated !== 1) {
    await deleteRecording(db, bucket, owner, id);
    fail('AUDIO_UPLOAD_CANCELLED', 'This upload was cancelled while audio deletion was in progress.', 409);
  }
  return jsonResponse({ id }, 201);
}

/**
 * Called after the workspace-delete confirmation and same-origin checks.
 * @param {{user?: {userId: string} | null, db?: any, bucket?: any}} options
 */
export async function cleanupOwnerAudio({ user, db, bucket } = {}) {
  const owner = ownerFor(user);
  const session = storageFor(db, bucket);
  // Hide this owner's whole existing collection before attempting R2 deletion.
  await write(session, TOMBSTONE_ALL, [owner], { multiple: true });
  const rows = await readRows(session, owner);
  let deleted = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const result = await deleteRecording(session, bucket, owner, row.id);
      if (result.deleted) deleted++;
      else failures.push({ id: row.id, code: 'AUDIO_UPLOAD_PENDING' });
    } catch (error) {
      failures.push({ id: row.id, code: error instanceof StoryBankError ? error.code : 'AUDIO_CLEANUP_UNAVAILABLE' });
    }
  }
  const remaining = (await readRows(session, owner)).length;
  return { deleted, remaining, failures };
}

/**
 * @param {Request} request
 * @param {{user?: {userId: string} | null, db?: any, bucket?: any, env?: any, allowLocalDevelopment?: boolean}} options
 */
export async function handleAudioRequest(request, { user, db, bucket, env = {}, allowLocalDevelopment = false } = {}) {
  try {
    const owner = ownerFor(user);
    verifyDeploymentRequest(request, { env, allowLocalDevelopment });
    const session = storageFor(db, bucket);
    const url = new URL(request.url);
    const collection = url.pathname === '/api/audio';
    const match = /^\/api\/audio\/([^/]+)$/.exec(url.pathname);
    const id = match?.[1];
    if (!collection && (!id || !ID.test(id))) fail('NOT_FOUND', 'Recording not found.', 404);
    if (['POST', 'DELETE'].includes(request.method)) {
      verifyMutationRequest(request, { env, allowLocalDevelopment });
      verifyWorkspaceRequest(request, owner);
    }
    if (collection && request.method === 'POST') return await upload(request, session, bucket, owner);
    if (collection && request.method === 'GET') {
      // A collection fetch must belong to the workspace currently displayed.
      verifyWorkspaceRequest(request, owner);
      return jsonResponse({ recordings: (await readRows(session, owner)).filter((row) => row.status === 'active').map(publicRecording) });
    }
    if (id && request.method === 'DELETE') {
      const result = await deleteRecording(session, bucket, owner, id);
      return jsonResponse(result, result.pending ? 202 : 200);
    }
    if (id && request.method === 'GET') {
      const row = await readRow(session, owner, id);
      if (!row || row.status !== 'active') fail('NOT_FOUND', 'Recording not found.', 404);
      const range = playbackRange(request, row.size);
      if (range === false) {
        const response = jsonResponse({ error: 'AUDIO_RANGE_REJECTED', message: 'Choose one valid byte range for this recording.' }, 416);
        response.headers.set('content-range', `bytes */${row.size}`);
        return response;
      }
      const object = await bucket.get(row.object_key, range ? { range } : undefined);
      if (!object) fail('NOT_FOUND', 'Recording not found.', 404);
      if (!object.body || object.key !== row.object_key || object.size !== row.size) corrupt();
      return new Response(object.body, { status: range ? 206 : 200, headers: {
        'content-type': row.mime_type,
        'content-length': String(range ? range.length : row.size),
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${range.offset}-${range.offset + range.length - 1}/${row.size}` } : {}),
        'cache-control': 'private, no-store',
        'vary': 'Cookie',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-security-policy': "default-src 'none'; sandbox",
        'referrer-policy': 'no-referrer',
      } });
    }
    fail('METHOD_NOT_ALLOWED', 'This audio action is not supported.', 405);
  } catch (error) { return safeError(error); }
}
