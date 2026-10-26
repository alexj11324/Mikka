-- target: MIKKA_DATABASE_URL
-- PR166 policy on the existing mailbox executor. Never enable its direct provider dispatcher.
SET LOCAL lock_timeout = '5s';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "leadAgentId" uuid;
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS round integer NOT NULL DEFAULT 0 CHECK(round BETWEEN 0 AND 2);
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS ordinal integer NOT NULL DEFAULT 0;
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS "uncertainAt" timestamptz;
ALTER TABLE conversation_work ADD COLUMN IF NOT EXISTS "resultHash" text;
ALTER TABLE conversation_work DROP CONSTRAINT IF EXISTS "conversation_work_triggerMessageId_agentId_key";
CREATE UNIQUE INDEX IF NOT EXISTS conversation_work_round_identity ON conversation_work("triggerMessageId","agentId",round);
CREATE TABLE IF NOT EXISTS group_mailbox_turns (
 "messageId" uuid PRIMARY KEY, "conversationId" uuid NOT NULL, route jsonb NOT NULL,
 FOREIGN KEY ("conversationId","messageId") REFERENCES conversation_messages("conversationId",id)
);
CREATE TABLE IF NOT EXISTS group_mailbox_corrections (
 "messageId" uuid PRIMARY KEY, "conversationId" uuid NOT NULL, message text NOT NULL,
 "wrongId" uuid NOT NULL,"rightId" uuid,
 FOREIGN KEY ("conversationId","messageId") REFERENCES conversation_messages("conversationId",id)
);
CREATE TABLE IF NOT EXISTS group_work_reconciliations (
 "workId" uuid NOT NULL REFERENCES conversation_work(id), "userId" text NOT NULL,
 decision text NOT NULL CHECK(decision='abandon'), "createdAt" timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY("workId",decision)
);
