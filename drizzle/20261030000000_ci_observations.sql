-- target: MIKKA_DATABASE_URL
-- One current observation per task-bound pull request. A durable row is required
-- before acknowledging webhook work; no installation token is stored here.
CREATE TABLE IF NOT EXISTS github_ci_observations (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "remoteKey" text NOT NULL,
  "prNumber" integer NOT NULL CHECK ("prNumber" > 0),
  "originRunId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "scopeVersion" integer NOT NULL,
  head text,
  fingerprint text,
  "firstSeenAt" timestamptz,
  "deliveredFingerprint" text,
  "nextCheckAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "lastError" text,
  "watchId" uuid NOT NULL DEFAULT gen_random_uuid(),
  generation bigint NOT NULL DEFAULT 0,
  "chainDepth" integer NOT NULL DEFAULT 0 CHECK ("chainDepth" >= 0),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId", "issueId", "remoteKey", "prNumber")
);
CREATE INDEX IF NOT EXISTS github_ci_observations_due_idx ON github_ci_observations ("nextCheckAt");
-- Highest observed attempt and monotonic state for each workflow run on the
-- bound PR. No delivery GUIDs or provider content need be retained.
CREATE TABLE IF NOT EXISTS github_ci_workflow_attempts (
  "userId" text NOT NULL,
  "issueId" uuid NOT NULL,
  "remoteKey" text NOT NULL,
  "prNumber" integer NOT NULL,
  "runId" text NOT NULL,
  head text NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  state text NOT NULL CHECK (state IN ('requested','in_progress','completed')),
  PRIMARY KEY ("userId","issueId","remoteKey","prNumber","runId"),
  FOREIGN KEY ("userId","issueId","remoteKey","prNumber") REFERENCES github_ci_observations ("userId","issueId","remoteKey","prNumber") ON DELETE CASCADE
);
