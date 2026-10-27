-- Existing device credentials stay unchanged. Cloud credentials are bound to
-- exactly one pre-created device/workspace and can expire or be revoked.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'local';
ALTER TABLE cloud_machines ADD COLUMN IF NOT EXISTS "deviceId" uuid REFERENCES devices(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cloud_machines_device_idx ON cloud_machines ("deviceId") WHERE "deviceId" IS NOT NULL;
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS "boundDeviceId" uuid REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS "boundWorkspaceId" uuid;
ALTER TABLE device_tokens ADD COLUMN IF NOT EXISTS "expiresAt" timestamptz;
