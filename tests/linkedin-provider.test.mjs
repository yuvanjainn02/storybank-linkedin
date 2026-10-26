// Synthetic provider-contract/security tests only. No real credentials,
// OAuth grants, LinkedIn HTTP calls, or public posts are used in this file.
import test from 'node:test';
import { TEST_SITE_ORIGIN, TEST_DEPLOYMENT_ENV } from './support/deployment-fixture.mjs';
import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import {
  LINKEDIN, authorizationURL, equalDigest, exchangeLinkedInCode,
  linkedinCommentary, linkedinConfiguration, openSecret, publicReadiness,
  publishLinkedInText, randomSecret, sealSecret, sha256, verifyLinkedInIDToken,
} from '../server/linkedin-provider.mjs';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const SECONDS = NOW / 1000;
const NONCE = 'synthetic-oidc-nonce';
const TOKEN = 'synthetic-access-token-not-a-real-credential';
const KEY = Buffer.alloc(32, 7).toString('base64');
const CLIENT_ID = 'synthetic-client';
const CLIENT_SECRET = 'synthetic-client-secret-not-a-real-credential';
const ENV = {
  ...TEST_DEPLOYMENT_ENV,
  LINKEDIN_CLIENT_ID: CLIENT_ID, LINKEDIN_CLIENT_SECRET: CLIENT_SECRET,
  LINKEDIN_TOKEN_KEY: KEY, LINKEDIN_OAUTH_ENABLED: 'true', LINKEDIN_PUBLISHING_ENABLED: 'true',
};
const CONFIG = linkedinConfiguration(ENV);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-test-key', alg: 'RS256', use: 'sig' };
const BASE_CLAIMS = {
  iss: LINKEDIN.issuer, aud: CLIENT_ID, sub: 'synthetic_person-123',
  iat: SECONDS, exp: SECONDS + 600, nonce: NONCE,
};
const SNAPSHOT = { author: `urn:li:person:${BASE_CLAIMS.sub}`, text: 'Synthetic text, never published.', visibility: 'PUBLIC' };
const base64JSON = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function signedToken(claims = BASE_CLAIMS, header = {}) {
  const unsigned = `${base64JSON({ alg: 'RS256', kid: JWK.kid, ...header })}.${base64JSON(claims)}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url')}`;
}
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status });
const expectCode = (code) => (error) => error?.code === code;
const forbiddenFetch = async () => { throw new Error('Synthetic test unexpectedly attempted an HTTP operation.'); };
function checkedOptions(options) {
  assert.equal(options.redirect, 'error');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
}
function verificationOptions(keys = [JWK], extra = {}) {
  return {
    clientId: CLIENT_ID, nonceHash: sha256(NONCE), now: NOW,
    fetcher: async (url, options) => {
      assert.equal(url, LINKEDIN.jwks);
      checkedOptions(options);
      return jsonResponse({ keys });
    },
    ...extra,
  };
}
function exchangeFixture({ token = {}, profile = {}, responseFor } = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    checkedOptions(options);
    if (responseFor) {
      const response = await responseFor(url, options);
      if (response) return response;
    }
    if (url === LINKEDIN.token) return jsonResponse({
      access_token: TOKEN, expires_in: 3600, token_type: 'Bearer', scope: LINKEDIN.scopes,
      id_token: signedToken(), refresh_token: 'synthetic-refresh-token-not-retained', ...token,
    });
    if (url === LINKEDIN.jwks) return jsonResponse({ keys: [JWK] });
    if (url === LINKEDIN.userinfo) return jsonResponse({
      sub: BASE_CLAIMS.sub, name: 'Synthetic Member', email: 'synthetic@example.invalid',
      picture: 'https://example.invalid/synthetic-avatar.png', ...profile,
    });
    throw new Error(`Unexpected synthetic endpoint: ${url}`);
  };
  return { calls, fetcher, options: { code: 'synthetic-code', nonceHash: sha256(NONCE), verifier: 'synthetic-verifier', now: NOW, fetcher } };
}

