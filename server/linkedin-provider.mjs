import { createHash, randomBytes, webcrypto, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.mjs';
import { deploymentConfiguration } from './deployment-config.mjs';

// Fixed official endpoints: never follow a URL supplied by a browser or token.
export const LINKEDIN = Object.freeze({
  issuer: 'https://www.linkedin.com/oauth',
  authorization: 'https://www.linkedin.com/oauth/v2/authorization',
  token: 'https://www.linkedin.com/oauth/v2/accessToken',
  jwks: 'https://www.linkedin.com/oauth/openid/jwks',
  userinfo: 'https://api.linkedin.com/v2/userinfo',
  posts: 'https://api.linkedin.com/rest/posts',
  scopes: 'openid profile w_member_social',
  version: '202610',
});
export const MAX_SCHEDULE_LATENESS_MS = 15 * 60_000;
export const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
export const randomSecret = () => randomBytes(32).toString('base64url');
export function equalDigest(a, b) {
  return /^[a-f0-9]{64}$/.test(a ?? '') && /^[a-f0-9]{64}$/.test(b ?? '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Single-owner launch runner. These are operator-controlled capabilities, never
// taken from browser fields, identity headers, job payloads or a Site access token.
export function linkedinRunnerConfiguration(env = {}) {
  const ownerId = env.LINKEDIN_RUNNER_OWNER_ID;
  const tokenHash = env.LINKEDIN_RUNNER_TOKEN_SHA256;
  const configured = typeof ownerId === 'string' && ownerId.trim() === ownerId && ownerId.length > 0 && ownerId.length <= 500
    && !/[\u0000-\u001f\u007f]/u.test(ownerId) && /^[a-f0-9]{64}$/.test(tokenHash ?? '');
  return Object.freeze({ configured, enabled: configured && env.LINKEDIN_RUNNER_ENABLED === 'true',
    ownerId: configured ? ownerId : null, tokenHash: configured ? tokenHash : null });
}

export function linkedinConfiguration(env = {}) {
  const deployment = deploymentConfiguration(env);
  const runner = linkedinRunnerConfiguration(env);
  // This must be a fresh key unique to this deployment, never copied from the
  // private app. Token AAD binds owner/purpose, not a project namespace; origin
  // checks do not replace separate D1/R2 resources or vault-key isolation.
  const key = env.LINKEDIN_TOKEN_KEY;
  const validKey = typeof key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32;
  const missing = [...deployment.missing];
  for (const name of ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']) if (typeof env[name] !== 'string' || !env[name].trim()) missing.push(name);
  if (!validKey) missing.push('LINKEDIN_TOKEN_KEY');
  return Object.freeze({
    origin: deployment.origin, redirectUri: deployment.callbackUrl,
    clientId: env.LINKEDIN_CLIENT_ID, clientSecret: env.LINKEDIN_CLIENT_SECRET, tokenKey: validKey ? key : null,
    configured: missing.length === 0, missing,
    oauthEnabled: env.LINKEDIN_OAUTH_ENABLED === 'true' && missing.length === 0,
    publishingEnabled: env.LINKEDIN_PUBLISHING_ENABLED === 'true' && missing.length === 0,
    // This flag is an operator attestation, not proof that a trigger exists.
    // Keep false until an actual supported recurring runner passes a live test.
    schedulerVerified: env.LINKEDIN_SCHEDULER_VERIFIED === 'true' && runner.enabled && missing.length === 0,
    schedulerOwnerId: runner.ownerId,
    // LinkedIn's confidential web flow does not currently advertise PKCE in
    // discovery. Enable only after support for this application is verified.
    pkceEnabled: env.LINKEDIN_PKCE_ENABLED === 'true',
    apiVersion: /^20\d{4}$/.test(env.LINKEDIN_API_VERSION ?? '') ? env.LINKEDIN_API_VERSION : LINKEDIN.version,
  });
}

export function publicReadiness(config, ownerId = null) {
  const schedulerVerified = config.schedulerVerified && config.schedulerOwnerId === ownerId;
  return { configured: config.configured, oauthEnabled: config.oauthEnabled, publishingEnabled: config.publishingEnabled,
    schedulerVerified, missing: [...config.missing], scopes: LINKEDIN.scopes.split(' '),
    callbackUrl: config.redirectUri, apiVersion: config.apiVersion,
    security: 'Server-side encrypted tokens. This is not end-to-end encryption.',
    scheduling: schedulerVerified ? 'A verified runner is enabled for your workspace. Delivery is best effort; posts more than 15 minutes late are cancelled.' : 'Automatic scheduling is unavailable until a supported recurring runner is configured and verified.' };
}

async function aesKey(key) {
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32) fail('TOKEN_KEY_UNAVAILABLE', 'The secure connection key is not configured.', 503);
  return webcrypto.subtle.importKey('raw', Buffer.from(key, 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function sealSecret(value, key, aad) {
  const iv = randomBytes(12);
  const encrypted = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(aad), tagLength: 128 }, await aesKey(key), Buffer.from(value));
  return `v1.${iv.toString('base64url')}.${Buffer.from(encrypted).toString('base64url')}`;
}
export async function openSecret(value, key, aad) {
  try {
    const parts = value.split('.');
    const [version, iv, payload] = parts;
    if (parts.length !== 3 || version !== 'v1' || !/^[A-Za-z0-9_-]{16}$/.test(iv ?? '') || !/^[A-Za-z0-9_-]+$/.test(payload ?? '') || Buffer.from(payload, 'base64url').toString('base64url') !== payload) throw new Error();
    return Buffer.from(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: Buffer.from(aad), tagLength: 128 }, await aesKey(key), Buffer.from(payload, 'base64url'))).toString('utf8');
  } catch { fail('CONNECTION_UNREADABLE', 'Reconnect LinkedIn before publishing.', 409); }
}

async function boundedJSON(response, limit = 65_536) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No body');
  const chunks = []; let length = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) { await reader.cancel(); throw new Error('Oversize'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
async function officialFetch(fetcher, endpoint, options = {}) {
  return fetcher(endpoint, { ...options, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000) });
}

export function authorizationURL(config, { state, nonce, verifier }) {
  if (!config.oauthEnabled) fail('LINKEDIN_SETUP_REQUIRED', 'LinkedIn connection setup has not been enabled.', 503);
  const url = new URL(LINKEDIN.authorization);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
    scope: LINKEDIN.scopes, state, nonce }).toString();
  if (config.pkceEnabled) {
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

export async function verifyLinkedInIDToken(token, { clientId, nonceHash, now = Date.now(), fetcher = fetch } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 20_000) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 || header.crit) throw new Error();
    const response = await officialFetch(fetcher, LINKEDIN.jwks);
    if (!response.ok) throw new Error();
    const jwks = await boundedJSON(response);
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 50) throw new Error();
    const matches = jwks.keys.filter((key) => key.kid === header.kid && key.kty === 'RSA' && (!key.alg || key.alg === 'RS256') && (!key.use || key.use === 'sig'));
    if (matches.length !== 1) throw new Error();
    const key = await webcrypto.subtle.importKey('jwk', matches[0], { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await webcrypto.subtle.verify('RSASSA-PKCS1-v1_5', key, Buffer.from(parts[2], 'base64url'), Buffer.from(`${parts[0]}.${parts[1]}`))) throw new Error();
    const seconds = Math.floor(now / 1000);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== LINKEDIN.issuer || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) throw new Error();
    if (!Number.isSafeInteger(claims.exp) || !Number.isSafeInteger(claims.iat) || claims.exp <= seconds || claims.iat > seconds + 60 || claims.iat < seconds - 600 || claims.exp <= claims.iat) throw new Error();
    if (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > seconds + 60)) throw new Error();
    if (typeof claims.nonce !== 'string' || !equalDigest(sha256(claims.nonce), nonceHash)) throw new Error();
    if (typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(claims.sub)) throw new Error();
    return { subject: claims.sub };
  } catch { fail('LINKEDIN_IDENTITY_INVALID', 'LinkedIn sign-in could not be verified. Please reconnect.', 401); }
}

