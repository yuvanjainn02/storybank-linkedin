declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    STORYBANK_SITE_ORIGIN?: string;
    LINKEDIN_CLIENT_ID?: string;
    LINKEDIN_CLIENT_SECRET?: string;
    LINKEDIN_TOKEN_KEY?: string;
    LINKEDIN_OAUTH_ENABLED?: string;
    LINKEDIN_PUBLISHING_ENABLED?: string;
    LINKEDIN_SCHEDULER_VERIFIED?: string;
    LINKEDIN_RUNNER_ENABLED?: string;
    LINKEDIN_RUNNER_OWNER_ID?: string;
    LINKEDIN_RUNNER_TOKEN_SHA256?: string;
    LINKEDIN_PKCE_ENABLED?: string;
    LINKEDIN_API_VERSION?: string;
  }
}
