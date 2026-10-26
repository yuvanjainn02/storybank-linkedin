import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCreatorResearchStatus, validateCreatorResearchRequest } from '../server/creator-research-status.mjs';
import { createContextAuthority } from '../server/context.mjs';
import { StoryBankRepository } from '../server/repository.mjs';
import { validateWritingProfile, writingSkillDocument } from '../server/writing-profile.mjs';

const code = expected => error => error.code === expected;
const saved = (version = 1, creators = [{ name: 'Fictional writer', profileUrl: '', notes: '' }]) => ({ version, savedAt: '2026-10-23T00:00:00Z', preferences: validateWritingProfile({ creators }) });
const request = (expectedProfileVersion = 1) => ({ schema: 'storybank.creator-research-request.v1', expectedProfileVersion });

test('unsaved/empty profiles never appear collected or researched', () => {
  for (const profile of [undefined, null]) {
    const result = deriveCreatorResearchStatus(profile);
    assert.equal(result.profileVersion, 0); assert.equal(result.referenceCount, 0);
    assert.equal(result.collectionStatus, 'no_references'); assert.equal(result.researchStatus, 'not_started');
    assert.equal(result.reviewedSourceCount, 0); assert.equal(result.automaticResearchAvailable, false);
  }
  assert.equal(deriveCreatorResearchStatus(saved(1, [])).collectionStatus, 'no_references');
});

test('saved references, notes and rights-confirmed samples remain not researched', () => {
  const profile = saved(3, [{ name: 'Fictional writer', profileUrl: '', notes: 'Short openings', sample: 'A sample I wrote.', rightsConfirmed: true }]);
  const result = deriveCreatorResearchStatus(profile);
  assert.deepEqual(result, { schema: 'storybank.creator-research-status.v1', profileVersion: 3, referenceCount: 1, collectionStatus: 'references_saved', researchStatus: 'not_started', reviewedSourceCount: 0, automaticResearchAvailable: false, reason: 'RESEARCH_NOT_CONFIGURED' });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(JSON.stringify(result).includes('A sample I wrote.'), false);
  assert.equal(JSON.stringify(result).includes('Fictional writer'), false);
});

test('projection preserves old preference shapes and validates source profile', () => {
  const profile = saved(), before = structuredClone(profile);
  deriveCreatorResearchStatus(profile); assert.deepEqual(profile, before);
  for (const version of [0, -1, 1.5, '1', null]) assert.throws(() => deriveCreatorResearchStatus({ ...profile, version }), code('INVALID_PROFILE_VERSION'));
  assert.throws(() => deriveCreatorResearchStatus({ version: 1 }), code('INVALID_PROFILE'));
});

test('client-supplied research and ownership fields cannot become profile facts', () => {
  for (const extra of [{ creatorResearch: { researchStatus: 'complete' } }, { researchStatus: 'complete' }, { ownerId: 'other-user' }, { researchedSources: 50 }]) assert.throws(() => validateWritingProfile({ ...saved().preferences, ...extra }), code('INVALID_PROFILE'));
  assert.throws(() => validateWritingProfile({ creators: [{ name: 'Fictional writer', researched: true }] }), code('INVALID_PROFILE'));
});

test('reference limit and rights gate survive the optional-notes change', () => {
  assert.equal(deriveCreatorResearchStatus(saved(1, Array.from({ length: 15 }, (_, index) => ({ name: `Fictional writer ${index}` })))).referenceCount, 15);
  assert.throws(() => saved(1, Array.from({ length: 16 }, (_, index) => ({ name: `Fictional writer ${index}` }))), code('INVALID_PROFILE'));
  assert.throws(() => saved(1, [{ name: 'Fictional writer', sample: 'Uncleared sample.' }]), code('SAMPLE_RIGHTS_REQUIRED'));
});

test('future request schema accepts only its schema and exact saved version', () => {
  assert.deepEqual(validateCreatorResearchRequest(request(), saved()), request());
  for (const patch of [{ ownerId: 'other-user' }, { tenantId: 'other-workspace' }, { researchStatus: 'complete' }, { consent: true }, { allowed: true }, { sources: [] }, { profile: saved() }]) assert.throws(() => validateCreatorResearchRequest({ ...request(), ...patch }, saved()), code('INVALID_RESEARCH_REQUEST'));
  for (const input of [null, [], {}, { expectedProfileVersion: 1 }, { ...request(), schema: 'new' }, request('1'), request(0), request(1.5)]) assert.throws(() => validateCreatorResearchRequest(input, saved()), code('INVALID_RESEARCH_REQUEST'));
});

test('stale, missing or reset profiles cannot prepare an old research request', () => {
  assert.throws(() => validateCreatorResearchRequest(request(1), saved(2)), code('VERSION_CONFLICT'));
  assert.throws(() => validateCreatorResearchRequest(request(1), undefined), code('VERSION_CONFLICT'));
  assert.throws(() => validateCreatorResearchRequest(request(2), saved(2, [])), code('CREATOR_REFERENCES_REQUIRED'));
});

test('request validation cannot activate research, mutate a profile or claim a job', () => {
  const profile = saved(), before = structuredClone(profile), beforeStatus = deriveCreatorResearchStatus(profile);
  const result = validateCreatorResearchRequest(request(), profile);
  assert.deepEqual(profile, before); assert.deepEqual(deriveCreatorResearchStatus(profile), beforeStatus);
  for (const field of ['jobId', 'queued', 'consent', 'researchStatus', 'ownerId']) assert.equal(Object.hasOwn(result, field), false);
});

test('owner-filtered projections remain separate across users and workspaces; deletion clears status', () => {
  const authority = createContextAuthority({ resolveSession: id => ({ subject: id, memberships: [{ tenantId: 'first', role: 'owner' }, { tenantId: 'second', role: 'owner' }] }) });
  const repository = new StoryBankRepository({ authority });
  const alice = authority.authenticate('alice', 'first'), bob = authority.authenticate('bob', 'first'), elsewhere = authority.authenticate('alice', 'second');
  const status = context => deriveCreatorResearchStatus(repository.exportOwnData(context).data.writingProfileVersions.at(-1));
  repository.saveWritingProfile(alice, saved().preferences, { expectedVersion: 0 });
  assert.equal(status(alice).referenceCount, 1); assert.equal(status(bob).referenceCount, 0); assert.equal(status(elsewhere).referenceCount, 0);
  repository.saveWritingProfile(alice, saved(2, []).preferences, { expectedVersion: 1 });
  assert.equal(status(alice).collectionStatus, 'no_references'); assert.equal(status(alice).profileVersion, 2);
  repository.deleteOwnData(alice);
  assert.equal(status(alice).profileVersion, 0);
});

test('exported guidance explicitly distinguishes stored references from researched findings', () => {
  const document = writingSkillDocument(saved());
  assert.match(document, /Research status: Not started; 0 reviewed sources/);
  assert.match(document, /Saved references and supplied samples are not researched findings/);
});
