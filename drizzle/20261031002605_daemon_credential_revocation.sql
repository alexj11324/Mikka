-- Keep legacy attribution unknown. New authenticated claims bind their token.
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS "revokedBy" text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "deviceTokenId" uuid;
CREATE INDEX IF NOT EXISTS agent_runs_device_token_idx ON agent_runs("deviceTokenId");

-- A bounded, non-secret receipt for this operation; not the enterprise audit
-- system. The credential, affected runs and receipt commit or roll back together.
CREATE TABLE IF NOT EXISTS device_credential_revocations (
  "tokenId" uuid PRIMARY KEY REFERENCES device_tokens(id),
  "ownerId" text NOT NULL,
  "actorId" text NOT NULL,
  "revokedAt" timestamptz NOT NULL,
  action text NOT NULL DEFAULT 'device.credential.revoked' CHECK (action='device.credential.revoked')
);
