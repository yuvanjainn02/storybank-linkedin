import { fail } from './errors.mjs';
import { hostedContext, jsonResponse, readBoundedBody, safeError, verifyMutationRequest } from './hosted-http.mjs';
import { personalWorkspaceId } from './hosted-d1.mjs';
import { authorizationURL, exchangeLinkedInCode, linkedinConfiguration, openSecret, publicReadiness, randomSecret, sealSecret, sha256 } from './linkedin-provider.mjs';
import { createLinkedInStore } from './linkedin-store.mjs';
import { verifyDeploymentRequest } from './deployment-config.mjs';

const COOKIE = '__Host-storybank-linkedin';
const RESPONSE_HEADERS = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' };
const cookie = (value, maxAge = 600) => `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
async function json(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')) fail('CONTENT_TYPE_REJECTED', 'Send JSON.', 415);
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 16_384)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) { if (error.code) throw error; fail('INVALID_JSON', 'Send a valid JSON object.', 400); }
}
function ownKeys(value, allowed) { if (Object.keys(value).some((key) => !allowed.includes(key))) fail('INVALID_COMMAND', 'Unsupported request fields.', 400); }

/** Only the platform's server-side getChatGPTUser supplies user. No body or
 * browser-selected identity can associate a provider grant with a workspace.
 * @param {Request} request
 * @param {{user?: any, db?: any, env?: any, fetcher?: typeof fetch, clock?: () => number, allowLocalDevelopment?: boolean}} options
 */
export async function handleLinkedInRequest(request, { user, db, env = {}, fetcher = fetch, clock = () => Date.now(), allowLocalDevelopment = false } = {}) {
  const config = linkedinConfiguration(env);
  const path = new URL(request.url).pathname;
  try {
    hostedContext(user);
    verifyDeploymentRequest(request, { env, allowLocalDevelopment });
    const store = createLinkedInStore({ db, config, fetcher, clock });
    if (path === '/api/linkedin/status' && request.method === 'GET') return jsonResponse({ readiness: publicReadiness(config, user.userId), serverTime: new Date(clock()).toISOString(), ...await store.status(user) });
    if (path === '/api/linkedin/callback' && request.method === 'GET') {
      if (!config.oauthEnabled) fail('LINKEDIN_SETUP_REQUIRED', 'LinkedIn connection setup is disabled.', 503);
      const url = new URL(request.url);
      if (url.origin !== config.origin) fail('ORIGIN_REJECTED', 'The connection callback origin is invalid.', 403);
      for (const field of ['state', 'code', 'error']) if (url.searchParams.getAll(field).length > 1) fail('OAUTH_STATE_INVALID', 'Restart the connection.', 403);
      const state = url.searchParams.get('state');
      const cookies = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${COOKIE}=`));
      const browser = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : null;
      if (!/^[A-Za-z0-9_-]{43}$/.test(state ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(browser ?? '')) fail('OAUTH_STATE_INVALID', 'Restart LinkedIn connection from this browser.', 403);
      const attempt = await store.consumeOAuthAttempt(user, { stateHash: sha256(state), cookieHash: sha256(browser) });
      if (url.searchParams.has('error')) fail('OAUTH_DECLINED', 'LinkedIn connection was not approved. No connection was saved.', 409);
      const verifier = await openSecret(attempt.verifier_ciphertext, config.tokenKey, `linkedin:oauth:${user.userId}:${attempt.state_hash}`);
      const connection = await exchangeLinkedInCode(config, { code: url.searchParams.get('code'), nonceHash: attempt.nonce_hash, verifier, now: clock(), fetcher });
      await store.saveConnection(user, connection, { stateHash: attempt.state_hash });
      // Let the short-lived cookie expire instead of clearing a newer tab's
      // connection cookie with this older callback's response.
      return new Response(null, { status: 303, headers: { ...RESPONSE_HEADERS, location: `${config.origin}/publishing?linkedin=connected` } });
    }
    if (request.method !== 'POST' || !['connect', 'disconnect', 'preview', 'publish', 'cancel'].some((suffix) => path === `/api/linkedin/${suffix}`)) fail('NOT_FOUND', 'This endpoint does not exist.', 404);
    verifyMutationRequest(request, { env, allowLocalDevelopment });
    if (request.headers.get('x-storybank-workspace') !== personalWorkspaceId(user.userId)) fail('WORKSPACE_CHANGED', 'Your account changed. Refresh before continuing.', 409);
    const body = await json(request);
    if (path.endsWith('/connect')) {
      // DEV permits local workspace work, not a localhost OAuth launch that
      // would return to a different, registered deployment and cookie jar.
      if (new URL(request.url).origin !== config.origin) fail('LINKEDIN_SETUP_REQUIRED', 'Connect LinkedIn only from its configured HTTPS StoryBank site.', 503);
      ownKeys(body, ['confirmation']);
      if (body.confirmation !== 'CONNECT_LINKEDIN_FOR_SIGN_IN_AND_POSTING') fail('CONFIRMATION_REQUIRED', 'Confirm LinkedIn sign-in and posting access.', 409);
      const state = randomSecret(); const browser = randomSecret(); const nonce = randomSecret(); const verifier = randomSecret();
      const authorizationUrl = authorizationURL(config, { state, nonce, verifier });
      const stateHash = sha256(state);
      const verifierCiphertext = await sealSecret(verifier, config.tokenKey, `linkedin:oauth:${user.userId}:${stateHash}`);
      await store.storeOAuthAttempt(user, { stateHash, cookieHash: sha256(browser), nonceHash: sha256(nonce), verifierCiphertext });
      return new Response(JSON.stringify({ authorizationUrl }), { status: 200, headers: { ...RESPONSE_HEADERS, 'content-type': 'application/json', 'set-cookie': cookie(browser) } });
    }
    if (path.endsWith('/disconnect')) { ownKeys(body, ['confirmation']); if (body.confirmation !== 'DISCONNECT_LINKEDIN') fail('CONFIRMATION_REQUIRED', 'Confirm disconnecting LinkedIn.', 409); return jsonResponse(await store.disconnect(user)); }
    if (path.endsWith('/preview')) return jsonResponse(await store.preview(user, body));
    if (path.endsWith('/cancel')) { ownKeys(body, ['jobId']); return jsonResponse({ job: await store.cancel(user, body.jobId) }); }
    const job = await store.enqueue(user, body);
    // Only an explicit approved 'now' request dispatches from this HTTP route.
    // Scheduled jobs require a separately verified server-side runner.
    return jsonResponse({ job: job.snapshot.mode === 'now' && job.status === 'queued' ? await store.dispatch(user, job.id) : job });
  } catch (error) {
    const response = safeError(error);
    return response;
  }
}
