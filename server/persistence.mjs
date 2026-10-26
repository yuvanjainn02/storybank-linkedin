import { plainText } from './plain-text.mjs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { StoryBankRepository } from './repository.mjs';
import { approvalSnapshot, hashSnapshot } from './approval.mjs';
import { validateWritingProfile } from './writing-profile.mjs';
import migration1 from './migrations/001-domain-state.mjs';
import migration2 from './migrations/002-sessions.mjs';

const APPLICATION_ID = 0x53424b31; // SBK1, never silently adopt a different database.
const MIGRATIONS = Object.freeze([migration1, migration2]);
export const STORYBANK_SCHEMA_VERSION = MIGRATIONS.at(-1).version;
const COLLECTIONS = Object.freeze(['stories', 'approvals', 'jobs', 'idempotency', 'approvalJobs', 'integrations', 'profiles', 'calibrations', 'profileProposals']);
const MIGRATION_TABLE = `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT`;
const checksum = (migration) => createHash('sha256').update(migration.sql).digest('hex');
const key = (...parts) => JSON.stringify(parts);
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const isoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const AUDIT_FIELDS = Object.freeze({
  'story.created': [], 'story.updated': ['revision'], 'story.approved': ['approvalId', 'hash'],
  'story.deleted': [], 'approval.revoked': ['reason'], 'job.planned': ['approvalId', 'dueAt'],
  'job.cancelled': ['reason'], 'job.blocked': ['reason'], 'integration.revoked': [],
  'writing_profile.saved': ['version'], 'writing_profile.deleted': [],
  'writing_profile.proposed': ['baseVersion'], 'writing_profile.revision_applied': ['version'],
  'calibration.created': ['profileVersion'], 'calibration.feedback_saved': ['feedbackId'],
  'calibration.deleted': [], 'privacy.deleted': ['counts'],
});

function storageError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = 'StoryBankStorageError';
  error.code = code;
  return error;
}

function corrupt() {
  throw storageError('STORAGE_CORRUPT', 'The local StoryBank database failed integrity validation. No operation was applied.');
}

function schemaRows(db) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
}

// Compare actual DDL with a clean reference. Unknown tables, triggers, altered
// constraints, missing indexes, and unrecognized schema versions fail closed.
function expectedSchema(version) {
  const reference = new DatabaseSync(':memory:');
  try {
    reference.exec(MIGRATION_TABLE);
    for (const migration of MIGRATIONS.slice(0, version)) reference.exec(migration.sql);
    return JSON.stringify(schemaRows(reference));
  } finally { reference.close(); }
}

function migrate(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const applicationId = db.prepare('PRAGMA application_id').get().application_id;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const existing = schemaRows(db);
    const fresh = applicationId === 0 && version === 0 && existing.length === 0;
    if (fresh) {
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      db.exec(MIGRATION_TABLE);
    } else {
      if (applicationId !== APPLICATION_ID || !integer(version) || version < 1 || version > STORYBANK_SCHEMA_VERSION) {
        throw storageError('STORAGE_SCHEMA_UNSUPPORTED', 'This database is not a supported StoryBank schema.');
      }
      if (JSON.stringify(existing) !== expectedSchema(version)) throw storageError('STORAGE_SCHEMA_UNSUPPORTED', 'The StoryBank database schema differs from its recorded version.');
    }
    const recorded = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
    if (recorded.length !== version || recorded.some((row, index) => row.version !== index + 1 || row.name !== MIGRATIONS[index]?.name || row.checksum !== checksum(MIGRATIONS[index]))) {
      throw storageError('STORAGE_SCHEMA_UNSUPPORTED', 'The StoryBank migration history could not be verified.');
    }
    const record = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)');
    for (const migration of MIGRATIONS.slice(version)) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, checksum(migration), new Date().toISOString());
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    if (JSON.stringify(schemaRows(db)) !== expectedSchema(STORYBANK_SCHEMA_VERSION)) throw storageError('STORAGE_SCHEMA_UNSUPPORTED', 'The migrated StoryBank schema could not be verified.');
    const checks = db.prepare('PRAGMA quick_check').all();
    if (checks.length !== 1 || checks[0].quick_check !== 'ok') corrupt();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

function parsePayload(payload) {
  try { return JSON.parse(payload); } catch { corrupt(); }
}

function validatePreferences(preferences) {
  try {
    const validated = validateWritingProfile(preferences);
    if (Object.keys(preferences).length !== Object.keys(validated).length) corrupt();
    for (const field of Object.keys(validated)) if (JSON.stringify(preferences[field]) !== JSON.stringify(validated[field])) corrupt();
  } catch { corrupt(); }
}

