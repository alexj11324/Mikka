-- target: MIKKA_DATABASE_URL
-- Additive: a thread may pin which model answers it and which device runs it. Both stay
-- optional, so every existing row and every caller that sends neither keeps today's
-- behaviour (the lead Bot's own model, any eligible device).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model text
  CHECK (model IS NULL OR model IN ('mikka', 'codex', 'claude'));
-- A removed device tombstones its row (lib/device-removal.ts), so the link survives with
-- SET NULL rather than deleting the thread's history with the machine.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "deviceId" uuid
  REFERENCES devices(id) ON DELETE SET NULL;

COMMIT;
