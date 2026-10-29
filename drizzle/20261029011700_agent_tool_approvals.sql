-- One specific CLI request, never an agent or workspace-wide grant.
CREATE TABLE IF NOT EXISTS agent_tool_approvals (
  id uuid PRIMARY KEY,
  "runId" uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "deviceId" uuid NOT NULL,
  "requestId" text NOT NULL,
  harness text NOT NULL,
  method text NOT NULL,
  input jsonb NOT NULL,
  digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'cancelled', 'consumed')),
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "decidedAt" timestamptz,
  UNIQUE ("runId", "requestId")
);
CREATE INDEX IF NOT EXISTS agent_tool_approvals_owner_pending ON agent_tool_approvals ("userId", "createdAt") WHERE status = 'pending';
