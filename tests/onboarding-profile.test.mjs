import test from 'node:test';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContextAuthority } from '../server/context.mjs';
import { StoryBankRepository } from '../server/repository.mjs';
import { createDurableStoryBankRepository } from '../server/persistence.mjs';
import { validateWritingProfile, writingSkillDocument } from '../server/writing-profile.mjs';
import { createD1StoryBank, personalWorkspaceId } from '../server/hosted-d1.mjs';
import { handleHostedRequest, hostedContext } from '../server/hosted-http.mjs';
import { createD1Fixture } from './support/d1-fixture.mjs';

const code = (expected) => (error) => error.code === expected;
const legacy = () => ({ displayName: 'Alice', audience: '', voice: 'Plain-spoken', goals: '', preferredFormats: '', avoid: '', feedbackGuidance: '', creators: [{ name: 'Creator', profileUrl: '', notes: '' }] });
const state = (step = 1) => ({ step, status: 'in_progress', experience: { title: '', context: '', action: '', outcome: '', lesson: '' }, demoText: '', feedback: { liked: '', change: '', reason: '', revisedText: '' }, factsApproved: false });
const profile = (step = 6) => ({
  displayName: 'Alice', linkedinProfileUrl: 'https://www.linkedin.com/in/alice-fixture/',
  voice: 'Plain', tone: 'Thoughtful', hooks: 'Concrete opening', structure: 'Short paragraphs', vocabulary: 'Everyday', avoid: 'Invented results',
  creators: [{ name: 'Fixture creator', profileUrl: '', notes: 'Concrete opening with a small moment', sample: 'A synthetic sample I wrote.', rightsConfirmed: true }],
  approvedFacts: ['I changed the meeting agenda.'], feedbackProvenance: 'First demo review, supplied by Alice.', skillMarkdown: 'Keep opening sentences short.',
  onboarding: { ...state(step), experience: { title: 'A different agenda', context: 'The meeting ran long.', action: 'I changed the agenda.', outcome: '', lesson: '' }, demoText: 'The meeting ran long. I changed the agenda.', feedback: { liked: 'Short opening', change: 'Keep the outcome open', reason: '', revisedText: 'The meeting ran long. I changed the agenda.' } },
});
function localIdentity() {
  const authority = createContextAuthority({ resolveSession: (id) => ({ subject: id, memberships: [{ tenantId: 'team', role: 'owner' }] }) });
  return { authority, alice: authority.authenticate('alice', 'team'), bob: authority.authenticate('bob', 'team') };
}
function post(operation, args, ownerId = 'alice') {
  return new Request(TEST_SITE_ORIGIN + '/api/command', { method: 'POST', headers: { origin: TEST_SITE_ORIGIN, 'content-type': 'application/json', 'x-storybank-request': '1', 'x-storybank-workspace': personalWorkspaceId(ownerId) }, body: JSON.stringify({ operation, args }) });
}

test('legacy preference and creator shapes remain exactly unchanged; optional fields never appear by default', () => {
  assert.deepEqual(validateWritingProfile(legacy()), legacy());
  const empty = validateWritingProfile({});
  assert.deepEqual(Object.keys(empty), ['displayName', 'audience', 'voice', 'goals', 'preferredFormats', 'avoid', 'feedbackGuidance', 'creators']);
  assert.deepEqual(empty.creators, []);
  // Historical bookmark shape is still readable outside the guided flow.
  const old = legacy(); old.creators[0].profileUrl = 'https://www.linkedin.com/in/';
  assert.deepEqual(validateWritingProfile(old), old);
});

