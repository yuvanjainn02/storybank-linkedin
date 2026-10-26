import { plainText } from './plain-text.mjs';
/**
 * Server-only Cloudflare D1 adapter. Import only from trusted server routes.
 * The platform verifies the session; this module never authenticates client IDs.
 * Schema creation/migrations belong to deployment tooling, never an invocation.
 * No provider/network side effects may be added to the operation allowlist.
 * API contract: https://developers.cloudflare.com/d1/worker-api/prepared-statements/
 */
import { createHash } from 'node:crypto';
import { StoryBankRepository } from './repository.mjs';
import { StoryBankError } from './errors.mjs';
import { approvalSnapshot, hashSnapshot } from './approval.mjs';
import { validateWritingProfile } from './writing-profile.mjs';
import { validateCalibration, validateFeedback } from './calibration.mjs';

export const STORYBANK_D1_SCHEMA_SQL = `CREATE TABLE storybank_personal_workspaces (
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (tenant_id, owner_user_id)
);`;
export const STORYBANK_D1_PAYLOAD_LIMIT = 1_000_000; // Conservative app-level aggregate cap, in UTF-8 bytes.
const COLLECTIONS = Object.freeze(['stories', 'approvals', 'jobs', 'idempotency', 'approvalJobs', 'integrations', 'profiles', 'calibrations', 'profileProposals']);
const READS = ['getStory', 'listStories', 'getApproval', 'getJob', 'listJobs', 'integrationStatus', 'listAudit', 'exportOwnData', 'getWritingProfile', 'listWritingProfileVersions', 'exportWritingSkill', 'getCalibration', 'getWritingRevision'];
const WRITES = ['createStory', 'updateStory', 'approveStory', 'revokeApproval', 'schedulePlan', 'cancelJob', 'runDuePlans', 'deleteStory', 'deleteOwnData', 'saveWritingProfile', 'deleteWritingProfile', 'resetWritingProfile', 'createCalibration', 'addCalibrationFeedback', 'proposeWritingRevision', 'applyWritingRevision', 'deleteCalibration'];
const PERMISSIONS = new Map([...READS.map((name) => [name, 'read']), ...WRITES.map((name) => [name, 'write']), ['revokeIntegration', 'owner']]);
export const STORYBANK_D1_METHODS = Object.freeze([...PERMISSIONS.keys()]);
const KEY = (...parts) => JSON.stringify(parts);
const OBJECT = (value) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const NONEMPTY = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;
const INTEGER = (value) => Number.isSafeInteger(value) && value >= 0;
const DIGEST = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const ISO = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const REASONS = ['story_changed', 'superseded', 'story_deleted', 'approval_revoked', 'integration_revoked', 'user_cancelled', 'integration_disabled', 'approval_invalid'];
const COUNTS = ['stories', 'approvals', 'jobs', 'idempotencyReservations', 'approvalJobReservations', 'writingProfileVersions', 'calibrations', 'feedbackEntries', 'writingRevisionProposals', 'mediaReferences', 'auditEvents'];
const AUDIT_FIELDS = Object.freeze({
  'story.created': [], 'story.updated': ['revision'], 'story.approved': ['approvalId', 'hash'], 'story.deleted': [],
  'approval.revoked': ['reason'], 'job.planned': ['approvalId', 'dueAt'], 'job.cancelled': ['reason'], 'job.blocked': ['reason'],
  'integration.revoked': [], 'writing_profile.saved': ['version'], 'writing_profile.deleted': [], 'writing_profile.proposed': ['baseVersion'],
  'writing_profile.revision_applied': ['version'], 'calibration.created': ['profileVersion'], 'calibration.feedback_saved': ['feedbackId'],
  'calibration.deleted': [], 'privacy.deleted': ['counts'],
});
const SELECT = 'SELECT tenant_id, owner_user_id, revision, payload FROM storybank_personal_workspaces WHERE tenant_id = ? AND owner_user_id = ?';
const INSERT = 'INSERT INTO storybank_personal_workspaces (tenant_id, owner_user_id, revision, payload) VALUES (?, ?, 1, ?) ON CONFLICT (tenant_id, owner_user_id) DO NOTHING';
const UPDATE = 'UPDATE storybank_personal_workspaces SET revision = revision + 1, payload = ? WHERE tenant_id = ? AND owner_user_id = ? AND revision = ?';