function validateEntry(collection, recordKey, value) {
  if (collection === 'integrations') {
    if (!nonempty(recordKey) || !object(value) || value.status !== 'revoked' || !isoDate(value.revokedAt)) corrupt();
    return;
  }
  let parts;
  try { parts = JSON.parse(recordKey); } catch { corrupt(); }
  if (!Array.isArray(parts) || parts.some((part) => !nonempty(part)) || JSON.stringify(parts) !== recordKey) corrupt();
  if (collection === 'profiles') {
    if (parts.length !== 2 || !Array.isArray(value) || value.length < 1 || value.some((version, index) => !object(version) || key(version.tenantId, version.userId) !== recordKey || version.version !== index + 1 || !isoDate(version.savedAt) || !object(version.preferences))) corrupt();
    value.forEach((version) => validatePreferences(version.preferences));
    return;
  }
  if (collection === 'approvalJobs') {
    if (parts.length !== 3 || !nonempty(value)) corrupt();
    return;
  }
  if (!object(value)) corrupt();
  if (collection === 'idempotency') {
    if (parts.length !== 3 || key(value.tenantId, value.userId, value.idempotencyKey) !== recordKey || !digest(value.hash) || !nonempty(value.jobId)) corrupt();
    return;
  }
  if (collection === 'approvals') {
    const record = value.record;
    if (parts.length !== 2 || !object(record) || key(record.tenantId, record.id) !== recordKey || !nonempty(record.approvedBy) || !nonempty(record.storyId) || !digest(record.hash) || !object(record.snapshot) || !isoDate(record.approvedAt)) corrupt();
    if (typeof record.snapshot.editorText !== 'string' || record.snapshot.editorText.length > 20_000 || plainText(record.snapshot.editorText) !== record.snapshot.text || !record.snapshot.text || record.snapshot.text.length > 3_000) corrupt();
    if (record.snapshot.tenantId !== record.tenantId || record.snapshot.storyId !== record.storyId || record.snapshot.schema !== 'storybank.approval.v2' || hashSnapshot(record.snapshot) !== record.hash) corrupt();
    return;
  }
  if (['calibrations', 'profileProposals'].includes(collection)) {
    if (parts.length !== 3 || key(value.tenantId, value.userId, value.id) !== recordKey || !isoDate(value.createdAt)) corrupt();
    if (collection === 'calibrations' && (!Array.isArray(value.variants) || !Array.isArray(value.feedback) || !Array.isArray(value.facts))) corrupt();
    if (collection === 'profileProposals' && (!['proposed', 'applied'].includes(value.status) || !object(value.preferences) || !integer(value.baseVersion))) corrupt();
    if (collection === 'profileProposals') validatePreferences(value.preferences);
    return;
  }
  if (parts.length !== 2 || key(value.tenantId, value.id) !== recordKey || !nonempty(value.createdBy) || !isoDate(value.createdAt)) corrupt();
  if (collection === 'stories' && Object.hasOwn(value, 'reviewFeedback') && (typeof value.reviewFeedback !== 'string' || !value.reviewFeedback.trim() || value.reviewFeedback.length > 2000)) corrupt();
  if (collection === 'stories' && (!Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.text !== 'string' || !Array.isArray(value.mediaIds))) corrupt();
  if (collection === 'jobs' && (!['planned', 'cancelled', 'blocked'].includes(value.status) || !nonempty(value.storyId) || !nonempty(value.approvalId) || value.mode !== 'local_plan_only' || value.publishAttempts !== 0)) corrupt();
}

function validateAudit(event) {
  if (!object(event) || !nonempty(event.id) || !nonempty(event.tenantId) || !nonempty(event.userId) || !nonempty(event.actorUserId) || !Object.hasOwn(AUDIT_FIELDS, event.type) || !nonempty(event.entityId) || !isoDate(event.at)) corrupt();
  const allowed = ['id', 'tenantId', 'userId', 'actorUserId', 'type', 'entityId', 'at', ...AUDIT_FIELDS[event.type]];
  if (Object.keys(event).length !== allowed.length || Object.keys(event).some((field) => !allowed.includes(field))) corrupt();
  for (const field of ['revision', 'version', 'baseVersion', 'profileVersion']) if (field in event && !integer(event[field])) corrupt();
  for (const field of ['approvalId', 'feedbackId']) if (field in event && !nonempty(event[field])) corrupt();
  if ('hash' in event && !digest(event.hash)) corrupt();
  if ('dueAt' in event && !isoDate(event.dueAt)) corrupt();
  if ('reason' in event && !['story_changed', 'superseded', 'story_deleted', 'approval_revoked', 'integration_revoked', 'user_cancelled', 'integration_disabled', 'approval_invalid'].includes(event.reason)) corrupt();
  if ('counts' in event) {
    const counts = ['stories', 'approvals', 'jobs', 'idempotencyReservations', 'approvalJobReservations', 'writingProfileVersions', 'calibrations', 'feedbackEntries', 'writingRevisionProposals', 'mediaReferences', 'auditEvents'];
    if (!object(event.counts) || Object.keys(event.counts).length !== counts.length || counts.some((field) => !integer(event.counts[field]))) corrupt();
  }
}

