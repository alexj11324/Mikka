-- Existing credentials remain account-scoped. Track attribution without
-- inventing a device binding for credentials issued before this migration.
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS "revokedBy" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "deviceTokenId" uuid;
CREATE INDEX IF NOT EXISTS agent_runs_device_token_idx ON agent_runs("deviceTokenId");
