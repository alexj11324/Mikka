-- A browser subagent may use only a separately claimed, owner-bound computer run.
CREATE TABLE IF NOT EXISTS subagent_run_bindings (
  "subagentId" uuid PRIMARY KEY REFERENCES bot_subagents(id) ON DELETE CASCADE,
  "runId" uuid NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "botId" uuid NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE CASCADE
);
