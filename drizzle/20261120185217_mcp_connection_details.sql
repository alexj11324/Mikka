-- target: MIKKA_DATABASE_URL

-- Additive and replayable. Roll back application code; keep these columns/tables
-- until a separately reviewed cleanup migration. Never discard saved credentials.
ALTER TABLE personal_mcp_servers
  ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'needs_connect'
    CHECK (connection_status IN ('connected','needs_connect','check_failed')),
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS check_failure text,
  ADD COLUMN IF NOT EXISTS oauth_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS mcp_server_tools (
  server_id uuid NOT NULL REFERENCES personal_mcp_servers(id) ON DELETE CASCADE,
  tool_name text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 128),
  enabled boolean NOT NULL DEFAULT true,
  description text NOT NULL DEFAULT '',
  available boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(server_id,tool_name)
);

-- Environments live in DATABASE_URL. Membership and environment ownership are
-- checked in that owning database; this is only the connection's explicit scope.
CREATE TABLE IF NOT EXISTS mcp_server_environments (
  server_id uuid NOT NULL REFERENCES personal_mcp_servers(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  PRIMARY KEY(server_id,environment_id)
);
CREATE INDEX IF NOT EXISTS mcp_server_environments_workspace_idx
  ON mcp_server_environments(workspace_id,environment_id);

-- Official OAuth client/token/verifier payloads are encrypted with the existing
-- workspace-secret crypto. No bearer or authorization code is stored in clear.
CREATE TABLE IF NOT EXISTS personal_mcp_oauth (
  server_id uuid PRIMARY KEY REFERENCES personal_mcp_servers(id) ON DELETE CASCADE,
  ciphertext text NOT NULL,
  iv text NOT NULL,
  key_version integer NOT NULL,
  state_digest text,
  state_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
