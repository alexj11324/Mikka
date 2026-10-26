-- target: MIKKA_DATABASE_URL
-- Reply destinations are consumption metadata, not a second workflow or scheduler.
BEGIN;
ALTER TABLE coordinator_sessions ADD COLUMN IF NOT EXISTS telegram_reply_pending jsonb NOT NULL DEFAULT '[]';
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='coordinator_sessions'::regclass AND conname='coordinator_telegram_pending_array') THEN
 ALTER TABLE coordinator_sessions ADD CONSTRAINT coordinator_telegram_pending_array CHECK(jsonb_typeof(telegram_reply_pending)='array');
 END IF;
END $$;
COMMIT;
