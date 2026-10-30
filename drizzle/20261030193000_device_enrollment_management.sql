ALTER TABLE devices ADD COLUMN IF NOT EXISTS "deviceType" text NOT NULL DEFAULT 'laptop';
CREATE TABLE IF NOT EXISTS device_enrollments (
  "tokenHash" text PRIMARY KEY, "userId" text NOT NULL, "expiresAt" timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS device_management_commands (
  id uuid PRIMARY KEY, "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('redetect', 'restart', 'update')),
  "createdAt" timestamptz NOT NULL DEFAULT now(), "completedAt" timestamptz
);
CREATE INDEX IF NOT EXISTS device_management_pending ON device_management_commands ("deviceId") WHERE "completedAt" IS NULL;
ALTER TABLE device_management_commands ADD COLUMN IF NOT EXISTS error text;
