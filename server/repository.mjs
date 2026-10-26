import { randomUUID } from 'node:crypto';
import { approvalSnapshot, hashSnapshot, hashesEqual } from './approval.mjs';
import { fail } from './errors.mjs';
import { publishingAdapter } from './publishing.mjs';
import { plainText } from './plain-text.mjs';
import { validateWritingProfile, writingSkillDocument } from './writing-profile.mjs';
import { validateCalibration, draftFactPreviews, validateFeedback, proposedGuidance } from './calibration.mjs';

const ALLOWED_FIELDS = new Set(['title', 'text', 'source', 'platform', 'destinationId', 'mediaIds', 'reviewFeedback']);
const copy = (value) => structuredClone(value);
const key = (...parts) => JSON.stringify(parts);
const PRIVACY_LIMITATIONS = Object.freeze({
  audioObjects: 'Only story media identifiers exist here. The repository alone has no audio object model; its deletion does not erase recordings. The hosted deletion route separately attempts private R2 audio cleanup and reports partial results.',
  backups: 'This operation removes live repository records, not backup copies, SQLite free pages or WAL remnants. It is not cryptographic erasure. Backup retention and deletion-tombstone replay are not implemented.',
  externalCopies: 'Previously downloaded exports and third-party copies are outside repository deletion control.',
  accountAndSessions: 'This is not account or workspace deletion. Session revocation, membership removal and provider-grant revocation require separate infrastructure.',
});

function validateOwnDataSelection(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).length) {
    fail('INVALID_PRIVACY_SELECTION', 'Export or delete only your own data in the authenticated workspace; identity selectors are not accepted.');
  }
}

function validateFields(input, partial = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_INPUT', 'Story fields must be an object.');
  if (Object.keys(input).some((field) => !ALLOWED_FIELDS.has(field))) fail('INVALID_FIELD', 'An unsupported or server-owned field was supplied.');
  const normalized = partial ? { ...input } : { title: '', text: '', source: '', platform: 'linkedin', destinationId: null, mediaIds: [], ...input };
  for (const [field, value] of Object.entries(normalized)) {
    if (field === 'reviewFeedback') {
      if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail('INVALID_REVIEW_FEEDBACK', 'Explain the requested changes in 1–2,000 characters.');
    } else if (['title', 'text', 'source'].includes(field)) {
      const max = field === 'title' ? 250 : field === 'text' ? 20_000 : 5_000;
      if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT', `${field} must be a string of at most ${max} characters.`);
    } else if (field === 'platform' && value !== 'linkedin') {
      fail('UNSUPPORTED_PLATFORM', 'Only LinkedIn planning is represented in this scaffold.');
    } else if (field === 'destinationId' && value !== null && (typeof value !== 'string' || !value.trim() || value.length > 200)) {
      fail('INVALID_INPUT', 'The destination identifier must be null or a nonempty string.');
    } else if (field === 'mediaIds') {
      if (!Array.isArray(value) || value.length > 20 || value.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) || new Set(value).size !== value.length) {
        fail('INVALID_INPUT', 'Media identifiers must be a short list of unique nonempty strings.');
      }
      normalized.mediaIds = [...value];
    }
  }
  return normalized;
}

function parseDueAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail('INVALID_DATE', 'Use an ISO date-time with an explicit timezone.');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) fail('INVALID_DATE', 'The planned time is not a valid date.');
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    fail('INVALID_DATE', 'The planned time must be a real calendar date and time.');
  }
  return new Date(timestamp).toISOString();
}

/**
 * Authorized domain service. Defaults to ephemeral in-memory state. The
 * server-only durable composition injects a trusted transaction store; never
 * accept that constructor option or an authority from request/client input.
 * No HTTP, provider tokens, or outbound publishing exist in this repository.
 */
export class StoryBankRepository {
  #authority;
  #clock;
  #id;
  #durable = false;
  #stories = new Map();
  #approvals = new Map();
  #jobs = new Map();
  #idempotency = new Map();
  #approvalJobs = new Map();
  #integrations = new Map();
  #profiles = new Map();
  #calibrations = new Map();
  #profileProposals = new Map();
  #audit = [];