export async function exchangeLinkedInCode(config, { code, nonceHash, verifier, now = Date.now(), fetcher = fetch }) {
  if (!config.oauthEnabled || !config.configured) fail('LINKEDIN_SETUP_REQUIRED', 'LinkedIn connection setup is disabled.', 503);
  if (typeof code !== 'string' || !code || code.length > 4096) fail('OAUTH_CODE_INVALID', 'Restart the LinkedIn connection.', 400);
  try {
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri, client_id: config.clientId, client_secret: config.clientSecret });
    if (config.pkceEnabled) body.set('code_verifier', verifier);
    const response = await officialFetch(fetcher, LINKEDIN.token, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!response.ok) fail('OAUTH_EXCHANGE_FAILED', 'LinkedIn did not complete the connection. Reconnect rather than retrying the callback.', 409);
    const token = await boundedJSON(response);
    if (typeof token.access_token !== 'string' || token.access_token.length < 10 || token.access_token.length > 16_000 || !Number.isSafeInteger(token.expires_in) || token.expires_in <= 60 || token.expires_in > 366 * 86400 || (token.token_type && token.token_type.toLowerCase() !== 'bearer')) throw new Error();
    const scopes = typeof token.scope === 'string' ? decodeURIComponent(token.scope.replace(/\+/g, ' ')).split(/[ ,]+/).filter(Boolean) : [];
    if (!LINKEDIN.scopes.split(' ').every((scope) => scopes.includes(scope))) fail('LINKEDIN_SCOPE_MISSING', 'LinkedIn did not grant the required sign-in and posting permissions.', 409);
    if (scopes.some((scope) => !LINKEDIN.scopes.split(' ').includes(scope))) fail('LINKEDIN_SCOPE_UNEXPECTED', 'LinkedIn returned broader permissions than requested. The connection was not saved.', 409);
    const identity = await verifyLinkedInIDToken(token.id_token, { clientId: config.clientId, nonceHash, now, fetcher });
    const profileResponse = await officialFetch(fetcher, LINKEDIN.userinfo, { headers: { authorization: `Bearer ${token.access_token}` } });
    if (!profileResponse.ok) throw new Error();
    const profile = await boundedJSON(profileResponse);
    if (profile.sub !== identity.subject || typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 300) throw new Error();
    // No email/picture, creator data, password, or refresh token is retained.
    return { subject: identity.subject, personUrn: `urn:li:person:${identity.subject}`, displayName: profile.name,
      accessToken: token.access_token, expiresAt: now + token.expires_in * 1000, scopes: LINKEDIN.scopes };
  } catch (error) {
    if (['OAUTH_EXCHANGE_FAILED', 'LINKEDIN_IDENTITY_INVALID', 'LINKEDIN_SCOPE_MISSING', 'LINKEDIN_SCOPE_UNEXPECTED'].includes(error.code)) throw error;
    fail('OAUTH_EXCHANGE_FAILED', 'LinkedIn connection could not be completed safely. Start a new connection attempt.', 409);
  }
}

