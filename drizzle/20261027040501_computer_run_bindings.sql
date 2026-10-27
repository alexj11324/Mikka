-- A computer task belongs to both its run owner and its Bot owner. Keeping the
-- binding separate leaves existing non-computer runs unchanged.
CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_id_owner_key ON agent_runs (id, "userId");
CREATE TABLE IF NOT EXISTS computer_run_bindings (
  "runId" uuid PRIMARY KEY,
  "botId" uuid NOT NULL,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("runId", "ownerId") REFERENCES agent_runs (id, "userId") ON DELETE CASCADE,
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots (id, "workspaceId", "ownerId") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS computer_run_bindings_bot_idx ON computer_run_bindings ("botId", "createdAt");