  constructor({ authority, clock = () => new Date(), id = randomUUID, store } = {}) {
    if (!authority || typeof authority.require !== 'function') throw new TypeError('A trusted context authority is required.');
    this.#authority = authority;
    this.#clock = clock;
    this.#id = id;
    if (store !== undefined) {
      if (!store || typeof store.transact !== 'function') throw new TypeError('A trusted synchronous transaction store is required.');
      this.#durable = true;
      // Infrastructure-only injection: no state import/export method or DB
      // handle is exposed on the domain API. Nested public domain calls share
      // the store's active transaction rather than committing partial changes.
      for (const name of Object.getOwnPropertyNames(StoryBankRepository.prototype)) {
        if (name === 'constructor') continue;
        const operation = StoryBankRepository.prototype[name];
        Object.defineProperty(this, name, {
          value: (...args) => store.transact((state) => {
            this.#stories = state.stories;
            this.#approvals = state.approvals;
            this.#jobs = state.jobs;
            this.#idempotency = state.idempotency;
            this.#approvalJobs = state.approvalJobs;
            this.#integrations = state.integrations;
            this.#profiles = state.profiles;
            this.#calibrations = state.calibrations;
            this.#profileProposals = state.profileProposals;
            this.#audit = state.audit;
            const result = operation.apply(this, args);
            // Owner deletion replaces the audit array rather than mutating it.
            state.audit = this.#audit;
            return result;
          }),
        });
      }
    }
  }