function error(code, message, status = 503) { return new StoryBankError(code, message, status); }
function corrupt() { throw error('STORAGE_CORRUPT', 'Stored StoryBank data failed integrity validation. No operation was applied.'); }
function check(condition) { if (!condition) corrupt(); }
function exact(value, fields) { check(OBJECT(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field))); }
function own(value, identity, ownerField = 'userId') { check(value.tenantId === identity.tenantId && value[ownerField] === identity.userId); }
function validProfile(value) {
  try {
    const normalized = validateWritingProfile(value);
    exact(value, Object.keys(normalized));
    for (const field of Object.keys(normalized)) check(JSON.stringify(value[field]) === JSON.stringify(normalized[field]));
  } catch { corrupt(); }
}
function storyFields(value) {
  check(typeof value.title === 'string' && value.title.length <= 250 && typeof value.text === 'string' && value.text.length <= 20_000);
  check(typeof value.source === 'string' && value.source.length <= 5_000 && value.platform === 'linkedin');
  check(value.destinationId === null || (NONEMPTY(value.destinationId) && value.destinationId.length <= 200));
  check(Array.isArray(value.mediaIds) && value.mediaIds.length <= 20 && new Set(value.mediaIds).size === value.mediaIds.length && value.mediaIds.every((id) => NONEMPTY(id) && id.length <= 200));
  check(INTEGER(value.revision) && value.revision >= 1);
}
function keyed(recordKey, parts) { check(recordKey === KEY(...parts) && parts.every(NONEMPTY)); }

export function personalWorkspaceId(userId) {
  if (!NONEMPTY(userId)) throw new TypeError('A verified, nonempty platform user ID of at most 500 characters is required.');
  return `personal_${createHash('sha256').update(userId, 'utf8').digest('hex')}`;
}

