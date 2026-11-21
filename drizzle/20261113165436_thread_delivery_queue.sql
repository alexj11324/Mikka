-- target: MIKKA_DATABASE_URL
-- Additive. Rollback: revert the clients/worker and retain the receipts.
CREATE TABLE IF NOT EXISTS thread_queued_messages (
  id uuid PRIMARY KEY,
  "requestId" uuid NOT NULL,
  "requestedRunId" uuid NOT NULL,
  "userId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "rootRunId" uuid NOT NULL,
  "runId" uuid NOT NULL,
  "claimRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  "claimMode" text CHECK ("claimMode" IN ('steer','afterRun')),
  "sentRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 10000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','delivering','sent','cancelled','failed')),
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "failureCode" text,
  FOREIGN KEY ("rootRunId","userId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE,
  UNIQUE ("userId", "requestId"),
  FOREIGN KEY ("requestedRunId","userId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE,
  FOREIGN KEY ("runId","userId") REFERENCES agent_runs(id,"userId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS thread_queued_messages_pending
  ON thread_queued_messages ("rootRunId","createdAt",id) WHERE status IN ('queued','delivering');
