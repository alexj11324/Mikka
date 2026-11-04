-- Explicit owner grants for custom MCP connections; personal accounts remain private.
-- target: MIKKA_DATABASE_URL
CREATE TABLE IF NOT EXISTS personal_mcp_workspace_shares (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES personal_mcp_servers(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(server_id,workspace_id)
);
CREATE INDEX IF NOT EXISTS personal_mcp_workspace_shares_workspace
  ON personal_mcp_workspace_shares(workspace_id,server_id);
