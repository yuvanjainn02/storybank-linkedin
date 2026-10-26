// Synthetic explicit server configuration. Never a production fallback.
export const TEST_SITE_ORIGIN = 'https://tester.storybank.example';
export const TEST_DEPLOYMENT_ENV = Object.freeze({ STORYBANK_SITE_ORIGIN: TEST_SITE_ORIGIN });