test('unfinished current steps can be saved, and navigation requires all earlier inputs', () => {
  assert.equal(validateWritingProfile({ onboarding: state(1) }).onboarding.step, 1);
  assert.throws(() => validateWritingProfile({ onboarding: state(2) }), code('ONBOARDING_IDENTITY_REQUIRED'));
  const p = profile(2); p.creators = []; p.onboarding.experience = state().experience;
  assert.equal(validateWritingProfile(p).onboarding.step, 2);
  p.onboarding.step = 3;
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_REFERENCES_REQUIRED'));
  p.creators = [{ name: 'Creator', notes: '' }];
  assert.equal(validateWritingProfile(p).onboarding.step, 3, 'Creator notes are optional, not research homework.');
  p.creators[0].notes = 'Short paragraphs';
  assert.equal(validateWritingProfile(p).onboarding.step, 3);
  p.onboarding.step = 4;
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_EXPERIENCE_REQUIRED'));
  p.onboarding.experience = profile().onboarding.experience;
  p.onboarding.demoText = '';
  assert.equal(validateWritingProfile(p).onboarding.step, 4);
  p.onboarding.step = 5;
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_DEMO_REQUIRED'));
  p.onboarding.demoText = profile().onboarding.demoText;
  p.onboarding.feedback = state().feedback;
  assert.equal(validateWritingProfile(p).onboarding.step, 5);
  p.onboarding.step = 6;
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_FEEDBACK_REQUIRED'));
  p.onboarding.feedback.liked = 'Short opening';
  p.onboarding.feedback.revisedText = p.onboarding.demoText;
  assert.equal(validateWritingProfile(p).onboarding.step, 6);
  // Back navigation can preserve later work, while clearing incomplete earlier inputs.
  p.onboarding.step = 1; p.displayName = ''; p.linkedinProfileUrl = ''; p.creators = [];
  assert.equal(validateWritingProfile(p).onboarding.demoText, profile().onboarding.demoText);
});

test('onboarding rejects invalid step/status/type, unknown nested fields, and false completion', () => {
  for (const step of [0, 7, 1.5, '1', null]) assert.throws(() => validateWritingProfile({ onboarding: { ...state(), step } }), code('INVALID_PROFILE'));
  for (const patch of [{ status: 'connected' }, { factsApproved: 'yes' }, { userId: 'bob' }, { experience: { ...state().experience, password: 'not-a-secret' } }, { feedback: { ...state().feedback, approvedBy: 'bob' } }]) {
    assert.throws(() => validateWritingProfile({ onboarding: { ...state(), ...patch } }), code('INVALID_PROFILE'));
  }
  const p = profile(); p.onboarding.status = 'complete';
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_REVIEW_REQUIRED'));
  p.onboarding.factsApproved = true;
  assert.equal(validateWritingProfile(p).onboarding.status, 'complete');
  p.onboarding.step = 5;
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_REVIEW_REQUIRED'));
});

test('identity requires an HTTPS LinkedIn person URL, never credentials or a connection claim', () => {
  for (const linkedinProfileUrl of ['http://linkedin.com/in/a', 'https://linkedin.com.evil.test/in/a', 'https://u:p@linkedin.com/in/a', 'https://linkedin.com/company/a', 'https://linkedin.com/in/', 'https://linkedin.com/in/a/more', 'javascript:alert(1)']) {
    assert.throws(() => validateWritingProfile({ ...profile(2), linkedinProfileUrl }), code('INVALID_PROFILE'));
  }
  for (const field of ['password', 'accessToken', 'refreshToken', 'oauthConnected', 'connected', 'tenantId', 'userId', 'encrypted', 'aiTrained']) assert.throws(() => validateWritingProfile({ ...profile(), [field]: 'not-accepted' }), code('INVALID_PROFILE'));
});

test('creator minimum applies only to onboarding; 15 maximum and named-or-linked references are enforced', () => {
  assert.deepEqual(validateWritingProfile({ creators: [] }).creators, []);
  const p = profile(3); p.creators = [{ profileUrl: 'https://linkedin.com/in/fixture', notes: 'Concrete anecdotes' }];
  assert.equal(validateWritingProfile(p).creators[0].name, '');
  p.creators = Array.from({ length: 15 }, (_, i) => ({ name: `Creator ${i}`, notes: 'Concise endings' }));
  assert.equal(validateWritingProfile(p).creators.length, 15);
  p.creators.push({ name: 'Too many', notes: 'Concrete anecdotes' });
  assert.throws(() => validateWritingProfile(p), code('INVALID_PROFILE'));
  assert.throws(() => validateWritingProfile({ creators: [{ name: ' ', notes: 'Notes' }] }), code('INVALID_PROFILE'));
});

