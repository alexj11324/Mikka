-- target: MIKKA_DATABASE_URL
-- A notification is separate from reading or acknowledging its peer message.
SET LOCAL lock_timeout = '5s';
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "mailboxNotifiedAt" timestamptz;
-- Host-only notification lineage. -1 is an authenticated new user input;
-- depth 8 remains unread without another automatic Agent wake.
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "mailboxWakeDepth" integer NOT NULL DEFAULT 0
  CHECK ("mailboxWakeDepth" BETWEEN -1 AND 8);
CREATE INDEX IF NOT EXISTS run_messages_mailbox_unnotified
  ON run_messages ("mailboxId", sequence)
  WHERE "mailboxId" IS NOT NULL AND "mailboxNotifiedAt" IS NULL
    AND "acknowledgedAt" IS NULL AND failure IS NULL AND "mailboxWakeDepth" < 8;