function validateEntry(collection, recordKey, value, identity) {
  check(typeof recordKey === 'string');
  const { tenantId, userId } = identity;
  if (collection === 'integrations') {
    check(recordKey === tenantId);
    exact(value, ['status', 'revokedAt']);
    check(value.status === 'revoked' && ISO(value.revokedAt));
    return;
  }
  if (collection === 'profiles') {
    keyed(recordKey, [tenantId, userId]);
    check(Array.isArray(value) && value.length > 0);
    value.forEach((version, index) => {
      exact(version, ['tenantId', 'userId', 'version', 'savedAt', 'preferences']);
      own(version, identity);
      check(version.version === index + 1 && ISO(version.savedAt));
      validProfile(version.preferences);
    });
    return;
  }
  if (collection === 'approvalJobs') {
    let parts;
    try { parts = JSON.parse(recordKey); } catch { corrupt(); }
    check(Array.isArray(parts) && parts.length === 3 && parts[0] === tenantId && parts[1] === userId);
    keyed(recordKey, parts);
    check(NONEMPTY(value));
    return;
  }
  if (collection === 'idempotency') {
    exact(value, ['tenantId', 'userId', 'idempotencyKey', 'hash', 'jobId']);
    own(value, identity);
    check(recordKey === KEY(tenantId, userId, value.idempotencyKey) && typeof value.idempotencyKey === 'string');
    check(value.idempotencyKey.length >= 8 && value.idempotencyKey.length <= 200 && DIGEST(value.hash) && NONEMPTY(value.jobId));
    return;
  }
  if (collection === 'approvals') {
    exact(value, ['record', 'revokedAt', 'revokedBy', 'revocationReason']);
    const record = value.record;
    exact(record, ['id', 'tenantId', 'storyId', 'approvedBy', 'approvedAt', 'hash', 'snapshot']);
    own(record, identity, 'approvedBy');
    keyed(recordKey, [tenantId, record.id]);
    check(NONEMPTY(record.storyId) && ISO(record.approvedAt) && DIGEST(record.hash));
    const snapshot = record.snapshot;
    exact(snapshot, ['schema', 'tenantId', 'storyId', 'revision', 'title', 'text', 'editorText', 'source', 'platform', 'destinationId', 'mediaIds']);
    check(snapshot.schema === 'storybank.approval.v2' && snapshot.tenantId === tenantId && snapshot.storyId === record.storyId);
    storyFields(snapshot);
    check(typeof snapshot.editorText === 'string' && snapshot.editorText.length <= 20_000 && plainText(snapshot.editorText) === snapshot.text && snapshot.text.length > 0 && snapshot.text.length <= 3_000);
    check(hashSnapshot(snapshot) === record.hash);
    if (value.revokedAt === null) check(value.revokedBy === null && value.revocationReason === null);
    else check(ISO(value.revokedAt) && value.revokedBy === userId && REASONS.includes(value.revocationReason));
    return;
  }
  if (collection === 'stories') {
    exact(value, ['title', 'text', 'source', 'platform', 'destinationId', 'mediaIds', 'id', 'tenantId', 'createdBy', 'revision', 'activeApprovalId', 'createdAt', 'updatedAt', ...(Object.hasOwn(value, 'reviewFeedback') ? ['reviewFeedback'] : [])]);
    own(value, identity, 'createdBy');
    keyed(recordKey, [tenantId, value.id]);
    storyFields(value);
    if (Object.hasOwn(value, 'reviewFeedback')) check(typeof value.reviewFeedback === 'string' && !!value.reviewFeedback.trim() && value.reviewFeedback.length <= 2000);
    check(ISO(value.createdAt) && ISO(value.updatedAt) && (value.activeApprovalId === null || NONEMPTY(value.activeApprovalId)));
    return;
  }
  if (collection === 'jobs') {
    exact(value, ['id', 'tenantId', 'storyId', 'approvalId', 'approvalHash', 'createdBy', 'createdAt', 'dueAt', 'status', 'reason', 'finishedAt', 'mode', 'publishAttempts']);
    own(value, identity, 'createdBy');
    keyed(recordKey, [tenantId, value.id]);
    check(NONEMPTY(value.storyId) && NONEMPTY(value.approvalId) && DIGEST(value.approvalHash) && ISO(value.createdAt) && ISO(value.dueAt));
    check(['planned', 'cancelled', 'blocked'].includes(value.status) && value.mode === 'local_plan_only' && value.publishAttempts === 0);
    if (value.status === 'planned') check(value.reason === null && value.finishedAt === null);
    else check(REASONS.includes(value.reason) && ISO(value.finishedAt));
    return;
  }
  if (collection === 'calibrations') {
    exact(value, ['id', 'tenantId', 'userId', 'createdAt', 'topic', 'facts', 'profileVersion', 'variants', 'feedback', 'mode']);
    own(value, identity);
    keyed(recordKey, [tenantId, userId, value.id]);
    check(ISO(value.createdAt) && INTEGER(value.profileVersion) && value.mode === 'non_ai_template_preview');
    check(Array.isArray(value.variants) && Array.isArray(value.feedback) && value.feedback.length <= 50);
    try { validateCalibration({ topic: value.topic, facts: value.facts, count: value.variants.length }); } catch { corrupt(); }
    const variants = new Set();
    for (const variant of value.variants) {
      exact(variant, ['id', 'label', 'text', 'kind']);
      check(NONEMPTY(variant.id) && !variants.has(variant.id) && NONEMPTY(variant.label) && typeof variant.text === 'string' && variant.text.length <= 30_000 && variant.kind === 'non_ai_template_preview');
      variants.add(variant.id);
    }
    const feedbackIds = new Set();
    for (const feedback of value.feedback) {
      exact(feedback, ['likes', 'dislikes', 'editReasons', 'feedback', 'editedText', 'variantId', 'id', 'savedAt', 'userId']);
      check(NONEMPTY(feedback.id) && !feedbackIds.has(feedback.id) && feedback.userId === userId && ISO(feedback.savedAt) && variants.has(feedback.variantId));
      feedbackIds.add(feedback.id);
      const { id, savedAt, userId: owner, ...fields } = feedback;
      try { validateFeedback(fields); } catch { corrupt(); }
    }
    return;
  }
  if (collection === 'profileProposals') {
    exact(value, ['id', 'tenantId', 'userId', 'calibrationId', 'createdAt', 'baseVersion', 'feedbackHash', 'preferences', 'truncated', 'status', 'appliedVersion', 'notice']);
    own(value, identity);
    keyed(recordKey, [tenantId, userId, value.id]);
    check(NONEMPTY(value.calibrationId) && ISO(value.createdAt) && INTEGER(value.baseVersion) && DIGEST(value.feedbackHash) && typeof value.truncated === 'boolean');
    check(['proposed', 'applied'].includes(value.status) && typeof value.notice === 'string' && value.notice.length <= 1_000);
    check(value.status === 'proposed' ? value.appliedVersion === null : INTEGER(value.appliedVersion) && value.appliedVersion === value.baseVersion + 1);
    validProfile(value.preferences);
    return;
  }
  corrupt();
}

