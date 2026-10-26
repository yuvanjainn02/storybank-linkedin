import { fail } from './errors.mjs';

export const LINKEDIN_CALLBACK_PATH = '/api/linkedin/callback';

// Runtime configuration is supplied only by trusted server adapters. Never
// infer a deployment from Host, Origin, forwarding headers, or browser input.
// Exact matching intentionally rejects values that URL would normalize.
export function deploymentConfiguration(env = {}) {
  const value = env?.STORYBANK_SITE_ORIGIN;
  let origin = null;
  if (typeof value === 'string' && value.length <= 2048 && !/[\s\\]/u.test(value)) {
    try {
      const url = new URL(value);
      const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost')
        || /^127\./.test(url.hostname) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(url.hostname)
        || ['[::1]', '[::]', '0.0.0.0'].includes(url.hostname);
      if (url.protocol === 'https:' && url.origin === value && !url.hostname.endsWith('.') && url.pathname === '/'
        && !url.search && !url.hash && !url.username && !url.password && !local) origin = value;
    } catch { /* Missing or malformed configuration stays disabled. */ }
  }
  return Object.freeze({ origin, configured: origin !== null,
    missing: Object.freeze(origin === null ? ['STORYBANK_SITE_ORIGIN'] : []),
    callbackUrl: origin === null ? null : `${origin}${LINKEDIN_CALLBACK_PATH}` });
}

/** Explicit server-owned DEV exception, never an OAuth origin configuration. */
export function verifyDeploymentRequest(request, { env = {}, allowLocalDevelopment = false } = {}) {
  const url = new URL(request.url);
  if (allowLocalDevelopment === true && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin;
  const { origin } = deploymentConfiguration(env);
  if (!origin) fail('DEPLOYMENT_NOT_CONFIGURED', 'This StoryBank deployment is not configured yet.', 503);
  if (url.origin !== origin) fail('ORIGIN_REJECTED', 'This request must use the configured StoryBank site.', 403);
  return origin;
}
