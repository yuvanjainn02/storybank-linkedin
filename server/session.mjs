import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createContextAuthority } from './context.mjs';
import { fail } from './errors.mjs';

export const SESSION_COOKIE = '__Host-storybank_session';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
const digest = (token) => createHash('sha256').update(token).digest('hex');
const sameDigest = (a, b) => DIGEST_PATTERN.test(a ?? '') && DIGEST_PATTERN.test(b ?? '') && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

function header(headers, wanted) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) fail('INVALID_REQUEST', 'Request headers are required.');
  const entries = Object.entries(headers).filter(([name]) => name.toLowerCase() === wanted);
  if (entries.length > 1 || (entries.length && typeof entries[0][1] !== 'string')) fail('INVALID_REQUEST', 'Ambiguous request headers are not accepted.');
  return entries[0]?.[1];
}

function tokenFromCookie(headers) {
  const cookie = header(headers, 'cookie');
  if (typeof cookie !== 'string' || cookie.length > 8192) fail('UNAUTHENTICATED', 'Sign in to continue.', 401);
  const matches = cookie.split(';').map((part) => part.trim()).filter((part) => part.split('=', 1)[0] === SESSION_COOKIE);
  if (matches.length !== 1) fail('UNAUTHENTICATED', 'A single current session is required.', 401);
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  if (!TOKEN_PATTERN.test(token)) fail('UNAUTHENTICATED', 'Sign in to continue.', 401);
  return token;
}

function validateRecord(value, tokenDigest, now) {
  if (!value || value.tokenDigest !== tokenDigest || !DIGEST_PATTERN.test(value.csrfDigest ?? '') ||
      typeof value.subject !== 'string' || !value.subject.trim() || value.subject.length > 200 ||
      !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt) || !Number.isSafeInteger(value.authTime) ||
      value.createdAt > now || value.authTime > now || value.authTime > value.createdAt || value.expiresAt <= now ||
      value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > MAX_AGE_MS) return null;
  return value;
}

function unavailableIdentity() {
  fail('AUTH_NOT_CONFIGURED', 'Sign-in is not configured. No session was created.', 503);
}

/**
 * Infrastructure composition only. verifyIdentity MUST be an audited OIDC
 * adapter that verifies signature, issuer, audience, nonce, state, PKCE and
 * expiry before returning an INTERNAL subject. A request body is never that
 * adapter. The default rejects all sign-ins. This module does not implement
 * OIDC or store provider credentials, and has no network listener.
 *
 * sessionStore persists only token/CSRF digests, never their raw values.
 * resolveMemberships is authoritative and is re-read on every domain operation.
 */