function validateRelations(state) {
  for (const story of state.stories.values()) {
    if (!story.activeApprovalId) continue;
    const approval = state.approvals.get(key(story.tenantId, story.activeApprovalId));
    if (!approval || approval.revokedAt || approval.record.storyId !== story.id || approval.record.approvedBy !== story.createdBy || approval.record.hash !== hashSnapshot(approvalSnapshot(story))) corrupt();
  }
  for (const [recordKey, reservation] of state.idempotency) {
    const [tenantId, userId] = JSON.parse(recordKey);
    const job = state.jobs.get(key(tenantId, reservation.jobId));
    if (!job || job.createdBy !== userId || reservation.hash !== hashSnapshot({ storyId: job.storyId, approvalId: job.approvalId, dueAt: job.dueAt })) corrupt();
  }
  for (const [recordKey, jobId] of state.approvalJobs) {
    const [tenantId, userId, approvalId] = JSON.parse(recordKey);
    const job = state.jobs.get(key(tenantId, jobId));
    if (!job || job.createdBy !== userId || job.approvalId !== approvalId) corrupt();
  }
  for (const job of state.jobs.values()) {
    const story = state.stories.get(key(job.tenantId, job.storyId));
    const approval = state.approvals.get(key(job.tenantId, job.approvalId));
    if ((story && story.createdBy !== job.createdBy) || (approval && approval.record.approvedBy !== job.createdBy)) corrupt();
  }
}

function validateSession(record) {
  const fields = ['tokenDigest', 'csrfDigest', 'subject', 'createdAt', 'expiresAt', 'authTime'];
  if (!object(record) || Object.keys(record).length !== fields.length || fields.some((field) => !(field in record)) || !digest(record.tokenDigest) || !digest(record.csrfDigest) || !nonempty(record.subject) || !integer(record.createdAt) || !integer(record.expiresAt) || !integer(record.authTime) || record.expiresAt <= record.createdAt || record.authTime > record.createdAt) {
    throw new TypeError('A session requires digests, a subject, and valid fixed-expiry timestamps only.');
  }
}

function sessionFromRow(row) {
  if (!row) return null;
  const record = { tokenDigest: row.token_digest, csrfDigest: row.csrf_digest, subject: row.subject, createdAt: row.created_at, expiresAt: row.expires_at, authTime: row.auth_time };
  try { validateSession(record); } catch { corrupt(); }
  return record;
}

/** Private infrastructure implementation; never expose its state or DB handle to requests. */
class SQLiteStateStore {
  #db;
  #activeState = null;
  #closed = false;

