import { fail } from './errors.mjs';
import { validateWritingProfile } from './writing-profile.mjs';

const STATUS_SCHEMA = 'storybank.creator-research-status.v1';
const REQUEST_SCHEMA = 'storybank.creator-research-request.v1';
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Read-only projection. Pass ONLY the authenticated owner's saved profile from
 * the repository, never a browser-supplied profile or status. No source lookup,
 * job creation, consent grant, model call or persisted schema change occurs. */
export function deriveCreatorResearchStatus(savedProfile) {
  let profileVersion = 0, referenceCount = 0;
  if (savedProfile !== undefined && savedProfile !== null) {
    if (!plain(savedProfile) || !Number.isSafeInteger(savedProfile.version) || savedProfile.version < 1) fail('INVALID_PROFILE_VERSION', 'Research status requires a valid saved profile version.');
    const preferences = validateWritingProfile(savedProfile.preferences);
    profileVersion = savedProfile.version;
    referenceCount = preferences.creators.length;
  }
  return Object.freeze({
    schema: STATUS_SCHEMA, profileVersion, referenceCount,
    collectionStatus: referenceCount ? 'references_saved' : 'no_references',
    researchStatus: 'not_started', reviewedSourceCount: 0,
    automaticResearchAvailable: false, reason: 'RESEARCH_NOT_CONFIGURED',
  });
}

/** Future adapter contract only. Validation does not submit, queue or activate
 * research. The caller must authenticate first and load this owner's saved
 * profile. Unknown state, identity, rights and consent fields fail closed. */
export function validateCreatorResearchRequest(input, savedProfile) {
  const fields = ['schema', 'expectedProfileVersion'];
  if (!plain(input) || Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field)) || input.schema !== REQUEST_SCHEMA || !Number.isSafeInteger(input.expectedProfileVersion) || input.expectedProfileVersion < 1) fail('INVALID_RESEARCH_REQUEST', 'Use the supported research request schema and saved profile version.');
  const status = deriveCreatorResearchStatus(savedProfile);
  if (input.expectedProfileVersion !== status.profileVersion) fail('VERSION_CONFLICT', 'Your saved references changed. Refresh before continuing.', 409);
  if (!status.referenceCount) fail('CREATOR_REFERENCES_REQUIRED', 'Save at least one creator reference before preparing research.', 409);
  return Object.freeze({ schema: REQUEST_SCHEMA, expectedProfileVersion: status.profileVersion });
}
