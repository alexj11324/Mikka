-- target: MIKKA_DATABASE_URL
-- Additive. An older application ignores these columns and the run-prefixed rows.
ALTER TABLE conversation_reads ADD COLUMN IF NOT EXISTS "runReadAt" timestamptz;
ALTER TABLE conversation_reads ADD COLUMN IF NOT EXISTS "manuallyUnread" boolean NOT NULL DEFAULT false;
ALTER TABLE conversation_reads ADD COLUMN IF NOT EXISTS "unreadRevision" integer NOT NULL DEFAULT 0;
