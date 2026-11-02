BEGIN;
SET LOCAL lock_timeout = '5s';

-- What the daemon asking to connect reports about itself (host name, platform, client version), shown on
-- /device before 允许 (RFC 8628 §5.4). Nullable: codes from older daemons carry none.
ALTER TABLE "deviceCode" ADD COLUMN IF NOT EXISTS "deviceName" text;
ALTER TABLE "deviceCode" ADD COLUMN IF NOT EXISTS "devicePlatform" text;
ALTER TABLE "deviceCode" ADD COLUMN IF NOT EXISTS "clientVersion" text;

COMMIT;