function validateAudit(event, identity) {
  check(OBJECT(event) && Object.hasOwn(AUDIT_FIELDS, event.type));
  exact(event, ['id', 'tenantId', 'userId', 'actorUserId', 'type', 'entityId', 'at', ...AUDIT_FIELDS[event.type]]);
  own(event, identity);
  check(event.actorUserId === identity.userId && NONEMPTY(event.id) && NONEMPTY(event.entityId) && ISO(event.at));
  for (const field of ['revision', 'version', 'baseVersion', 'profileVersion']) if (field in event) check(INTEGER(event[field]));
  for (const field of ['approvalId', 'feedbackId']) if (field in event) check(NONEMPTY(event[field]));
  if ('hash' in event) check(DIGEST(event.hash));
  if ('dueAt' in event) check(ISO(event.dueAt));
  if ('reason' in event) check(REASONS.includes(event.reason));
  if ('counts' in event) { exact(event.counts, COUNTS); check(COUNTS.every((field) => INTEGER(event.counts[field]))); }
}

function validateRelations(state, identity) {
  const { tenantId, userId } = identity;
  for (const story of state.stories.values()) {
    if (!story.activeApprovalId) continue;
    const approval = state.approvals.get(KEY(tenantId, story.activeApprovalId));
    check(approval && !approval.revokedAt && approval.record.storyId === story.id && approval.record.hash === hashSnapshot(approvalSnapshot(story)));
  }
  for (const approval of state.approvals.values()) check(state.stories.has(KEY(tenantId, approval.record.storyId)));
  for (const reservation of state.idempotency.values()) {
    const job = state.jobs.get(KEY(tenantId, reservation.jobId));
    check(job && reservation.hash === hashSnapshot({ storyId: job.storyId, approvalId: job.approvalId, dueAt: job.dueAt }));
  }
  for (const [recordKey, jobId] of state.approvalJobs) {
    const [, , approvalId] = JSON.parse(recordKey);
    const job = state.jobs.get(KEY(tenantId, jobId));
    check(job && job.approvalId === approvalId);
  }
  for (const job of state.jobs.values()) {
    const story = state.stories.get(KEY(tenantId, job.storyId));
    const approval = state.approvals.get(KEY(tenantId, job.approvalId));
    check(state.approvalJobs.get(KEY(tenantId, userId, job.approvalId)) === job.id);
    check([...state.idempotency.values()].some((reservation) => reservation.jobId === job.id));
    if (approval) check(approval.record.storyId === job.storyId && approval.record.hash === job.approvalHash);
    if (job.status === 'planned') check(story && approval && !approval.revokedAt && story.activeApprovalId === job.approvalId);
  }
  const versions = state.profiles.get(KEY(tenantId, userId)) ?? [];
  for (const proposal of state.profileProposals.values()) {
    check(state.calibrations.has(KEY(tenantId, userId, proposal.calibrationId)));
    if (proposal.status === 'applied') check(versions[proposal.appliedVersion - 1] && JSON.stringify(versions[proposal.appliedVersion - 1].preferences) === JSON.stringify(proposal.preferences));
  }
}

