BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "deviceCode" ADD COLUMN IF NOT EXISTS "deviceArch" text;

COMMIT;