test('sample text requires explicit rights confirmation and is bounded; no source is fetched', () => {
  for (const rightsConfirmed of [undefined, false]) assert.throws(() => validateWritingProfile({ creators: [{ name: 'Creator', sample: 'Owned sample', ...(rightsConfirmed === undefined ? {} : { rightsConfirmed }) }] }), code('SAMPLE_RIGHTS_REQUIRED'));
  assert.throws(() => validateWritingProfile({ creators: [{ name: 'Creator', rightsConfirmed: 'yes' }] }), code('INVALID_PROFILE'));
  assert.equal(validateWritingProfile({ creators: [{ name: 'Creator', sample: 'a'.repeat(8_000), rightsConfirmed: true }] }).creators[0].sample.length, 8_000);
  assert.throws(() => validateWritingProfile({ creators: [{ name: 'Creator', sample: 'a'.repeat(8_001), rightsConfirmed: true }] }), code('INVALID_PROFILE'));
});

test('no outcome is invented or required; concrete feedback and changed-text reasons are gated', () => {
  const p = profile();
  assert.equal(validateWritingProfile(p).onboarding.experience.outcome, '');
  for (const liked of ['', 'good', 'looks good', 'yes']) {
    p.onboarding.feedback = { liked, change: '', reason: '', revisedText: '' };
    assert.throws(() => validateWritingProfile(p), code('ONBOARDING_FEEDBACK_REQUIRED'));
  }
  p.onboarding.feedback = { liked: 'Direct opening', change: '', reason: '', revisedText: 'A different opening.' };
  assert.throws(() => validateWritingProfile(p), code('ONBOARDING_REVISION_REASON_REQUIRED'));
  p.onboarding.feedback.reason = 'Start with the concrete action.';
  assert.equal(validateWritingProfile(p).onboarding.feedback.revisedText, 'A different opening.');
  p.onboarding.feedback.revisedText = p.onboarding.demoText; p.onboarding.feedback.reason = '';
  assert.doesNotThrow(() => validateWritingProfile(p));
});

test('text, approved-fact, and optional field limits reject malformed payloads', () => {
  for (const patch of [{ approvedFacts: [''] }, { approvedFacts: Array(51).fill('Fact') }, { approvedFacts: ['a'.repeat(4_001)] }, { feedbackProvenance: [] }, { skillMarkdown: 'a'.repeat(30_001) }, { tone: false }, { onboarding: null }]) assert.throws(() => validateWritingProfile({ ...profile(), ...patch }), code('INVALID_PROFILE'));
  const p = profile(); p.onboarding.demoText = 'a'.repeat(20_001);
  assert.throws(() => validateWritingProfile(p), code('INVALID_PROFILE'));
});

test('optional selective emphasis is enum-validated, remains absent in legacy profiles, and exports honest formatting guidance', () => {
  assert.ok(!Object.hasOwn(validateWritingProfile(legacy()), 'emphasis'));
  const expected = {
    hook_takeaway: 'only for the opening hook and closing takeaway. Keep the body in normal text',
    manual: 'only text explicitly selected by the writer',
    none: 'Use plain text throughout',
  };
  for (const [emphasis, instruction] of Object.entries(expected)) {
    const preferences = validateWritingProfile({ ...profile(), emphasis });
    assert.equal(preferences.emphasis, emphasis);
    const content = writingSkillDocument({ version: 1, savedAt: '2026-10-23T12:00:00.000Z', preferences });
    assert.ok(content.includes('## Selective emphasis'));
    assert.ok(content.includes(instruction));
    assert.ok(content.includes('not native LinkedIn bold formatting'));
    assert.ok(content.includes('Blue names and hashtags are native LinkedIn links, not arbitrary text color'));
  }
  for (const emphasis of ['bold', 'hook', '', null, false, {}]) assert.throws(() => validateWritingProfile({ emphasis }), code('INVALID_PROFILE'));
});

