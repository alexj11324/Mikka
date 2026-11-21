-- target: MIKKA_DATABASE_URL
-- Additive, replayable queue. Roll back application code and retain these
-- receipts; delete only with a separately reviewed cleanup migration.
CREATE TABLE IF NOT EXISTS mcp_device_checks (
  id uuid PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES personal_mcp_servers(id) ON DELETE CASCADE,
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  outcome text CHECK (outcome IN ('connected','check_failed','superseded'))
);
CREATE INDEX IF NOT EXISTS mcp_device_checks_pending_idx
  ON mcp_device_checks(device_id,created_at) WHERE completed_at IS NULL;
CREATE INDEX IF NOT EXISTS mcp_device_checks_server_idx
  ON mcp_device_checks(server_id,created_at DESC);
