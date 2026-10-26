/** Session credentials are never stored; only one-way digests enter this table. */
export default Object.freeze({
  version: 2,
  name: 'session-digests',
  sql: `
    CREATE TABLE sessions (
      token_digest TEXT PRIMARY KEY NOT NULL CHECK (length(token_digest) = 64 AND token_digest NOT GLOB '*[^0-9a-f]*'),
      csrf_digest TEXT NOT NULL CHECK (length(csrf_digest) = 64 AND csrf_digest NOT GLOB '*[^0-9a-f]*'),
      subject TEXT NOT NULL CHECK (length(subject) > 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
      auth_time INTEGER NOT NULL CHECK (auth_time <= created_at)
    ) STRICT;
    CREATE INDEX sessions_subject ON sessions (subject);
    CREATE INDEX sessions_expiry ON sessions (expires_at);
  `,
});
