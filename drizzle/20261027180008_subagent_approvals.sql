-- A web subagent is not an agent run, so its exact-action approvals need
-- their own owner-scoped ledger. An executing action is never replayed after
-- an uncertain response.
CREATE TABLE IF NOT EXISTS bot_subagent_approvals (
  id uuid PRIMARY KEY,
  "subagentId" uuid NOT NULL REFERENCES bot_subagents(id) ON DELETE RESTRICT,
  "workspaceId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "botId" uuid NOT NULL,
  "operationKey" text NOT NULL,
  digest text NOT NULL,
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','denied','executing','completed','uncertain')),
  result jsonb,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "decidedAt" timestamptz,
  UNIQUE ("subagentId", "operationKey"),
  FOREIGN KEY ("botId", "workspaceId", "ownerId") REFERENCES bots(id, "workspaceId", "ownerId") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS bot_subagent_approvals_pending_idx ON bot_subagent_approvals("subagentId", state, "expiresAt");