export function createSessionBoundary({ sessionStore, resolveMemberships, verifyIdentity = unavailableIdentity,
  origin, clock = Date.now, ttlMs = MAX_AGE_MS } = {}) {
  for (const method of ['getByDigest', 'put', 'deleteByDigest', 'deleteForUser']) {
    if (typeof sessionStore?.[method] !== 'function') throw new TypeError(`A trusted sessionStore.${method} is required.`);
  }
  if (typeof resolveMemberships !== 'function' || typeof verifyIdentity !== 'function') throw new TypeError('Trusted identity and membership adapters are required.');
  let parsed;
  try { parsed = new URL(origin); } catch { throw new TypeError('An exact HTTPS origin is required.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) throw new TypeError('An exact HTTPS origin, without path or credentials, is required.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > MAX_AGE_MS) throw new TypeError('Session lifetime must be 1 minute to 8 hours.');
  const now = () => {
    const value = clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Clock must return Unix milliseconds.');
    return value;
  };
  const recordForToken = (token) => {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const tokenDigest = digest(token);
    const record = sessionStore.getByDigest(tokenDigest);
    if (record?.then) throw new TypeError('The session store contract is synchronous.');
    return validateRecord(record, tokenDigest, now());
  };
  const authority = createContextAuthority({ resolveSession(token) {
    const record = recordForToken(token);
    if (!record) return null;
    const memberships = resolveMemberships(record.subject);
    if (!Array.isArray(memberships)) return null;
    return { subject: record.subject, memberships };
  } });
  const cookie = (token, maxAge) => `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  function requestToken(request) {
    if (!request || typeof request !== 'object') fail('INVALID_REQUEST', 'A request is required.');
    const method = request.method;
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) fail('METHOD_NOT_ALLOWED', 'This request method is not supported.', 405);
    const fetchSite = header(request.headers, 'sec-fetch-site');
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) fail('ORIGIN_REJECTED', 'Use the StoryBank application to make this request.', 403);
    const token = tokenFromCookie(request.headers);
    const record = recordForToken(token);
    if (!record) fail('UNAUTHENTICATED', 'Your session has ended. Sign in again.', 401);
    if (!['GET', 'HEAD'].includes(method)) {
      if (header(request.headers, 'origin') !== origin) fail('ORIGIN_REJECTED', 'The request origin is not allowed.', 403);
      const csrf = header(request.headers, 'x-csrf-token');
      if (typeof csrf !== 'string' || !TOKEN_PATTERN.test(csrf) || !sameDigest(digest(csrf), record.csrfDigest)) fail('CSRF_REJECTED', 'Refresh this page before making changes.', 403);
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(request.headers, 'content-type') ?? '')) fail('CONTENT_TYPE_REJECTED', 'Send a JSON request.', 415);
    }
    return token;
  }

  return Object.freeze({
    authority,
    status: verifyIdentity === unavailableIdentity ? 'sign_in_disabled' : 'trusted_adapter_supplied',
    async establish(providerEvidence, { previousToken } = {}) {
      // No identity claims are read from providerEvidence here. Verification
      // happens entirely inside the explicitly supplied trusted adapter.
      const identity = await verifyIdentity(providerEvidence);
      const at = now();
      if (!identity || typeof identity.subject !== 'string' || !identity.subject.trim() || identity.subject.length > 200 ||
          !Number.isSafeInteger(identity.authTime) || identity.authTime > at || identity.authTime < at - 5 * 60_000) {
        fail('UNAUTHENTICATED', 'Fresh verified identity is required.', 401);
      }
      const memberships = resolveMemberships(identity.subject);
      if (!Array.isArray(memberships) || !memberships.some((m) => m && typeof m.tenantId === 'string' && m.tenantId.trim() && ['owner', 'editor', 'viewer'].includes(m.role))) fail('FORBIDDEN', 'No active workspace membership exists.', 403);
      // Rotate rather than adopting any incoming/browser-supplied token.
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      if (typeof previousToken === 'string' && TOKEN_PATTERN.test(previousToken)) sessionStore.deleteByDigest(digest(previousToken));
      sessionStore.put({ tokenDigest: digest(token), csrfDigest: digest(csrfToken), subject: identity.subject, createdAt: at, expiresAt: at + ttlMs, authTime: identity.authTime });
      return Object.freeze({ setCookie: cookie(token, Math.floor(ttlMs / 1000)), csrfToken, expiresAt: at + ttlMs });
    },
    contextForRequest(request, selectedTenantId) {
      // selectedTenantId is only a selector; authority checks current server membership.
      return authority.authenticate(requestToken(request), selectedTenantId, { readOnly: ['GET', 'HEAD'].includes(request.method) });
    },
    signOut(request) {
      if (request?.method !== 'POST') fail('METHOD_NOT_ALLOWED', 'Sign out with a POST request.', 405);
      const token = requestToken(request);
      sessionStore.deleteByDigest(digest(token));
      return { setCookie: cookie('', 0), signedOut: true };
    },
    revokeOwnSessions(request, selectedTenantId) {
      if (request?.method !== 'POST') fail('METHOD_NOT_ALLOWED', 'Revoke sessions with a POST request.', 405);
      const context = authority.authenticate(requestToken(request), selectedTenantId);
      const identity = authority.require(context);
      sessionStore.deleteForUser(identity.userId);
      return { revoked: true };
    },
  });
}
