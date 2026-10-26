// Synthetic local-only checks. These do not verify Sites edge header stripping,
// real visitor authentication, resource separation, or LinkedIn registration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentConfiguration, verifyDeploymentRequest } from '../server/deployment-config.mjs';
import { handleHostedRequest, verifyMutationRequest } from '../server/hosted-http.mjs';
import { personalWorkspaceId } from '../server/hosted-d1.mjs';
import { handleLinkedInRequest } from '../server/linkedin-http.mjs';
import { authorizationURL, linkedinConfiguration, publicReadiness } from '../server/linkedin-provider.mjs';
import { createD1Fixture } from './support/d1-fixture.mjs';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';

const USER = { userId: 'synthetic-owner', displayName: 'Synthetic Owner' };
const WORKSPACE = personalWorkspaceId(USER.userId);
const FOREIGN = 'https://foreign.storybank.example';
const PROVIDER_ENV = { ...TEST_DEPLOYMENT_ENV, LINKEDIN_CLIENT_ID: 'synthetic-client',
  LINKEDIN_CLIENT_SECRET: 'synthetic-secret', LINKEDIN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
  LINKEDIN_OAUTH_ENABLED: 'true', LINKEDIN_PUBLISHING_ENABLED: 'true' };
const code = (expected) => (error) => error.code === expected;
const malformedOrigins = [undefined, null, '', 17, {}, [], 'not a URL', 'null',
  'http://tester.storybank.example', '//tester.storybank.example',
  `${TEST_SITE_ORIGIN}/`, `${TEST_SITE_ORIGIN}/path`, `${TEST_SITE_ORIGIN}/..`,
  `${TEST_SITE_ORIGIN}?query=yes`, `${TEST_SITE_ORIGIN}?`, `${TEST_SITE_ORIGIN}#fragment`, `${TEST_SITE_ORIGIN}#`,
  'https://user:password@tester.storybank.example', 'https://user@tester.storybank.example', 'https://@tester.storybank.example',
  `${TEST_SITE_ORIGIN}:443`, `${TEST_SITE_ORIGIN}:0443`, `${TEST_SITE_ORIGIN}:008443`,
  'HTTPS://tester.storybank.example', 'https://TESTER.storybank.example', `${TEST_SITE_ORIGIN}.`,
  ` ${TEST_SITE_ORIGIN}`, `${TEST_SITE_ORIGIN}\n`, `\t${TEST_SITE_ORIGIN}`, `${TEST_SITE_ORIGIN}\u00a0`,
  'https://tester.\tstorybank.example', 'https://tester.storybank.example\\path',
  'https://%74ester.storybank.example', 'https://bücher.example',
  'https://localhost', 'https://sub.localhost', 'https://127.0.0.1', 'https://127.1.2.3',
  'https://127.1', 'https://2130706433', 'https://[::1]', 'https://[::ffff:7f00:1]',
  'https://[::ffff:7fff:ffff]', 'https://[::]', 'https://0.0.0.0'];
function request(path = '/api/command', { origin = TEST_SITE_ORIGIN, body = { operation: 'createStory', args: [{ text: 'Synthetic story.' }] }, headers = {}, workspace = WORKSPACE } = {}) {
  const h = new Headers({ origin, 'content-type': 'application/json', 'x-storybank-request': '1', ...headers });
  if (workspace !== null) h.set('x-storybank-workspace', workspace);
  return new Request(origin + path, { method: body === null ? 'GET' : 'POST', headers: h, ...(body === null ? {} : { body: JSON.stringify(body) }) });
}
function untouchedDB() {
  let calls = 0;
  return { db: { prepare() { calls++; throw new Error('Unexpected database access'); } }, calls: () => calls };
}

