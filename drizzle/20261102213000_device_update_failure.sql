BEGIN;
SET LOCAL lock_timeout = '5s';

-- The daemon's last failed automatic update ({version, code, at}; codes only), reported on heartbeat.
-- Nullable with no default: a metadata-only change, no table rewrite.
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "updateFailure" jsonb;

COMMIT;