  #now() {
    const date = this.#clock();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Clock must return a valid Date.');
    return date.toISOString();
  }

  #identity(context, permission = 'read') { return this.#authority.require(context, permission); }

  #get(map, identity, id) {
    const value = map.get(key(identity.tenantId, id));
    const owner = value?.createdBy ?? value?.record?.approvedBy;
    if (!value || owner !== identity.userId) fail('NOT_FOUND', 'The personal item was not found.', 404);
    return value;
  }

  #record(identity, type, entityId, extra = {}, ownerUserId = identity.userId) {
    // The subject controls audit visibility. A workspace owner may revoke an
    // integration globally, but must not see another writer's content IDs.
    this.#audit.push(Object.freeze({ id: this.#id(), tenantId: identity.tenantId, userId: ownerUserId, actorUserId: identity.userId, type, entityId, at: this.#now(), ...extra }));
  }

  #cancelStoryJobs(identity, storyId, reason) {
    for (const job of this.#jobs.values()) {
      if (job.tenantId === identity.tenantId && job.storyId === storyId && job.status === 'planned') {
        job.status = 'cancelled';
        job.reason = reason;
        job.finishedAt = this.#now();
        this.#record(identity, 'job.cancelled', job.id, { reason }, job.createdBy);
      }
    }
  }

  #revokeApproval(identity, story, reason) {
    if (story.activeApprovalId) {
      const approval = this.#get(this.#approvals, { ...identity, userId: story.createdBy }, story.activeApprovalId);
      approval.revokedAt = this.#now();
      approval.revokedBy = identity.userId;
      approval.revocationReason = reason;
      this.#record(identity, 'approval.revoked', approval.record.id, { reason }, story.createdBy);
      story.activeApprovalId = null;
    }
    this.#cancelStoryJobs(identity, story.id, reason);
  }

  createStory(context, input) {
    const identity = this.#identity(context, 'write');
    const fields = validateFields(input);
    const now = this.#now();
    const story = { ...fields, id: this.#id(), tenantId: identity.tenantId, createdBy: identity.userId, revision: 1, activeApprovalId: null, createdAt: now, updatedAt: now };
    this.#stories.set(key(identity.tenantId, story.id), story);
    this.#record(identity, 'story.created', story.id);
    return copy(story);
  }

  getStory(context, storyId) {
    const identity = this.#identity(context);
    return copy(this.#get(this.#stories, identity, storyId));
  }

  listStories(context) {
    const identity = this.#identity(context);
    return [...this.#stories.values()].filter((story) => story.tenantId === identity.tenantId && story.createdBy === identity.userId).map(copy);
  }

  updateStory(context, storyId, patch, { expectedRevision } = {}) {
    const identity = this.#identity(context, 'write');
    const story = this.#get(this.#stories, identity, storyId);
    if (expectedRevision !== story.revision) fail('REVISION_CONFLICT', 'Refresh this draft before editing.', 409);
    const fields = validateFields(patch, true);
    if (!Object.hasOwn(fields, 'reviewFeedback') && !Object.keys(fields).some((field) => JSON.stringify(fields[field]) !== JSON.stringify(story[field]))) return copy(story);
    this.#revokeApproval(identity, story, 'story_changed');
    Object.assign(story, fields, { revision: story.revision + 1, updatedAt: this.#now() });
    this.#record(identity, 'story.updated', story.id, { revision: story.revision });
    return copy(story);
  }

  approveStory(context, storyId, { expectedRevision } = {}) {
    const identity = this.#identity(context, 'write');
    const story = this.#get(this.#stories, identity, storyId);
    if (expectedRevision !== story.revision) fail('REVISION_CONFLICT', 'Refresh this draft before approving.', 409);
    const output = plainText(story.text);
    if (!output) fail('EMPTY_CONTENT', 'A blank draft cannot be approved.');
    if (output.length > 3_000) fail('CONTENT_TOO_LONG', 'Keep the plain-text draft at 3,000 characters or fewer before approval.');
    if (/\[(?:add|insert|your|todo|placeholder)/i.test(output)) fail('UNRESOLVED_PLACEHOLDER', 'Replace draft placeholders before approval.');
    this.#revokeApproval(identity, story, 'superseded');
    const snapshot = approvalSnapshot(story);
    const record = Object.freeze({ id: this.#id(), tenantId: identity.tenantId, storyId, approvedBy: identity.userId, approvedAt: this.#now(), hash: hashSnapshot(snapshot), snapshot });
    const approval = { record, revokedAt: null, revokedBy: null, revocationReason: null };
    this.#approvals.set(key(identity.tenantId, record.id), approval);
    story.activeApprovalId = record.id;
    this.#record(identity, 'story.approved', storyId, { approvalId: record.id, hash: record.hash });
    return copy(approval);
  }

  getApproval(context, approvalId) {
    const identity = this.#identity(context);
    return copy(this.#get(this.#approvals, identity, approvalId));
  }

  revokeApproval(context, storyId) {
    const identity = this.#identity(context, 'write');
    const story = this.#get(this.#stories, identity, storyId);
    this.#revokeApproval(identity, story, 'approval_revoked');
    return copy(story);
  }

  #assertApproval(identity, story, approvalId) {
    const approval = this.#get(this.#approvals, identity, approvalId);
    if (approval.revokedAt || story.activeApprovalId !== approvalId || approval.record.storyId !== story.id ||
        !hashesEqual(approval.record.hash, hashSnapshot(approvalSnapshot(story)))) {
      fail('APPROVAL_INVALID', 'Approval no longer matches this exact draft and destination.', 409);
    }
    return approval;
  }

  schedulePlan(context, { storyId, approvalId, dueAt, idempotencyKey } = {}) {
    const identity = this.#identity(context, 'write');
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) fail('INVALID_IDEMPOTENCY_KEY', 'Provide a unique request key of 8 to 200 characters.');
    const normalizedDueAt = parseDueAt(dueAt);
    const requestHash = hashSnapshot({ storyId, approvalId, dueAt: normalizedDueAt });
    const requestKey = key(identity.tenantId, identity.userId, idempotencyKey);
    const existing = this.#idempotency.get(requestKey);
    if (existing) {
      if (existing.hash !== requestHash) fail('IDEMPOTENCY_CONFLICT', 'This request key was already used for a different plan.', 409);
      return copy(this.#get(this.#jobs, identity, existing.jobId));
    }
    const story = this.#get(this.#stories, identity, storyId);
    const approval = this.#assertApproval(identity, story, approvalId);
    if (normalizedDueAt <= this.#now()) fail('INVALID_DATE', 'Choose a future planning time.');
    if (this.#approvalJobs.has(key(identity.tenantId, identity.userId, approvalId))) fail('DUPLICATE_JOB', 'This approval already has a plan. Approve again to create a new plan.', 409);
    const publishContent = (snapshot) => JSON.stringify([snapshot.text, snapshot.platform, snapshot.destinationId, snapshot.mediaIds]);
    const requestedContent = publishContent(approval.record.snapshot);
    for (const priorJob of this.#jobs.values()) {
      if (priorJob.tenantId !== identity.tenantId || priorJob.createdBy !== identity.userId || priorJob.status !== 'planned') continue;
      const priorApproval = this.#approvals.get(key(identity.tenantId, priorJob.approvalId));
      if (priorApproval && publishContent(priorApproval.record.snapshot) === requestedContent) fail('DUPLICATE_CONTENT', 'This exact plain-text content already has an active plan.', 409);
    }
    const integration = this.#integrations.get(identity.tenantId);
    if (integration?.status === 'revoked') fail('INTEGRATION_REVOKED', 'The integration was revoked; reconnecting is not implemented.', 409);
    const job = { id: this.#id(), tenantId: identity.tenantId, storyId, approvalId, approvalHash: approval.record.hash, createdBy: identity.userId, createdAt: this.#now(), dueAt: normalizedDueAt, status: 'planned', reason: null, finishedAt: null, mode: 'local_plan_only', publishAttempts: 0 };
    this.#jobs.set(key(identity.tenantId, job.id), job);
    this.#idempotency.set(requestKey, { tenantId: identity.tenantId, userId: identity.userId, idempotencyKey, hash: requestHash, jobId: job.id });
    this.#approvalJobs.set(key(identity.tenantId, identity.userId, approvalId), job.id);
    this.#record(identity, 'job.planned', job.id, { approvalId, dueAt: normalizedDueAt });
    return copy(job);
  }

  listJobs(context) {
    const identity = this.#identity(context);
    return [...this.#jobs.values()].filter((job) => job.tenantId === identity.tenantId && job.createdBy === identity.userId).map(copy);
  }

  getJob(context, jobId) {
    const identity = this.#identity(context);
    return copy(this.#get(this.#jobs, identity, jobId));
  }

  cancelJob(context, jobId) {
    const identity = this.#identity(context, 'write');
    const job = this.#get(this.#jobs, identity, jobId);
    if (job.status === 'planned') {
      job.status = 'cancelled';
      job.reason = 'user_cancelled';
      job.finishedAt = this.#now();
      this.#record(identity, 'job.cancelled', job.id, { reason: job.reason });
    }
    return copy(job);
  }

  integrationStatus(context) {
    const identity = this.#identity(context);
    return { status: this.#integrations.get(identity.tenantId)?.status ?? 'disabled', livePublishing: false, oauthConnected: false };
  }

  revokeIntegration(context) {
    const identity = this.#identity(context, 'owner');
    this.#integrations.set(identity.tenantId, { status: 'revoked', revokedAt: this.#now() });
    for (const story of this.#stories.values()) {
      if (story.tenantId === identity.tenantId) this.#revokeApproval(identity, story, 'integration_revoked');
    }
    this.#record(identity, 'integration.revoked', identity.tenantId);
    return this.integrationStatus(context);
  }

  runDuePlans(context) {
    const identity = this.#identity(context, 'write');
    const now = this.#now();
    const processed = [];
    for (const job of this.#jobs.values()) {
      if (job.tenantId !== identity.tenantId || job.createdBy !== identity.userId || job.status !== 'planned' || job.dueAt > now) continue;
      let reason = 'integration_disabled';
      const story = this.#stories.get(key(identity.tenantId, job.storyId));
      if (!story) reason = 'story_deleted';
      else {
        try {
          const approval = this.#assertApproval(identity, story, job.approvalId);
          if (!hashesEqual(approval.record.hash, job.approvalHash)) reason = 'approval_invalid';
        } catch (error) {
          if (error.code !== 'APPROVAL_INVALID' && error.code !== 'NOT_FOUND') throw error;
          reason = 'approval_invalid';
        }
      }
      if (this.#integrations.get(identity.tenantId)?.status === 'revoked') reason = 'integration_revoked';
      // Deliberately unconditional: changing an env flag or adapter property
      // cannot cause a local plan to perform a real publishing side effect.
      job.status = 'blocked';
      job.reason = reason;
      job.finishedAt = now;
      this.#record(identity, 'job.blocked', job.id, { reason });
      processed.push(copy(job));
    }
    return processed;
  }

  publishNow(context, storyId, approvalId) {
    const identity = this.#identity(context, 'write');
    const story = this.#get(this.#stories, identity, storyId);
    this.#assertApproval(identity, story, approvalId);
    // A second independent fail-closed boundary for callers that skip plans.
    return publishingAdapter.publish();
  }

  deleteStory(context, storyId) {
    const identity = this.#identity(context, 'write');
    const story = this.#get(this.#stories, identity, storyId);
    this.#revokeApproval(identity, story, 'story_deleted');
    this.#stories.delete(key(identity.tenantId, storyId));
    // Approval snapshots contain original content and must be removed too.
    for (const [approvalKey, approval] of this.#approvals) {
      if (approval.record.tenantId === identity.tenantId && approval.record.storyId === storyId) this.#approvals.delete(approvalKey);
    }
    this.#record(identity, 'story.deleted', storyId);
    return { deleted: true, storyId, scope: this.#durable ? 'live_local_database' : 'in_memory_only' };
  }

  listAudit(context) {
    const identity = this.#identity(context);
    return this.#audit.filter((event) => event.tenantId === identity.tenantId && event.userId === identity.userId).map(copy);
  }

  exportOwnData(context, options = {}) {
    const identity = this.#identity(context);
    validateOwnDataSelection(options);
    const own = (record) => record.tenantId === identity.tenantId && record.userId === identity.userId;
    const authored = (record) => record.tenantId === identity.tenantId && record.createdBy === identity.userId;
    const stories = [...this.#stories.values()].filter(authored);
    return copy({
      schemaVersion: 1,
      scope: 'authenticated_user_in_workspace',
      tenantId: identity.tenantId,
      userId: identity.userId,
      exportedAt: this.#now(),
      data: {
        stories,
        approvals: [...this.#approvals.values()].filter((approval) => approval.record.tenantId === identity.tenantId && approval.record.approvedBy === identity.userId),
        jobs: [...this.#jobs.values()].filter(authored),
        idempotencyReservations: [...this.#idempotency.values()].filter(own),
        writingProfileVersions: this.#profiles.get(key(identity.tenantId, identity.userId)) ?? [],
        calibrations: [...this.#calibrations.values()].filter(own),
        writingRevisionProposals: [...this.#profileProposals.values()].filter(own),
        mediaReferences: stories.flatMap((story) => story.mediaIds.map((mediaId) => ({ storyId: story.id, mediaId }))),
        auditEvents: this.#audit.filter(own),
      },
      limitations: PRIVACY_LIMITATIONS,
    });
  }

  deleteOwnData(context, options = {}) {
    const identity = this.#identity(context, 'write');
    validateOwnDataSelection(options);
    const own = (record) => record.tenantId === identity.tenantId && record.userId === identity.userId;
    const authored = (record) => record.tenantId === identity.tenantId && record.createdBy === identity.userId;
    const counts = {
      stories: 0, approvals: 0, jobs: 0, idempotencyReservations: 0, approvalJobReservations: 0,
      writingProfileVersions: 0, calibrations: 0, feedbackEntries: 0, writingRevisionProposals: 0,
      mediaReferences: 0, auditEvents: 0,
    };
    const removeMatching = (map, predicate, countField) => {
      for (const [recordKey, record] of map) {
        if (predicate(record)) {
          map.delete(recordKey);
          counts[countField]++;
        }
      }
    };
    for (const story of this.#stories.values()) if (authored(story)) counts.mediaReferences += story.mediaIds.length;
    for (const calibration of this.#calibrations.values()) if (own(calibration)) counts.feedbackEntries += calibration.feedback.length;
    removeMatching(this.#stories, authored, 'stories');
    removeMatching(this.#approvals, (approval) => approval.record.tenantId === identity.tenantId && approval.record.approvedBy === identity.userId, 'approvals');
    removeMatching(this.#jobs, authored, 'jobs');
    removeMatching(this.#idempotency, own, 'idempotencyReservations');
    for (const [reservationKey] of this.#approvalJobs) {
      const [tenantId, userId] = JSON.parse(reservationKey);
      if (tenantId === identity.tenantId && userId === identity.userId) {
        this.#approvalJobs.delete(reservationKey);
        counts.approvalJobReservations++;
      }
    }
    const profileKey = key(identity.tenantId, identity.userId);
    counts.writingProfileVersions = (this.#profiles.get(profileKey) ?? []).length;
    this.#profiles.delete(profileKey);
    removeMatching(this.#calibrations, own, 'calibrations');
    removeMatching(this.#profileProposals, own, 'writingRevisionProposals');
    counts.auditEvents = this.#audit.filter(own).length;
    this.#audit = this.#audit.filter((event) => !own(event));
    // Retain only a content-free deletion receipt, not the prior activity log.
    this.#record(identity, 'privacy.deleted', identity.userId, { counts: copy(counts) });
    return {
      deleted: true,
      scope: 'authenticated_user_in_workspace',
      storageScope: 'live_repository_records',
      counts,
      retainedAuditEvents: 1,
      limitations: copy(PRIVACY_LIMITATIONS),
    };
  }

  saveWritingProfile(context, input, { expectedVersion } = {}) {
    const identity = this.#identity(context, 'write');
    const profileKey = key(identity.tenantId, identity.userId);
    const versions = this.#profiles.get(profileKey) ?? [];
    if (expectedVersion !== versions.length) fail('VERSION_CONFLICT', 'Refresh your writing profile before saving.', 409);
    const preferences = validateWritingProfile(input);
    const version = Object.freeze({ tenantId: identity.tenantId, userId: identity.userId, version: versions.length + 1, savedAt: this.#now(), preferences });
    this.#profiles.set(profileKey, [...versions, version]);
    this.#record(identity, 'writing_profile.saved', identity.userId, { version: version.version });
    return copy(version);
  }

  getWritingProfile(context, options = {}) {
    const identity = this.#identity(context);
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((field) => field !== 'version')) {
      fail('INVALID_PROFILE_SELECTION', 'Select a version only; the profile owner comes from authentication.');
    }
    const { version } = options;
    const versions = this.#profiles.get(key(identity.tenantId, identity.userId)) ?? [];
    const requested = version ?? versions.length;
    if (!Number.isSafeInteger(requested) || requested < 1 || !versions[requested - 1]) fail('NOT_FOUND', 'This personal writing profile version was not found.', 404);
    return copy(versions[requested - 1]);
  }

  listWritingProfileVersions(context) {
    const identity = this.#identity(context);
    return (this.#profiles.get(key(identity.tenantId, identity.userId)) ?? []).map((version) => ({ version: version.version, savedAt: version.savedAt }));
  }

  exportWritingSkill(context, options = {}) {
    const version = this.getWritingProfile(context, options);
    return { filename: `storybank-personal-writing-v${version.version}.md`, mimeType: 'text/markdown; charset=utf-8', content: writingSkillDocument(version) };
  }

  deleteWritingProfile(context) {
    const identity = this.#identity(context, 'write');
    this.#profiles.delete(key(identity.tenantId, identity.userId));
    // Pending and applied proposal copies also contain personal preferences.
    for (const [proposalKey, proposal] of this.#profileProposals) {
      if (proposal.tenantId === identity.tenantId && proposal.userId === identity.userId) this.#profileProposals.delete(proposalKey);
    }
    this.#record(identity, 'writing_profile.deleted', identity.userId);
    return { deleted: true, scope: this.#durable ? 'own_profile_live_local_database' : 'own_profile_in_memory_only' };
  }

  resetWritingProfile(context, { expectedVersion } = {}) {
    // Reset is a new blank version, not deletion of the user's version history.
    return this.saveWritingProfile(context, {}, { expectedVersion });
  }

  #ownCalibration(identity, calibrationId) {
    const calibration = this.#calibrations.get(key(identity.tenantId, identity.userId, calibrationId));
    if (!calibration) fail('NOT_FOUND', 'The personal calibration was not found.', 404);
    return calibration;
  }

  createCalibration(context, input) {
    const identity = this.#identity(context, 'write');
    const validated = validateCalibration(input);
    const versions = this.#profiles.get(key(identity.tenantId, identity.userId)) ?? [];
    const current = versions.at(-1);
    const variants = draftFactPreviews(validated, current?.preferences).map((variant) => ({ id: this.#id(), ...variant }));
    const calibration = { id: this.#id(), tenantId: identity.tenantId, userId: identity.userId, createdAt: this.#now(), topic: validated.topic, facts: validated.facts, profileVersion: current?.version ?? 0, variants, feedback: [], mode: 'non_ai_template_preview' };
    this.#calibrations.set(key(identity.tenantId, identity.userId, calibration.id), calibration);
    this.#record(identity, 'calibration.created', calibration.id, { profileVersion: calibration.profileVersion });
    return copy(calibration);
  }

  getCalibration(context, calibrationId) {
    const identity = this.#identity(context);
    return copy(this.#ownCalibration(identity, calibrationId));
  }

  addCalibrationFeedback(context, calibrationId, input) {
    const identity = this.#identity(context, 'write');
    const calibration = this.#ownCalibration(identity, calibrationId);
    const fields = validateFeedback(input);
    if (!calibration.variants.some((variant) => variant.id === fields.variantId)) fail('NOT_FOUND', 'The draft preview was not found in this calibration.', 404);
    if (calibration.feedback.length >= 50) fail('FEEDBACK_LIMIT', 'Start a new calibration after 50 feedback entries.');
    const feedback = { ...fields, id: this.#id(), savedAt: this.#now(), userId: identity.userId };
    calibration.feedback.push(feedback);
    this.#record(identity, 'calibration.feedback_saved', calibrationId, { feedbackId: feedback.id });
    return copy(feedback);
  }

  proposeWritingRevision(context, calibrationId) {
    const identity = this.#identity(context, 'write');
    const calibration = this.#ownCalibration(identity, calibrationId);
    if (!calibration.feedback.length) fail('FEEDBACK_REQUIRED', 'Add feedback before proposing a personal writing revision.');
    const versions = this.#profiles.get(key(identity.tenantId, identity.userId)) ?? [];
    const current = versions.at(-1);
    const preferences = current?.preferences ?? validateWritingProfile({});
    const proposed = proposedGuidance(preferences.feedbackGuidance, calibration.feedback);
    const proposal = {
      id: this.#id(), tenantId: identity.tenantId, userId: identity.userId, calibrationId,
      createdAt: this.#now(), baseVersion: current?.version ?? 0,
      feedbackHash: hashSnapshot(calibration.feedback), preferences: validateWritingProfile({ ...preferences, feedbackGuidance: proposed.guidance }),
      truncated: proposed.truncated, status: 'proposed', appliedVersion: null,
      notice: 'Review this proposed guidance before applying. It records feedback, not a trained model. Edited examples are not automatically converted into rules.',
    };
    this.#profileProposals.set(key(identity.tenantId, identity.userId, proposal.id), proposal);
    this.#record(identity, 'writing_profile.proposed', proposal.id, { baseVersion: proposal.baseVersion });
    return copy(proposal);
  }

  getWritingRevision(context, proposalId) {
    const identity = this.#identity(context);
    const proposal = this.#profileProposals.get(key(identity.tenantId, identity.userId, proposalId));
    if (!proposal) fail('NOT_FOUND', 'The personal writing revision was not found.', 404);
    return copy(proposal);
  }

  applyWritingRevision(context, proposalId, { expectedVersion } = {}) {
    const identity = this.#identity(context, 'write');
    const proposal = this.#profileProposals.get(key(identity.tenantId, identity.userId, proposalId));
    if (!proposal) fail('NOT_FOUND', 'The personal writing revision was not found.', 404);
    if (proposal.status === 'applied') return this.getWritingProfile(context, { version: proposal.appliedVersion });
    const currentVersions = this.#profiles.get(key(identity.tenantId, identity.userId)) ?? [];
    if (expectedVersion !== proposal.baseVersion || currentVersions.length !== proposal.baseVersion) fail('VERSION_CONFLICT', 'Your profile changed. Propose and review a fresh revision.', 409);
    const calibration = this.#ownCalibration(identity, proposal.calibrationId);
    if (hashSnapshot(calibration.feedback) !== proposal.feedbackHash) fail('FEEDBACK_CHANGED', 'Feedback changed after this proposal. Propose and review a fresh revision.', 409);
    const saved = this.saveWritingProfile(context, proposal.preferences, { expectedVersion });
    proposal.status = 'applied';
    proposal.appliedVersion = saved.version;
    this.#record(identity, 'writing_profile.revision_applied', proposalId, { version: saved.version });
    return saved;
  }

  deleteCalibration(context, calibrationId) {
    const identity = this.#identity(context, 'write');
    this.#ownCalibration(identity, calibrationId);
    this.#calibrations.delete(key(identity.tenantId, identity.userId, calibrationId));
    for (const [proposalKey, proposal] of this.#profileProposals) {
      if (proposal.tenantId === identity.tenantId && proposal.userId === identity.userId && proposal.calibrationId === calibrationId) this.#profileProposals.delete(proposalKey);
    }
    this.#record(identity, 'calibration.deleted', calibrationId);
    return { deleted: true, scope: this.#durable ? 'own_calibration_live_local_database' : 'own_calibration_in_memory_only', note: 'Already-applied profile versions remain until the writing profile is deleted.' };
  }
}
