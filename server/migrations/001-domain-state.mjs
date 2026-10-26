/** Versioned local aggregate storage. Owner authorization remains in the domain repository. */
export default Object.freeze({
  version: 1,
  name: 'domain-state',
  sql: `
    CREATE TABLE repository_records (
      collection TEXT NOT NULL CHECK (collection IN ('stories','approvals','jobs','idempotency','approvalJobs','integrations','profiles','calibrations','profileProposals')),
      record_key TEXT NOT NULL,
      payload TEXT NOT NULL CHECK (json_valid(payload)),
      PRIMARY KEY (collection, record_key)
    ) STRICT;
    CREATE TABLE audit_events (
      sequence INTEGER PRIMARY KEY,
      payload TEXT NOT NULL CHECK (json_valid(payload))
    ) STRICT;
  `,
});
