-- Application database. Short-lived review metadata only, never screenshots, tokens or results.
-- New table; no rewrite/backfill/long data lock on existing tables. Drop this table to roll back before use.
CREATE TABLE IF NOT EXISTS local_computer_reviews (
  id uuid PRIMARY KEY,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  target text NOT NULL,
  call jsonb NOT NULL,
  digest text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "seenAt" timestamptz NOT NULL,
  decision boolean
);
CREATE INDEX IF NOT EXISTS local_computer_reviews_owner_idx ON local_computer_reviews ("userId", "expiresAt");
