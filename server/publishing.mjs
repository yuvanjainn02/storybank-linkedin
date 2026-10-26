import { fail } from './errors.mjs';

/** No fetch, credential, OAuth, or provider SDK is present in this adapter. */
export const publishingAdapter = Object.freeze({
  status: 'disabled',
  canPublish: false,
  publish() {
    fail('INTEGRATION_DISABLED', 'Live publishing is not implemented. No post was sent.', 503);
  },
});

export const oauthIntegration = Object.freeze({
  status: 'disabled',
  beginAuthorization() {
    fail('OAUTH_DISABLED', 'Account connections are not implemented. No credentials are collected.', 503);
  },
  completeAuthorization() {
    fail('OAUTH_DISABLED', 'OAuth callbacks are not accepted in this foundation.', 503);
  },
});
