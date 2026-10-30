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
  "nextCheckAt" timestamptz NOT NULL DEFAULT now(),
  "expiresAt" timestamptz NOT NULL,
  "lastError" text,
  "watchId" uuid NOT NULL DEFAULT gen_random_uuid(),
  generation bigint NOT NULL DEFAULT 0,
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
-- The only resume dedupe and the only cap: one row per automatic resume, keyed
-- by (task, PR, head SHA), so a head resumes a session at most once; the
-- per-task rolling-24h cap counts these rows. A follow-up retired before any
-- claim deletes its row. Survives observation deletion so a reset watch cannot
-- reset the cap.
CREATE TABLE IF NOT EXISTS github_ci_resumes (
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "issueId" uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  "remoteKey" text NOT NULL,
  "prNumber" integer NOT NULL CHECK ("prNumber" > 0),
  head text NOT NULL,
  "runId" uuid,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("userId","issueId","remoteKey","prNumber",head)
);
CREATE INDEX IF NOT EXISTS github_ci_resumes_task_idx ON github_ci_resumes ("userId","issueId","createdAt");
CREATE INDEX IF NOT EXISTS github_ci_resumes_run_idx ON github_ci_resumes ("runId");