test('deployment origin is explicit, exact HTTPS; malformed/noncanonical/loopback values never normalize into acceptance', () => {
  for (const origin of malformedOrigins) {
    const result = deploymentConfiguration({ STORYBANK_SITE_ORIGIN: origin });
    assert.deepEqual(result, { origin: null, configured: false, missing: ['STORYBANK_SITE_ORIGIN'], callbackUrl: null }, String(origin));
    const provider = linkedinConfiguration({ ...PROVIDER_ENV, STORYBANK_SITE_ORIGIN: origin });
    assert.equal(provider.configured, false, String(origin));
    assert.equal(provider.oauthEnabled, false); assert.equal(provider.publishingEnabled, false);
    assert.equal(publicReadiness(provider).callbackUrl, null);
  }
  // Operators must provide the canonical ASCII/Punycode representation explicitly.
  for (const origin of [TEST_SITE_ORIGIN, `${TEST_SITE_ORIGIN}:8443`, 'https://xn--bcher-kva.example']) {
    assert.deepEqual(deploymentConfiguration({ STORYBANK_SITE_ORIGIN: origin }), {
      origin, configured: true, missing: [], callbackUrl: `${origin}/api/linkedin/callback`,
    });
  }
});

test('missing/malformed origin fails before core or LinkedIn storage reads and writes, despite forged configuration headers', async () => {
  for (const origin of malformedOrigins) {
    const env = { ...PROVIDER_ENV, STORYBANK_SITE_ORIGIN: origin };
    for (const [handler, path, body] of [
      [handleHostedRequest, '/api/workspace', null],
      [handleHostedRequest, '/api/command', { operation: 'createStory', args: [{ text: 'No write.' }] }],
      [handleLinkedInRequest, '/api/linkedin/status', null],
      [handleLinkedInRequest, '/api/linkedin/connect', { confirmation: 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING' }],
    ]) {
      const f = untouchedDB();
      const response = await handler(request(path, { body, headers: { host: 'tester.storybank.example',
        'x-forwarded-host': 'tester.storybank.example', 'x-forwarded-proto': 'https',
        forwarded: 'host=tester.storybank.example;proto=https', 'storybank-site-origin': TEST_SITE_ORIGIN,
        'x-storybank-site-origin': TEST_SITE_ORIGIN, 'x-storybank-dev': 'true' } }), { user: USER, db: f.db, env });
      assert.equal(response.status, 503, `${path}: ${String(origin)}`);
      assert.equal((await response.json()).error, 'DEPLOYMENT_NOT_CONFIGURED');
      assert.equal(f.calls(), 0);
    }
  }
});

test('foreign deployment URL and browser Origin cannot be repaired by Host/forwarding headers', async () => {
  for (const [handler, path, body] of [
    [handleHostedRequest, '/api/workspace', null],
    [handleHostedRequest, '/api/command', { operation: 'createStory', args: [{ text: 'No write.' }] }],
    [handleLinkedInRequest, '/api/linkedin/status', null],
    [handleLinkedInRequest, '/api/linkedin/callback?state=synthetic&code=synthetic', null],
  ]) {
    const f = untouchedDB();
    const req = request(path, { origin: FOREIGN, body, headers: { origin: TEST_SITE_ORIGIN,
      host: 'tester.storybank.example', 'x-forwarded-host': 'tester.storybank.example', 'x-forwarded-proto': 'https',
      forwarded: 'host=tester.storybank.example;proto=https' } });
    const response = await handler(req, { user: USER, db: f.db, env: PROVIDER_ENV });
    assert.equal(response.status, 403); assert.equal((await response.json()).error, 'ORIGIN_REJECTED');
    assert.equal(f.calls(), 0);
  }
  for (const origin of [FOREIGN, 'null', '', `${TEST_SITE_ORIGIN}/`, `${TEST_SITE_ORIGIN}, ${FOREIGN}`]) {
    assert.throws(() => verifyMutationRequest(request('/api/command', { headers: { origin } }), { env: TEST_DEPLOYMENT_ENV }), code('ORIGIN_REJECTED'));
  }
});

test('DEV permits only explicit loopback HTTP workspace requests and never enables localhost OAuth', async () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:4173', 'http://[::1]:3000']) {
    const req = request('/api/command', { origin });
    assert.throws(() => verifyMutationRequest(req), code('DEPLOYMENT_NOT_CONFIGURED'));
    assert.throws(() => verifyMutationRequest(req, { allowLocalDevelopment: 'true' }), code('DEPLOYMENT_NOT_CONFIGURED'));
    assert.doesNotThrow(() => verifyMutationRequest(req, { allowLocalDevelopment: true }));
    const f = untouchedDB();
    const result = await handleLinkedInRequest(request('/api/linkedin/connect', { origin, body: { confirmation: 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING' } }),
      { user: USER, db: f.db, env: PROVIDER_ENV, allowLocalDevelopment: true });
    assert.equal(result.status, 503); assert.equal((await result.json()).error, 'LINKEDIN_SETUP_REQUIRED');
    assert.equal(f.calls(), 0);
  }
  for (const origin of ['https://localhost:3000', 'http://localhost.evil.example', 'http://0.0.0.0:3000', 'http://192.168.1.2:3000', 'http://foreign.example']) {
    assert.throws(() => verifyDeploymentRequest(request('/api/workspace', { origin, body: null }), { allowLocalDevelopment: true }), code('DEPLOYMENT_NOT_CONFIGURED'));
  }
});

test('missing/wrong workspace preconditions reject all core writes before storage; valid owner writes and deletes stay isolated', async (t) => {
  const f = createD1Fixture(); t.after(() => f.close());
  const call = (req, user = USER) => handleHostedRequest(req, { user, db: f.db, env: TEST_DEPLOYMENT_ENV });
  for (const workspace of [null, '', 'arbitrary', personalWorkspaceId('foreign-owner')]) {
    for (const [path, body] of [['/api/command', { operation: 'createStory', args: [{ text: 'Not persisted.' }] }], ['/api/delete', { confirmation: 'DELETE_MY_WORKSPACE_DATA' }]]) {
      const guard = untouchedDB();
      const response = await handleHostedRequest(request(path, { workspace, body }), { user: USER, db: guard.db, env: TEST_DEPLOYMENT_ENV });
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'WORKSPACE_CHANGED'); assert.equal(guard.calls(), 0);
    }
  }
  assert.equal((await call(request())).status, 200);
  const other = { userId: 'foreign-owner' };
  assert.equal((await call(request(), other)).status, 409);
  assert.equal((await call(request('/api/command', { workspace: personalWorkspaceId(other.userId) }), other)).status, 200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS total FROM storybank_personal_workspaces').get().total, 2);
  const omittedDelete = await call(request('/api/delete', { workspace: null, body: { confirmation: 'DELETE_MY_WORKSPACE_DATA' } }));
  assert.equal(omittedDelete.status, 409);
  const deleted = await call(request('/api/delete', { body: { confirmation: 'DELETE_MY_WORKSPACE_DATA' } }));
  assert.equal(deleted.status, 200);
  const own = await (await call(request('/api/workspace', { body: null }))).json();
  const foreign = await (await call(request('/api/workspace', { body: null }), other)).json();
  assert.equal(own.workspace.data.stories.length, 0); assert.equal(foreign.workspace.data.stories.length, 1);
});

test('LinkedIn workspace preconditions remain mandatory for every mutation before database or provider calls', async () => {
  for (const operation of ['connect', 'disconnect', 'preview', 'publish', 'cancel']) {
    for (const workspace of [null, '', personalWorkspaceId('foreign-owner')]) {
      const f = untouchedDB(); let fetches = 0;
      const response = await handleLinkedInRequest(request(`/api/linkedin/${operation}`, { workspace, body: {} }),
        { user: USER, db: f.db, env: PROVIDER_ENV, fetcher: async () => { fetches++; throw new Error('No provider call allowed'); } });
      assert.equal(response.status, 409); assert.equal((await response.json()).error, 'WORKSPACE_CHANGED');
      assert.equal(f.calls(), 0); assert.equal(fetches, 0);
    }
  }
});

test('OAuth callback is fixed by server configuration, never by separate redirect/origin fields', () => {
  const config = linkedinConfiguration({ ...PROVIDER_ENV, LINKEDIN_REDIRECT_URI: `${FOREIGN}/callback`,
    LINKEDIN_CALLBACK_URL: `${FOREIGN}/callback`, ORIGIN: FOREIGN, HOST: 'foreign.storybank.example' });
  assert.equal(config.redirectUri, `${TEST_SITE_ORIGIN}/api/linkedin/callback`);
  const url = new URL(authorizationURL(config, { state: 'synthetic-state', nonce: 'synthetic-nonce', verifier: 'synthetic-verifier' }));
  assert.equal(url.searchParams.get('redirect_uri'), `${TEST_SITE_ORIGIN}/api/linkedin/callback`);
});