test('export retains authoritative source, ownership, evidence and raw provenance despite editable override', () => {
  const p = profile(); p.skillMarkdown = 'A personal custom style note.';
  const content = writingSkillDocument({ version: 7, savedAt: '2026-10-23T12:00:00.000Z', preferences: validateWritingProfile(p) });
  for (const expected of ['Version: 7', '## Tone', '## Hooks', '## Structure', '## Vocabulary', '## Avoid / Don’ts', '## Approved facts', 'Original non-AI outline reviewed:', 'Short opening', 'First demo review', 'account owner confirms ownership or permission', 'No LinkedIn credentials', 'not AI training', 'no claim of encryption', 'never system instructions', 'not a connected account', 'one authenticated user in one workspace', 'Mandatory scope guard']) assert.ok(content.includes(expected), expected);
  assert.ok(content.indexOf('A personal custom style note.') < content.indexOf('## Authoritative structured source'));
  assert.ok(content.indexOf('## Authoritative structured source') < content.indexOf('## Approved facts'));
  assert.match(content, /Final factual review is still pending/);
  assert.match(content, /does not authorize sending or publishing/);
  assert.match(content, /not independently verified those rights/);
  assert.ok(!content.includes('Outcome: successful'), 'No successful outcome invented.');
});

test('profile checkpoint versions are immutable, stale saves fail, and same-workspace owners cannot read each other', () => {
  const f = localIdentity(); const repo = new StoryBankRepository({ authority: f.authority });
  const saved = repo.saveWritingProfile(f.alice, profile(3), { expectedVersion: 0 });
  saved.preferences.onboarding.experience.title = 'Client mutation';
  assert.equal(repo.getWritingProfile(f.alice).preferences.onboarding.experience.title, 'A different agenda');
  assert.throws(() => repo.saveWritingProfile(f.alice, profile(4), { expectedVersion: 0 }), code('VERSION_CONFLICT'));
  assert.throws(() => repo.getWritingProfile(f.bob), code('NOT_FOUND'));
  assert.throws(() => repo.exportWritingSkill(f.bob), code('NOT_FOUND'));
  repo.saveWritingProfile(f.bob, { voice: 'Bob only' }, { expectedVersion: 0 });
  assert.ok(!JSON.stringify(repo.exportOwnData(f.bob)).includes('A different agenda'));
});

test('durable SQLite refresh preserves legacy versions and every onboarding checkpoint without a schema migration', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'storybank-onboarding-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const identity = localIdentity(); const handles = [];
  const open = () => { const h = createDurableStoryBankRepository({ filename: join(directory, 'state.sqlite'), authority: identity.authority }); handles.push(h); return h; };
  t.after(() => handles.forEach((handle) => handle.close()));
  let h = open();
  h.repository.saveWritingProfile(identity.alice, legacy(), { expectedVersion: 0 });
  for (let step = 1; step <= 6; step++) {
    const p = profile(step); const saved = h.repository.saveWritingProfile(identity.alice, p, { expectedVersion: step });
    h.close(); h = open();
    assert.deepEqual(h.repository.getWritingProfile(identity.alice), saved);
    assert.deepEqual(h.repository.getWritingProfile(identity.alice, { version: 1 }).preferences, legacy());
    assert.throws(() => h.repository.getWritingProfile(identity.bob), code('NOT_FOUND'));
  }
});

