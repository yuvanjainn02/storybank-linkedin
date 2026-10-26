import { sql } from 'drizzle-orm';
import { check, integer, primaryKey, sqliteTable, text, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const personalWorkspaces = sqliteTable('storybank_personal_workspaces', {
  tenantId: text('tenant_id').notNull(),
  ownerUserId: text('owner_user_id').notNull(),
  revision: integer('revision').notNull(),
  payload: text('payload').notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.ownerUserId] }),
  check('revision_positive', sql`${table.revision} >= 1`),
  check('payload_json', sql`json_valid(${table.payload})`),
]);
export const audioRecordings = sqliteTable('storybank_audio', {
  ownerId: text('owner_id').notNull(),
  id: text('id').notNull(),
  objectKey: text('object_key').notNull().unique(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  createdAt: text('created_at').notNull(),
  status: text('status').notNull(),
  uploadComplete: integer('upload_complete').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.id] }),
  check('audio_size_bounded', sql`${table.size} > 0 AND ${table.size} <= 10485760`),
  check('audio_status', sql`${table.status} IN ('uploading','active','deleting')`),
  check('audio_upload_complete', sql`${table.uploadComplete} IN (0,1)`),
]);

export const linkedinOAuth = sqliteTable('storybank_linkedin_oauth', {
  stateHash: text('state_hash').primaryKey(), ownerUserId: text('owner_user_id').notNull(), cookieHash: text('cookie_hash').notNull(),
  nonceHash: text('nonce_hash').notNull(), verifierCiphertext: text('verifier_ciphertext').notNull(),
  expiresAt: integer('expires_at').notNull(), consumedAt: integer('consumed_at'),
}, (t) => [uniqueIndex('linkedin_oauth_owner').on(t.ownerUserId)]);

export const linkedinConnections = sqliteTable('storybank_linkedin_connections', {
  ownerUserId: text('owner_user_id').primaryKey(), connectionId: text('connection_id').notNull().unique(),
  clientId: text('client_id').notNull(), subject: text('subject').notNull(), personUrn: text('person_urn').notNull(),
  displayName: text('display_name').notNull(), tokenCiphertext: text('token_ciphertext').notNull(),
  expiresAt: integer('expires_at').notNull(), scopes: text('scopes').notNull(), updatedAt: integer('updated_at').notNull(),
}, (t) => [uniqueIndex('linkedin_client_subject').on(t.clientId, t.subject)]);

export const linkedinJobs = sqliteTable('storybank_linkedin_jobs', {
  id: text('id').primaryKey(), ownerUserId: text('owner_user_id').notNull(), tenantId: text('tenant_id').notNull(),
  storyId: text('story_id').notNull(), sourceRevision: integer('source_revision').notNull(), sourceApprovalId: text('source_approval_id').notNull(),
  connectionId: text('connection_id').notNull(), snapshot: text('snapshot').notNull(), snapshotHash: text('snapshot_hash').notNull(), contentHash: text('content_hash').notNull(),
  idempotencyKey: text('idempotency_key').notNull(), dueAt: integer('due_at').notNull(), timeZone: text('time_zone').notNull(),
  status: text('status').notNull(), reason: text('reason'), postUrn: text('post_urn'), leaseId: text('lease_id'), leaseUntil: integer('lease_until'),
  attempts: integer('attempts').notNull().default(0), createdAt: integer('created_at').notNull(), finishedAt: integer('finished_at'),
}, (t) => [
  check('linkedin_snapshot_json', sql`json_valid(${t.snapshot})`),
  check('linkedin_job_status', sql`${t.status} IN ('queued','sending','published','unknown','rejected','cancelled')`),
  check('linkedin_attempts', sql`${t.attempts} IN (0,1)`),
  uniqueIndex('linkedin_owner_idempotency').on(t.ownerUserId, t.idempotencyKey),
  uniqueIndex('linkedin_owner_approval').on(t.ownerUserId, t.sourceApprovalId),
  index('linkedin_jobs_due').on(t.status, t.dueAt),
  uniqueIndex('linkedin_content_dedup').on(t.ownerUserId, t.contentHash).where(sql`${t.status} IN ('queued','sending','published','unknown')`),
  uniqueIndex('linkedin_one_dispatch_per_owner').on(t.ownerUserId).where(sql`${t.status} = 'sending'`),
]);

// Application-selected tester audio budgets. Migration 0003 owns the atomic
// reservation/rate triggers; these tables are not writable through client APIs.
export const audioPolicy = sqliteTable('storybank_audio_policy', {
  id: integer('id').primaryKey().notNull(),
  ownerMaxBytes: integer('owner_max_bytes').notNull(),
  ownerMaxObjects: integer('owner_max_objects').notNull(),
  projectMaxBytes: integer('project_max_bytes').notNull(),
  projectMaxObjects: integer('project_max_objects').notNull(),
  ownerWindowAttempts: integer('owner_window_attempts').notNull(),
  projectWindowAttempts: integer('project_window_attempts').notNull(),
}, (t) => [
  check('audio_policy_singleton', sql`${t.id} = 1`),
  check('audio_owner_byte_budget', sql`typeof(${t.ownerMaxBytes}) = 'integer' AND ${t.ownerMaxBytes} BETWEEN 1 AND 9007199254740991`),
  check('audio_owner_object_budget', sql`typeof(${t.ownerMaxObjects}) = 'integer' AND ${t.ownerMaxObjects} BETWEEN 1 AND 1000000`),
  check('audio_project_byte_budget', sql`typeof(${t.projectMaxBytes}) = 'integer' AND ${t.projectMaxBytes} BETWEEN 1 AND 9007199254740991`),
  check('audio_project_object_budget', sql`typeof(${t.projectMaxObjects}) = 'integer' AND ${t.projectMaxObjects} BETWEEN 1 AND 1000000`),
  check('audio_owner_attempt_budget', sql`typeof(${t.ownerWindowAttempts}) = 'integer' AND ${t.ownerWindowAttempts} BETWEEN 1 AND 1000000`),
  check('audio_project_attempt_budget', sql`typeof(${t.projectWindowAttempts}) = 'integer' AND ${t.projectWindowAttempts} BETWEEN 1 AND 1000000`),
]);
export const audioRate = sqliteTable('storybank_audio_rate', {
  scope: text('scope').notNull(),
  subject: text('subject').notNull(),
  windowStart: integer('window_start').notNull(),
  attempts: integer('attempts').notNull(),
}, (t) => [
  primaryKey({ columns: [t.scope, t.subject] }),
  check('audio_rate_scope', sql`${t.scope} IN ('owner','project')`),
  check('audio_rate_window', sql`typeof(${t.windowStart}) = 'integer' AND ${t.windowStart} >= 0 AND ${t.windowStart} % 600 = 0`),
  check('audio_rate_attempts', sql`typeof(${t.attempts}) = 'integer' AND ${t.attempts} > 0`),
  check('audio_rate_project_subject', sql`${t.scope} = 'owner' OR ${t.subject} = ''`),
]);
