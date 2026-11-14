-- target: MIKKA_DATABASE_URL
-- Additive, replayable. Revert the writers and retain the immutable versions.
CREATE TABLE IF NOT EXISTS thread_reply_versions (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "rootRunId" uuid NOT NULL,
  "anchorRunId" uuid NOT NULL,
  "admissionRunId" uuid NOT NULL,
  "anchorKey" text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('edit','rerun')),
  "originalText" text NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 10000),
  "executionNote" text NOT NULL CHECK (length("executionNote") BETWEEN 1 AND 10000),
  "sourceEventId" uuid NOT NULL UNIQUE,
  "resultRunId" uuid UNIQUE REFERENCES agent_runs(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY ("rootRunId","userId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE,
  FOREIGN KEY ("anchorRunId","userId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE,
  FOREIGN KEY ("admissionRunId","userId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS thread_reply_versions_anchor ON thread_reply_versions ("userId","workspaceId","rootRunId","anchorRunId","anchorKey","createdAt");
