-- target: MIKKA_DATABASE_URL
-- Personal mailbox schema (lib/session-mailbox.ts), fixed to the shape
-- production has had since 2026-10-25, when an unmerged branch created it
-- (decision: keep it and own it on main). A no-op on production; builds the
-- same objects on an empty database. Replaces
-- docs/backend/personal-mailbox-schema.review.sql.
SET LOCAL lock_timeout = '5s';

CREATE SEQUENCE IF NOT EXISTS mikka_mailbox_sequence;

CREATE TABLE IF NOT EXISTS session_mailboxes (
  id uuid PRIMARY KEY,
  "userId" text NOT NULL,
  "workspaceId" text NOT NULL,
  kind text NOT NULL CONSTRAINT session_mailboxes_kind_check CHECK (kind IN ('run', 'coordinator', 'bot', 'group')),
  "sessionKey" text NOT NULL,
  harness text,
  "latestRunId" uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  "wakeBudget" integer NOT NULL DEFAULT 0 CONSTRAINT "session_mailboxes_wakeBudget_check" CHECK ("wakeBudget" BETWEEN 0 AND 10),
  disabled boolean NOT NULL DEFAULT false,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("userId", "workspaceId", kind, "sessionKey")
);

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "mailboxId" uuid REFERENCES session_mailboxes(id);

-- Peer messages have a mailbox, not a run.
ALTER TABLE run_messages ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "mailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "senderMailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "replyTo" uuid REFERENCES run_messages(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "dedupeKey" uuid;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "acknowledgedAt" timestamptz;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS failure text;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner', 'peer'));
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS sequence bigint NOT NULL DEFAULT nextval('mikka_mailbox_sequence');
CREATE UNIQUE INDEX IF NOT EXISTS run_messages_mailbox_dedupe ON run_messages ("senderMailboxId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_messages_mailbox_sequence ON run_messages ("mailboxId", sequence);

ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS sequence bigint NOT NULL DEFAULT nextval('mikka_mailbox_sequence');

-- The account-deletion guards (20261031050731/2) attach themselves to tables
-- that exist when they run, and this table is newer than them on an empty
-- database. The workspace guard lives with the workspace target, so it is
-- added here only where that function is already present.
DO $$ BEGIN
  IF to_regprocedure('mikka_account_guard_insert()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'session_mailboxes'::regclass AND tgname = 'account_deletion_insert_guard') THEN
    CREATE TRIGGER account_deletion_insert_guard BEFORE INSERT ON session_mailboxes FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_insert('userId');
  END IF;
  IF to_regprocedure('mikka_account_guard_workspace_write()') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'session_mailboxes'::regclass AND tgname = 'account_deletion_workspace_guard') THEN
    CREATE TRIGGER account_deletion_workspace_guard BEFORE INSERT OR UPDATE ON session_mailboxes FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_workspace_write();
  END IF;
END $$;
