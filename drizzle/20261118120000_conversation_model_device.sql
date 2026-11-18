-- target: MIKKA_DATABASE_URL
-- Additive: a thread may pin which model answers it and which device runs it. Both stay
-- optional, so every existing row and every caller that sends neither keeps today's
-- behaviour (the lead Bot's own model, any eligible device).
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model text
  CHECK (model IS NULL OR model IN ('mikka', 'codex', 'claude'));
-- No foreign key, as with "leadBotId": the create path checks the device belongs to the
-- caller (lib/group-conversations-store.ts) and a removed device tombstones its row
-- instead of deleting it (lib/device-removal.ts), so history outlives the machine.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "deviceId" uuid;

COMMIT;
