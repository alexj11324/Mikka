-- Reuse #161's short-lived approval ledger; snapshots contain no screenshot,
-- credentials or model result. The optional display is part of the digest.
CREATE TABLE IF NOT EXISTS local_computer_reviews (
  id uuid PRIMARY KEY,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  target text NOT NULL,
  display text,
  call jsonb NOT NULL,
  digest text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "seenAt" timestamptz NOT NULL,
  decision boolean
);
CREATE INDEX IF NOT EXISTS local_computer_reviews_owner_idx ON local_computer_reviews ("userId", "expiresAt");
