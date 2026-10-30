-- target: MIKKA_DATABASE_URL
-- Settings: saved logins, activity and devices. Additive only.
-- Mirrors devices."removedAt"/"nameLocked" and deviceTokenDevices in lib/db/schema.ts.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- A removed device stays as a tombstone so run history keeps its device,
-- repository and agent references (lib/device-removal.ts).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "removedAt" timestamptz;
-- The person renamed it: a daemon re-register no longer overwrites the name.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS "nameLocked" boolean NOT NULL DEFAULT false;

-- Which daemon credential has acted as which device (register/heartbeat).
-- Local device tokens are user-scoped, so removing a device revokes exactly
-- the tokens recorded here.
CREATE TABLE IF NOT EXISTS device_token_devices (
  "tokenId" uuid NOT NULL REFERENCES device_tokens(id) ON DELETE CASCADE,
  "deviceId" uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tokenId", "deviceId")
);
CREATE INDEX IF NOT EXISTS device_token_devices_device_idx ON device_token_devices ("deviceId");

-- Activity timeline reads: decided proposals and per-login usage.
-- pending_actions_user_decided_idx is built CONCURRENTLY in 20261029213941 (large live table).
CREATE INDEX IF NOT EXISTS credential_access_credential_time ON credential_access_events (credential_id, ts DESC) WHERE credential_id IS NOT NULL;
COMMIT;
