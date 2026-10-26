import { fail } from './errors.mjs';

const ROLES = new Set(['owner', 'editor', 'viewer']);

/**
 * Infrastructure boundary, not an OIDC implementation.
 * resolveSession must verify an opaque, server-side session and return its
 * authoritative current memberships. Never construct this from request JSON.
 * Memberships are re-read for every repository operation, including job runs.
 */
export function createContextAuthority({ resolveSession }) {
  if (typeof resolveSession !== 'function') throw new TypeError('A trusted session resolver is required.');
  const sessions = new WeakMap();

  function principalFor(session, tenantId) {
    const principal = resolveSession(session);
    if (!principal || typeof principal.then === 'function' || typeof principal.subject !== 'string' || !principal.subject.trim() || !Array.isArray(principal.memberships)) {
      fail('UNAUTHENTICATED', 'A current verified session is required.', 401);
    }
    const membership = principal.memberships.find((item) => item && item.tenantId === tenantId && ROLES.has(item.role));
    if (!membership) fail('FORBIDDEN', 'Access to this workspace is not permitted.', 403);
    return { tenantId, userId: principal.subject, role: membership.role };
  }

  return Object.freeze({
    authenticate(session, tenantId, { readOnly = false } = {}) {
      if (typeof readOnly !== 'boolean') throw new TypeError('readOnly must be a boolean.');
      if (typeof tenantId !== 'string' || !tenantId.trim()) fail('INVALID_TENANT', 'A workspace is required.');
      const identity = principalFor(session, tenantId);
      const context = Object.freeze(identity);
      sessions.set(context, { session, tenantId, userId: identity.userId, readOnly });
      return context;
    },
    require(context, permission = 'read') {
      const binding = context && sessions.get(context);
      if (!binding) fail('UNAUTHENTICATED', 'Use a verified server context, not client-provided identity.', 401);
      if (binding.readOnly && permission !== 'read') fail('READ_ONLY_REQUEST', 'Use a verified mutation request for changes.', 403);
      const current = principalFor(binding.session, binding.tenantId);
      if (current.userId !== binding.userId) fail('UNAUTHENTICATED', 'The session identity changed.', 401);
      if (permission === 'write' && current.role === 'viewer') fail('FORBIDDEN', 'This operation requires an editor.', 403);
      if (permission === 'owner' && current.role !== 'owner') fail('FORBIDDEN', 'This operation requires a workspace owner.', 403);
      if (!['read', 'write', 'owner'].includes(permission)) throw new TypeError('Unknown authorization permission.');
      return Object.freeze(current);
    },
  });
}

/** This scaffold deliberately has no sign-in or OAuth callback endpoint. */
export const disabledIdentityProvider = Object.freeze({
  status: 'disabled',
  authenticate() {
    fail('AUTH_NOT_CONFIGURED', 'Sign-in is not connected in this foundation.', 503);
  },
});