test('hosted HTTP checkpoints reload through D1, retain old profiles, reject bypasses, and never claim OAuth or AI', async (t) => {
  const f = createD1Fixture(); t.after(() => f.close());
  const user = { userId: 'alice', displayName: 'Alice' };
  const call = async (operation, args, owner = user) => {
    const response = await handleHostedRequest(post(operation, args, owner.userId), { env: TEST_DEPLOYMENT_ENV, user: owner, db: f.db });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await call('saveWritingProfile', [legacy(), { expectedVersion: 0 }])).status, 200);
  const saved = await call('saveWritingProfile', [profile(3), { expectedVersion: 1 }]);
  assert.equal(saved.status, 200);
  const reloaded = await handleHostedRequest(new Request(TEST_SITE_ORIGIN + '/api/workspace'), { env: TEST_DEPLOYMENT_ENV, user, db: f.db });
  const refreshed = await reloaded.json();
  assert.equal(refreshed.user.workspaceKey, personalWorkspaceId('alice'));
  const data = refreshed.workspace.data;
  assert.deepEqual(data.writingProfileVersions[0].preferences, legacy());
  assert.deepEqual(data.writingProfileVersions[1], saved.body.result);
  const identity = hostedContext(user);
  const restarted = createD1StoryBank({ db: f.db, authority: identity.authority });
  assert.deepEqual(await restarted.invoke(identity.context, 'getWritingProfile'), saved.body.result);
  assert.equal((await call('getWritingProfile', [], { userId: 'bob' })).status, 404);
  assert.equal((await call('saveWritingProfile', [profile(4), { expectedVersion: 1 }])).status, 409);
  const incomplete = profile(6); incomplete.creators = [];
  const rejected = await call('saveWritingProfile', [incomplete, { expectedVersion: 2 }]);
  assert.equal(rejected.status, 400); assert.equal(rejected.body.error, 'ONBOARDING_REFERENCES_REQUIRED');
  assert.deepEqual((await call('integrationStatus', [])).body.result, { status: 'disabled', livePublishing: false, oauthConnected: false });
  const calibration = await call('createCalibration', [{ topic: 'Synthetic meeting', facts: ['I changed the agenda.'], count: 3 }]);
  assert.equal(calibration.body.result.mode, 'non_ai_template_preview');
});

test('workspace consistency header rejects silent account switches before saving or deleting', async (t) => {
  const f = createD1Fixture(); t.after(() => f.close());
  const user = { userId: 'bob' };
  const priorWorkspace = personalWorkspaceId('alice');
  const save = post('saveWritingProfile', [profile(3), { expectedVersion: 0 }]);
  save.headers.set('x-storybank-workspace', priorWorkspace);
  const rejected = await handleHostedRequest(save, { env: TEST_DEPLOYMENT_ENV, user, db: f.db });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, 'WORKSPACE_CHANGED');
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM storybank_personal_workspaces').get().total, 0);
  const valid = post('saveWritingProfile', [{ voice: 'Bob only' }, { expectedVersion: 0 }]);
  valid.headers.set('x-storybank-workspace', personalWorkspaceId('bob'));
  assert.equal((await handleHostedRequest(valid, { env: TEST_DEPLOYMENT_ENV, user, db: f.db })).status, 200);
  const remove = new Request(TEST_SITE_ORIGIN + '/api/delete', { method: 'POST', headers: { origin: TEST_SITE_ORIGIN, 'content-type': 'application/json', 'x-storybank-request': '1', 'x-storybank-workspace': priorWorkspace }, body: JSON.stringify({ confirmation: 'DELETE_MY_WORKSPACE_DATA' }) });
  assert.equal((await handleHostedRequest(remove, { env: TEST_DEPLOYMENT_ENV, user, db: f.db })).status, 409);
  const current = await handleHostedRequest(post('getWritingProfile', [], user.userId), { env: TEST_DEPLOYMENT_ENV, user, db: f.db });
  assert.equal((await current.json()).result.preferences.voice, 'Bob only');
});

test('hosted profile request cap permits 15 rights-cleared 8k samples but remains bounded', async (t) => {
  const f = createD1Fixture(); t.after(() => f.close());
  const user = { userId: 'fixture-large-profile' };
  const p = profile(3); p.creators = Array.from({ length: 15 }, (_, index) => ({ name: `Creator ${index}`, notes: 'Short sentences', sample: 'a'.repeat(8_000), rightsConfirmed: true }));
  const accepted = await handleHostedRequest(post('saveWritingProfile', [p, { expectedVersion: 0 }], user.userId), { env: TEST_DEPLOYMENT_ENV, user, db: f.db });
  assert.equal(accepted.status, 200);
  const tooLarge = await handleHostedRequest(post('saveWritingProfile', [{ skillMarkdown: 'a'.repeat(524_288) }, { expectedVersion: 1 }], user.userId), { env: TEST_DEPLOYMENT_ENV, user, db: f.db });
  assert.equal(tooLarge.status, 413);
  assert.equal((await tooLarge.json()).error, 'BODY_TOO_LARGE');
  const regular = await handleHostedRequest(post('createStory', [{ text: 'a'.repeat(70_000) }], user.userId), { env: TEST_DEPLOYMENT_ENV, user, db: f.db });
  assert.equal(regular.status, 413);
});