test('synthetic configuration fails closed and public readiness never exposes credentials', () => {
  const absent = linkedinConfiguration({ LINKEDIN_OAUTH_ENABLED: 'true', LINKEDIN_PUBLISHING_ENABLED: 'true' });
  assert.equal(absent.configured, false);
  assert.equal(absent.oauthEnabled, false);
  assert.equal(absent.publishingEnabled, false);
  assert.deepEqual(absent.missing.sort(), ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_TOKEN_KEY', 'STORYBANK_SITE_ORIGIN']);
  assert.equal(CONFIG.configured, true);
  assert.equal(CONFIG.origin, TEST_SITE_ORIGIN);
  assert.equal(CONFIG.redirectUri, `${TEST_SITE_ORIGIN}/api/linkedin/callback`);
  assert.equal(CONFIG.schedulerVerified, false);
  assert.equal(CONFIG.pkceEnabled, false);
  assert.equal(CONFIG.apiVersion, '202610');
  for (const key of ['', 'x', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64')]) {
    assert.equal(linkedinConfiguration({ ...ENV, LINKEDIN_TOKEN_KEY: key }).configured, false);
  }
  const serialized = JSON.stringify(publicReadiness(CONFIG));
  for (const secret of [CLIENT_SECRET, KEY, TOKEN]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(publicReadiness(CONFIG).scopes, ['openid', 'profile', 'w_member_social']);
});

test('synthetic authorization URL uses fixed endpoints, minimal scopes and explicit opt-in PKCE', () => {
  const request = { state: randomSecret(), nonce: randomSecret(), verifier: randomSecret() };
  for (const value of Object.values(request)) assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  const url = new URL(authorizationURL(CONFIG, request));
  assert.equal(`${url.origin}${url.pathname}`, LINKEDIN.authorization);
  for (const [key, value] of Object.entries({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: CONFIG.redirectUri, scope: LINKEDIN.scopes, state: request.state, nonce: request.nonce })) assert.equal(url.searchParams.get(key), value);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(url.searchParams.has('code_challenge'), false);
  const pkce = new URL(authorizationURL({ ...CONFIG, pkceEnabled: true }, request));
  assert.equal(pkce.searchParams.get('code_challenge'), createHash('sha256').update(request.verifier).digest('base64url'));
  assert.equal(pkce.searchParams.get('code_challenge_method'), 'S256');
  assert.throws(() => authorizationURL({ ...CONFIG, oauthEnabled: false }, request), expectCode('LINKEDIN_SETUP_REQUIRED'));
  assert.equal(equalDigest(sha256('same'), sha256('same')), true);
  assert.equal(equalDigest(sha256('same'), sha256('different')), false);
  for (const input of ['', undefined, 'z'.repeat(64), 'a'.repeat(63)]) assert.equal(equalDigest(input, sha256('same')), false);
});

test('synthetic AES-GCM vault binds owner and purpose, rejects tampering and noncanonical envelopes', async () => {
  const aad = JSON.stringify(['linkedin', 'token', 'synthetic-owner', 'synthetic-connection']);
  const encrypted = await sealSecret(TOKEN, KEY, aad);
  const second = await sealSecret(TOKEN, KEY, aad);
  assert.notEqual(encrypted, second);
  assert.equal(encrypted.includes(TOKEN), false);
  assert.equal(await openSecret(encrypted, KEY, aad), TOKEN);
  await assert.rejects(openSecret(encrypted, Buffer.alloc(32, 8).toString('base64'), aad), expectCode('CONNECTION_UNREADABLE'));
  await assert.rejects(openSecret(encrypted, KEY, 'different-owner-or-purpose'), expectCode('CONNECTION_UNREADABLE'));
  const [version, iv, payload] = encrypted.split('.');
  const bytes = Buffer.from(payload, 'base64url'); bytes[0] ^= 1;
  for (const invalid of [
    `${version}.${iv}.${bytes.toString('base64url')}`, `v2.${iv}.${payload}`,
    `${version}.AA.${payload}`, `${version}.${iv}.`, encrypted + '.', encrypted + '..ignored',
    `${version}.${iv}.${payload}!`, null, '',
  ]) await assert.rejects(openSecret(invalid, KEY, aad), expectCode('CONNECTION_UNREADABLE'));
});

test('synthetic OIDC accepts a valid RS256 identity and an explicitly authorized multi-audience token', async () => {
  assert.deepEqual(await verifyLinkedInIDToken(signedToken(), verificationOptions()), { subject: BASE_CLAIMS.sub });
  assert.deepEqual(await verifyLinkedInIDToken(signedToken({ ...BASE_CLAIMS, aud: [CLIENT_ID, 'synthetic-other-audience'], azp: CLIENT_ID }), verificationOptions()), { subject: BASE_CLAIMS.sub });
  // A token-supplied key URL must never select the verification endpoint.
  assert.deepEqual(await verifyLinkedInIDToken(signedToken(BASE_CLAIMS, { jku: 'https://example.invalid/attacker-jwks' }), verificationOptions()), { subject: BASE_CLAIMS.sub });
});

test('synthetic OIDC rejects wrong identity, audience, nonce, timing and subject claims', async (t) => {
  const invalid = {
    'stale documented issuer': { iss: 'https://www.linkedin.com' },
    'foreign issuer': { iss: 'https://example.invalid' },
    'wrong audience': { aud: 'synthetic-attacker' },
    'missing audience': { aud: undefined },
    'empty audience': { aud: [] },
    'missing multi-audience authorized party': { aud: [CLIENT_ID, 'synthetic-other'] },
    'wrong authorized party': { azp: 'synthetic-other' },
    'missing nonce': { nonce: undefined },
    'wrong nonce': { nonce: 'synthetic-other' },
    'expired token': { exp: SECONDS },
    'nonnumeric expiry': { exp: String(SECONDS + 600) },
    'future issue time': { iat: SECONDS + 61 },
    'stale issue time': { iat: SECONDS - 601 },
    'expiry before issue time': { iat: SECONDS + 1, exp: SECONDS + 1 },
    'future not-before': { nbf: SECONDS + 61 },
    'nonnumeric not-before': { nbf: String(SECONDS) },
    'missing subject': { sub: undefined },
    'URL-like subject': { sub: 'https://example.invalid' },
  };
  for (const [name, patch] of Object.entries(invalid)) await t.test(`synthetic ${name}`, async () => {
    await assert.rejects(verifyLinkedInIDToken(signedToken({ ...BASE_CLAIMS, ...patch }), verificationOptions()), expectCode('LINKEDIN_IDENTITY_INVALID'));
  });
});

test('synthetic OIDC rejects algorithm confusion, malformed tokens, bad signatures and untrusted keys', async () => {
  for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { kid: 'unavailable-key' }, { crit: ['synthetic-extension'] }]) {
    await assert.rejects(verifyLinkedInIDToken(signedToken(BASE_CLAIMS, header), verificationOptions()), expectCode('LINKEDIN_IDENTITY_INVALID'));
  }
  const parts = signedToken().split('.');
  const alteredSignature = Buffer.from(parts[2], 'base64url'); alteredSignature[0] ^= 1;
  for (const token of [null, '', 'only.two', 'a'.repeat(20_001), `${parts[0]}.${parts[1]}.${alteredSignature.toString('base64url')}`, `${parts[0]}.${parts[1]}.!`]) {
    await assert.rejects(verifyLinkedInIDToken(token, verificationOptions()), expectCode('LINKEDIN_IDENTITY_INVALID'));
  }
  for (const keys of [[], [JWK, JWK], [{ ...JWK, use: 'enc' }], [{ ...JWK, alg: 'RS512' }], Array(51).fill(JWK)]) {
    await assert.rejects(verifyLinkedInIDToken(signedToken(), verificationOptions(keys)), expectCode('LINKEDIN_IDENTITY_INVALID'));
  }
  await assert.rejects(verifyLinkedInIDToken(signedToken(), verificationOptions([], { fetcher: async () => new Response('x'.repeat(65_537)) })), expectCode('LINKEDIN_IDENTITY_INVALID'));
});

test('synthetic token exchange checks scopes and identity and retains only necessary connection data', async () => {
  for (const scope of ['openid profile w_member_social', 'openid%20profile%20w_member_social', 'openid,profile,w_member_social', 'openid+profile+w_member_social']) {
    const fixture = exchangeFixture({ token: { scope } });
    const result = await exchangeLinkedInCode(CONFIG, fixture.options);
    assert.deepEqual(result, { subject: BASE_CLAIMS.sub, personUrn: SNAPSHOT.author, displayName: 'Synthetic Member', accessToken: TOKEN, expiresAt: NOW + 3_600_000, scopes: LINKEDIN.scopes });
    assert.deepEqual(fixture.calls.map((call) => call.url), [LINKEDIN.token, LINKEDIN.jwks, LINKEDIN.userinfo]);
    const tokenCall = fixture.calls[0];
    assert.equal(tokenCall.options.method, 'POST');
    const body = new URLSearchParams(tokenCall.options.body);
    assert.equal(body.get('client_secret'), CLIENT_SECRET);
    assert.equal(body.get('redirect_uri'), CONFIG.redirectUri);
    assert.equal(body.has('code_verifier'), false);
    assert.equal(fixture.calls[2].options.headers.authorization, `Bearer ${TOKEN}`);
    for (const key of ['refresh_token', 'id_token', 'email', 'picture', 'clientSecret']) assert.equal(Object.hasOwn(result, key), false);
  }
  const pkce = exchangeFixture();
  await exchangeLinkedInCode({ ...CONFIG, pkceEnabled: true }, pkce.options);
  assert.equal(new URLSearchParams(pkce.calls[0].options.body).get('code_verifier'), pkce.options.verifier);
});

test('synthetic token exchange rejects disabled flow before any provider call', async () => {
  let calls = 0;
  const fixture = exchangeFixture();
  await assert.rejects(exchangeLinkedInCode({ ...CONFIG, oauthEnabled: false }, {
    ...fixture.options, fetcher: async (...args) => { calls++; return fixture.fetcher(...args); },
  }), expectCode('LINKEDIN_SETUP_REQUIRED'));
  assert.equal(calls, 0);
  for (const code of [null, '', 'x'.repeat(4097)]) await assert.rejects(exchangeLinkedInCode(CONFIG, { ...fixture.options, code, fetcher: forbiddenFetch }), expectCode('OAUTH_CODE_INVALID'));
});

test('synthetic token exchange fails closed on missing scopes, invalid tokens and mismatched userinfo', async () => {
  for (const scope of [undefined, '', 'openid profile', 'openid profile fake_w_member_social']) {
    const fixture = exchangeFixture({ token: { scope } });
    await assert.rejects(exchangeLinkedInCode(CONFIG, fixture.options), expectCode('LINKEDIN_SCOPE_MISSING'));
    assert.equal(fixture.calls.length, 1);
  }
  const broad = exchangeFixture({ token: { scope: LINKEDIN.scopes + ' email' } });
  await assert.rejects(exchangeLinkedInCode(CONFIG, broad.options), expectCode('LINKEDIN_SCOPE_UNEXPECTED'));
  assert.equal(broad.calls.length, 1);
  for (const token of [{ access_token: 'short' }, { access_token: 'x'.repeat(16001) }, { expires_in: 60 }, { expires_in: '3600' }, { expires_in: 367 * 86400 }, { token_type: 'MAC' }]) {
    const fixture = exchangeFixture({ token });
    await assert.rejects(exchangeLinkedInCode(CONFIG, fixture.options), expectCode('OAUTH_EXCHANGE_FAILED'));
  }
  for (const profile of [{ sub: 'synthetic-other-person' }, { name: '' }, { name: 'x'.repeat(301) }]) {
    const fixture = exchangeFixture({ profile });
    await assert.rejects(exchangeLinkedInCode(CONFIG, fixture.options), expectCode('OAUTH_EXCHANGE_FAILED'));
  }
  const failure = exchangeFixture({ responseFor: async (url) => url === LINKEDIN.token ? new Response(`private ${TOKEN} ${CLIENT_SECRET}`, { status: 400 }) : null });
  await assert.rejects(exchangeLinkedInCode(CONFIG, failure.options), (error) => {
    assert.equal(error.message.includes(TOKEN), false);
    assert.equal(error.message.includes(CLIENT_SECRET), false);
    return error.code === 'OAUTH_EXCHANGE_FAILED';
  });
});

test('synthetic plain-text encoding preserves Unicode and escapes all little-text control characters', () => {
  assert.equal(linkedinCommentary('|{}@[]()<>#\\*_~'), '\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~');
  assert.equal(linkedinCommentary('A café 😃\nभारत 中文'), 'A café 😃\nभारत 中文');
  assert.equal(linkedinCommentary('@[Synthetic](urn:li:person:123)'), '\\@\\[Synthetic\\]\\(urn:li:person:123\\)');
});

test('synthetic publishing sends only the exact approved text to the fixed official endpoint', async () => {
  const snapshot = { ...SNAPSHOT, text: 'Synthetic #tag, (aside), @name and \\ path.\nनमस्ते', visibility: 'CONNECTIONS' };
  const result = await publishLinkedInText(CONFIG, { accessToken: TOKEN, snapshot, fetcher: async (url, options) => {
    assert.equal(url, LINKEDIN.posts);
    checkedOptions(options);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['LinkedIn-Version'], '202610');
    assert.equal(options.headers['X-Restli-Protocol-Version'], '2.0.0');
    assert.deepEqual(JSON.parse(options.body), {
      author: snapshot.author, commentary: linkedinCommentary(snapshot.text), visibility: 'CONNECTIONS',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false,
    });
    return new Response(null, { status: 201, headers: { 'X-RestLi-Id': 'urn:li:ugcPost:12345' } });
  } });
  assert.deepEqual(result, { status: 'published', postUrn: 'urn:li:ugcPost:12345', reason: null });
});