function emptyState() { return { ...Object.fromEntries(COLLECTIONS.map((name) => [name, new Map()])), audit: [] }; }
function validateState(state, identity) {
  for (const name of COLLECTIONS) {
    check(state[name] instanceof Map);
    for (const [recordKey, value] of state[name]) validateEntry(name, recordKey, value, identity);
  }
  check(Array.isArray(state.audit));
  const auditIds = new Set();
  for (const event of state.audit) { validateAudit(event, identity); check(!auditIds.has(event.id)); auditIds.add(event.id); }
  validateRelations(state, identity);
}
function decode(payload, identity) {
  check(typeof payload === 'string' && new TextEncoder().encode(payload).length <= STORYBANK_D1_PAYLOAD_LIMIT);
  let envelope;
  try { envelope = JSON.parse(payload); } catch { corrupt(); }
  exact(envelope, ['schemaVersion', 'tenantId', 'ownerUserId', 'collections', 'audit']);
  check(envelope.schemaVersion === 1 && envelope.tenantId === identity.tenantId && envelope.ownerUserId === identity.userId);
  exact(envelope.collections, COLLECTIONS);
  const state = emptyState();
  for (const name of COLLECTIONS) {
    check(Array.isArray(envelope.collections[name]));
    for (const entry of envelope.collections[name]) {
      check(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && !state[name].has(entry[0]));
      state[name].set(entry[0], entry[1]);
    }
  }
  state.audit = envelope.audit;
  validateState(state, identity);
  return state;
}
function encode(state, identity) {
  validateState(state, identity);
  const payload = JSON.stringify({ schemaVersion: 1, tenantId: identity.tenantId, ownerUserId: identity.userId, collections: Object.fromEntries(COLLECTIONS.map((name) => [name, [...state[name]]])), audit: state.audit });
  if (new TextEncoder().encode(payload).length > STORYBANK_D1_PAYLOAD_LIMIT) throw error('WORKSPACE_CAPACITY', 'This personal workspace reached its storage limit. Export or remove existing data before adding more.', 413);
  return payload;
}
function hostedResult(method, result) {
  const scopes = { deleteStory: 'live_hosted_database', deleteWritingProfile: 'own_profile_live_hosted_database', deleteCalibration: 'own_calibration_live_hosted_database' };
  if (Object.hasOwn(scopes, method)) result.scope = scopes[method];
  if (['exportOwnData', 'deleteOwnData'].includes(method)) result.limitations.backups = 'Only live hosted repository records are affected. Provider backups, prior exports, and external copies are not erased. This is not cryptographic erasure; backup retention and deletion-tombstone replay are not implemented here.';
  return result;
}

/**
 * A closure-only server facade. Each mutation is a pure, synchronous domain
 * transaction against a freshly loaded owner aggregate, followed by one atomic
 * compare-and-swap. Nested repository calls share that state. A CAS miss reruns
 * the domain checks on fresh state; transport errors and unknown outcomes never
 * retry. This is NOT a distributed transaction or an exactly-once command API.
 */
