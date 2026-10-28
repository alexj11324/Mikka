-- REVIEW ONLY: not a registered migration; do not execute without an approved target and budget.
-- Personal message contract; no enterprise audit, new role, grant, or backfill.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE SEQUENCE IF NOT EXISTS mikka_mailbox_sequence;
CREATE TABLE IF NOT EXISTS session_mailboxes (
 id uuid PRIMARY KEY,
 "userId" text NOT NULL,
 "workspaceId" uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('run','coordinator','bot')),
 "sessionKey" text NOT NULL,
 -- Informational only, never authority: avoid reverse run->mailbox locks on Agent deletion.
 "latestRunId" uuid,
 disabled boolean NOT NULL DEFAULT false,
 "wakeBudget" integer NOT NULL DEFAULT 0 CHECK ("wakeBudget"=0),
 harness text,
 "createdAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE ("userId","workspaceId",kind,"sessionKey")
);
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "mailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ALTER COLUMN "runId" DROP NOT NULL;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "mailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "senderMailboxId" uuid REFERENCES session_mailboxes(id);
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "dedupeKey" uuid;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "replyTo" uuid REFERENCES run_messages(id);
-- No default owner origin and no backfill: historical rows are not certified as human.
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS origin text CHECK (origin IN ('owner','peer'));
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS "acknowledgedAt" timestamptz;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS failure text;
ALTER TABLE run_messages ADD COLUMN IF NOT EXISTS sequence bigint NOT NULL DEFAULT nextval('mikka_mailbox_sequence');
CREATE UNIQUE INDEX IF NOT EXISTS run_messages_mailbox_dedupe ON run_messages ("senderMailboxId","dedupeKey") WHERE "dedupeKey" IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_messages_mailbox_sequence ON run_messages ("mailboxId",sequence);
COMMIT;