// LinkedIn's little-text wire grammar requires escaping reserved characters.
// This changes transport encoding, not the approved Unicode text/semantics.
export const linkedinCommentary = (text) => text.replace(/[|{}@\[\]()<>#\\*_~]/g, '\\$&');
export async function publishLinkedInText(config, { accessToken, snapshot, fetcher = fetch }) {
  if (!config.publishingEnabled) fail('PUBLISHING_DISABLED', 'Live LinkedIn publishing is not enabled.', 503);
  if (!snapshot || !/^urn:li:person:[A-Za-z0-9_-]{1,200}$/.test(snapshot.author) || typeof snapshot.text !== 'string' || !snapshot.text.trim() || snapshot.text.length > 3000 || !['PUBLIC', 'CONNECTIONS'].includes(snapshot.visibility)) fail('INVALID_PUBLICATION', 'This publication is invalid.', 400);
  const body = { author: snapshot.author, commentary: linkedinCommentary(snapshot.text), visibility: snapshot.visibility,
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
  try {
    const response = await officialFetch(fetcher, LINKEDIN.posts, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'LinkedIn-Version': config.apiVersion, 'X-Restli-Protocol-Version': '2.0.0' }, body: JSON.stringify(body) });
    const urn = response.headers.get('x-restli-id');
    // Do not parse or log provider error bodies: they can contain private text.
    if (response.status === 201 && /^urn:li:(share|ugcPost):\d+$/.test(urn ?? '')) return { status: 'published', postUrn: urn, reason: null };
    if ([400, 401, 403, 404, 410, 422, 429].includes(response.status)) return { status: 'rejected', postUrn: null, reason: response.status === 401 ? 'reconnect_required' : response.status === 429 ? 'rate_limited' : 'provider_rejected' };
    return { status: 'unknown', postUrn: null, reason: 'provider_outcome_unknown' };
  } catch { return { status: 'unknown', postUrn: null, reason: 'provider_outcome_unknown' }; }
}