export function createD1StoryBank({ db, authority, clock, id, maxAttempts = 5 } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('A trusted D1 database binding is required.');
  if (!authority || typeof authority.require !== 'function') throw new TypeError('A trusted synchronous context authority is required.');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new TypeError('maxAttempts must be between 1 and 10.');
  function identityFor(context, permission, expected) {
    const identity = authority.require(context, permission);
    if (!identity || typeof identity.then === 'function' || !NONEMPTY(identity.userId) || identity.tenantId !== personalWorkspaceId(identity.userId)) throw error('FORBIDDEN', 'Only your verified personal workspace is available.', 403);
    if (expected && (expected.userId !== identity.userId || expected.tenantId !== identity.tenantId)) throw error('UNAUTHENTICATED', 'The verified session identity changed.', 401);
    return { tenantId: identity.tenantId, userId: identity.userId, role: identity.role };
  }
  return Object.freeze({
    async invoke(context, method, args = []) {
      if (typeof method !== 'string' || !PERMISSIONS.has(method)) throw error('METHOD_NOT_ALLOWED', 'This operation is not exposed by StoryBank.', 405);
      const permission = PERMISSIONS.get(method);
      const identity = identityFor(context, permission);
      if (!Array.isArray(args) || args.length > 4) throw error('INVALID_ARGUMENTS', 'Operation arguments must be a short array.', 400);
      let inputs;
      try { inputs = structuredClone(args); } catch { throw error('INVALID_ARGUMENTS', 'Operation arguments must be serializable.', 400); }
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        identityFor(context, permission, identity);
        // Start each attempt at the primary, not an arbitrarily stale replica.
        const session = typeof db.withSession === 'function' ? db.withSession('first-primary') : db;
        let row;
        try { row = await session.prepare(SELECT).bind(identity.tenantId, identity.userId).first(); }
        catch { throw error('STORAGE_UNAVAILABLE', 'StoryBank storage could not be read. No operation was applied.'); }
        identityFor(context, permission, identity);
        let state;
        let revision = 0;
        if (row === null) state = emptyState();
        else {
          check(OBJECT(row) && row.tenant_id === identity.tenantId && row.owner_user_id === identity.userId && INTEGER(row.revision) && row.revision >= 1 && row.revision < Number.MAX_SAFE_INTEGER);
          revision = row.revision;
          state = decode(row.payload, identity);
        }
        const repository = new StoryBankRepository({ authority, ...(clock ? { clock } : {}), ...(id ? { id } : {}), store: { transact(operation) {
          const result = operation(state);
          if (result && typeof result.then === 'function') throw new TypeError('D1 domain operations must be synchronous.');
          return result;
        } } });
        const result = repository[method](context, ...structuredClone(inputs));
        if (permission === 'read') return hostedResult(method, result);
        const payload = encode(state, identity);
        // Recheck authorization after asynchronous reads and immediately before
        // submitting the atomic write. No externally supplied identity is used.
        identityFor(context, permission, identity);
        let committed;
        try {
          committed = revision === 0
            ? await session.prepare(INSERT).bind(identity.tenantId, identity.userId, payload).run()
            : await session.prepare(UPDATE).bind(payload, identity.tenantId, identity.userId, revision).run();
        } catch (cause) {
          if (String(cause?.message).includes('STORYBANK_PUBLISH_IN_FLIGHT')) throw error('PUBLISH_IN_FLIGHT', 'A LinkedIn post is already sending. Wait for its result before editing or deleting your workspace.', 409);
          throw error('STORAGE_OUTCOME_UNKNOWN', 'The storage write could not be confirmed. Refresh before trying again; it may have been applied.');
        }
        if (committed?.success !== true || ![0, 1].includes(committed?.meta?.changes)) throw error('STORAGE_OUTCOME_UNKNOWN', 'The storage write returned an unrecognized result. Refresh before trying again; it may have been applied.');
        if (committed.meta.changes === 1) return hostedResult(method, result);
        // changes=0 is the only safe retry signal. Another request won the CAS.
      }
      throw error('STORAGE_CONFLICT', 'Your workspace changed repeatedly. Refresh and retry this operation.', 409);
    },
  });
}