test('synthetic publishing rejects invalid input before any provider call', async () => {
  await assert.rejects(publishLinkedInText({ ...CONFIG, publishingEnabled: false }, { accessToken: TOKEN, snapshot: SNAPSHOT, fetcher: forbiddenFetch }), expectCode('PUBLISHING_DISABLED'));
  for (const snapshot of [null, { ...SNAPSHOT, author: 'urn:li:organization:123' }, { ...SNAPSHOT, text: '' }, { ...SNAPSHOT, text: '  ' }, { ...SNAPSHOT, text: 'x'.repeat(3001) }, { ...SNAPSHOT, visibility: 'EVERYONE' }]) {
    await assert.rejects(publishLinkedInText(CONFIG, { accessToken: TOKEN, snapshot, fetcher: forbiddenFetch }), expectCode('INVALID_PUBLICATION'));
  }
});

test('synthetic publishing classifies confirmed rejection versus unknown without automatic retries', async () => {
  for (const [status, urn, expected] of [
    [201, 'urn:li:share:123', 'published'], [201, undefined, 'unknown'], [201, 'urn:li:person:123', 'unknown'],
    [201, 'urn:li:share:not-a-number', 'unknown'], [200, 'urn:li:share:123', 'unknown'],
    [400, undefined, 'rejected'], [401, undefined, 'rejected'], [403, undefined, 'rejected'],
    [404, undefined, 'rejected'], [410, undefined, 'rejected'], [422, undefined, 'rejected'], [429, undefined, 'rejected'],
    [302, undefined, 'unknown'], [409, undefined, 'unknown'], [500, undefined, 'unknown'], [503, undefined, 'unknown'],
  ]) {
    let calls = 0;
    const result = await publishLinkedInText(CONFIG, { accessToken: TOKEN, snapshot: SNAPSHOT, fetcher: async () => {
      calls++;
      // This body deliberately contains synthetic private data. Never expose it.
      return new Response(`private body ${TOKEN} ${SNAPSHOT.text}`, { status, headers: urn ? { 'x-restli-id': urn } : {} });
    } });
    assert.equal(calls, 1);
    assert.equal(result.status, expected, `HTTP ${status}, id=${urn}`);
    if (status === 401) assert.equal(result.reason, 'reconnect_required');
    if (status === 429) assert.equal(result.reason, 'rate_limited');
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(JSON.stringify(result).includes(SNAPSHOT.text), false);
  }
  let calls = 0;
  const ambiguous = await publishLinkedInText(CONFIG, { accessToken: TOKEN, snapshot: SNAPSHOT, fetcher: async () => { calls++; throw new Error('Synthetic transport timeout'); } });
  assert.equal(calls, 1);
  assert.deepEqual(ambiguous, { status: 'unknown', postUrn: null, reason: 'provider_outcome_unknown' });
});
