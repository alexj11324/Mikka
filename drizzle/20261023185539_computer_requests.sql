-- target: DATABASE_URL
-- Additive workspace CUA policy and exact-operation approval ledger.
-- No credentials or screenshot bytes. Typed text is stored for exact review;
-- callers must not put passwords/tokens in computer_type.
-- Fresh small tables/index only; no rewrite or scan of existing app tables.
-- Rollback before use: DROP TABLE computer_requests; DROP TABLE agent_settings;
CREATE TABLE IF NOT EXISTS agent_settings (
  "workspaceId" uuid PRIMARY KEY REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(permissions) = 'object'),
  "updatedBy" text NOT NULL,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS computer_requests (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL REFERENCES mikka_workspaces(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "sessionId" uuid NOT NULL,
  target text NOT NULL,
  operation jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executing', 'complete', 'failed', 'denied')),
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS computer_requests_owner_session_idx ON computer_requests ("userId", "sessionId");