  constructor(filename) {
    if (typeof filename !== 'string' || !filename.trim() || filename === ':memory:' || filename.includes('\0')) throw new TypeError('Provide a local SQLite filename for durable storage.');
    try {
      this.#db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
      this.#db.exec('PRAGMA busy_timeout = 5000');
      migrate(this.#db);
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;');
      // Validate persisted aggregate data at startup, not only on first use.
      this.transact(() => null, false);
      for (const row of this.#db.prepare('SELECT * FROM sessions').all()) sessionFromRow(row);
    } catch (error) {
      try { this.#db?.close(); } catch { /* Preserve the original failure. */ }
      if (error.code?.startsWith('STORAGE_') || error instanceof TypeError) throw error;
      throw storageError('STORAGE_OPEN_FAILED', 'The local StoryBank database could not be opened safely.', error);
    }
  }

  #assertOpen() {
    if (this.#closed) throw storageError('STORAGE_CLOSED', 'This StoryBank storage handle has been closed.');
  }

  #load() {
    const state = Object.fromEntries(COLLECTIONS.map((collection) => [collection, new Map()]));
    state.audit = [];
    for (const row of this.#db.prepare('SELECT collection, record_key, payload FROM repository_records ORDER BY collection, record_key').all()) {
      if (!COLLECTIONS.includes(row.collection)) corrupt();
      const value = parsePayload(row.payload);
      validateEntry(row.collection, row.record_key, value);
      state[row.collection].set(row.record_key, value);
    }
    for (const row of this.#db.prepare('SELECT payload FROM audit_events ORDER BY sequence').all()) {
      const event = parsePayload(row.payload);
      validateAudit(event);
      state.audit.push(event);
    }
    validateRelations(state);
    return state;
  }

  #save(state) {
    const entries = [];
    for (const collection of COLLECTIONS) {
      for (const [recordKey, value] of state[collection]) {
        validateEntry(collection, recordKey, value);
        entries.push([collection, recordKey, JSON.stringify(value)]);
      }
    }
    state.audit.forEach(validateAudit);
    validateRelations(state);
    const audit = state.audit.map((event, index) => [index + 1, JSON.stringify(event)]);
    this.#db.exec('DELETE FROM repository_records; DELETE FROM audit_events;');
    const insert = this.#db.prepare('INSERT INTO repository_records (collection, record_key, payload) VALUES (?, ?, ?)');
    for (const entry of entries) insert.run(...entry);
    const append = this.#db.prepare('INSERT INTO audit_events (sequence, payload) VALUES (?, ?)');
    for (const entry of audit) append.run(...entry);
  }

  transact(operation, persist = true) {
    this.#assertOpen();
    if (this.#activeState) return operation(this.#activeState);
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#activeState = this.#load();
      const result = operation(this.#activeState);
      if (result && typeof result.then === 'function') throw new TypeError('Durable domain operations must be synchronous.');
      if (persist) this.#save(this.#activeState);
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    } finally { this.#activeState = null; }
  }

  sessionStore() {
    // Closure-only facade: no handle, raw token, SQL, or aggregate access escapes.
    return Object.freeze({
      getByDigest: (tokenDigest) => {
        this.#assertOpen();
        if (!digest(tokenDigest)) return null;
        return sessionFromRow(this.#db.prepare('SELECT * FROM sessions WHERE token_digest = ?').get(tokenDigest));
      },
      put: (record) => {
        this.#assertOpen();
        validateSession(record);
        this.#db.prepare('INSERT INTO sessions (token_digest, csrf_digest, subject, created_at, expires_at, auth_time) VALUES (?, ?, ?, ?, ?, ?)').run(record.tokenDigest, record.csrfDigest, record.subject, record.createdAt, record.expiresAt, record.authTime);
      },
      deleteByDigest: (tokenDigest) => {
        this.#assertOpen();
        if (!digest(tokenDigest)) return;
        this.#db.prepare('DELETE FROM sessions WHERE token_digest = ?').run(tokenDigest);
      },
      deleteForUser: (subject) => {
        this.#assertOpen();
        if (!nonempty(subject)) throw new TypeError('A session subject is required.');
        this.#db.prepare('DELETE FROM sessions WHERE subject = ?').run(subject);
      },
      deleteExpired: (now) => {
        this.#assertOpen();
        if (!integer(now)) throw new TypeError('A valid Unix millisecond timestamp is required.');
        return Number(this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes);
      },
    });
  }

  close() {
    if (this.#closed) return;
    if (this.#activeState) throw storageError('STORAGE_BUSY', 'Cannot close storage during an active domain operation.');
    this.#db.close();
    this.#closed = true;
  }
}

/**
 * Server-only composition. The returned repository has the same synchronous
 * authorized API as StoryBankRepository. Each top-level call reloads current
 * data under BEGIN IMMEDIATE; failed calls roll back domain changes and audit.
 * This is local persistence, not a hosted multi-user production deployment.
 */
export function createDurableStoryBankRepository({ filename, authority, clock, id } = {}) {
  const storage = openStoryBankStorage({ filename });
  try {
    const repository = storage.createRepository({ authority, clock, id });
    return Object.freeze({ repository, sessionStore: storage.sessionStore, close: storage.close });
  } catch (error) {
    storage.close();
    throw error;
  }
}

/** Open storage before constructing a session boundary and its authority. */
export function openStoryBankStorage({ filename } = {}) {
  const store = new SQLiteStateStore(filename);
  return Object.freeze({
    sessionStore: store.sessionStore(),
    createRepository: ({ authority, clock, id } = {}) => new StoryBankRepository({ authority, clock, id, store }),
    close: () => store.close(),
  });
}
