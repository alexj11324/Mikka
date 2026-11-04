BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
ALTER TABLE group_turns ADD COLUMN IF NOT EXISTS "decisionAttempts" integer NOT NULL DEFAULT 0;
ALTER TABLE group_turns ADD COLUMN IF NOT EXISTS "nextDecisionAt" timestamptz;
-- Public duties are an explicit profile field. Private instructions are never copied.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS "publicRole" text NOT NULL DEFAULT '';
-- References into the existing Task/Factory/Thread lifecycle, never another scheduler.
CREATE TABLE IF NOT EXISTS group_task_bindings (
  "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "issueId" uuid NOT NULL,
  "userId" text NOT NULL,
  "reporterId" uuid NOT NULL,
  "reporterOwnerId" text NOT NULL,
  "reporterType" text NOT NULL CHECK ("reporterType" IN ('agent','bot')),
  "executionBotId" uuid NOT NULL,
  "sourceMessageId" uuid NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
  "sourceEventId" uuid NOT NULL,
  "lastReportedRevision" integer NOT NULL DEFAULT 0,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("conversationId","issueId")
);
CREATE INDEX IF NOT EXISTS group_task_actor_idx ON group_task_bindings("userId","conversationId");
CREATE TABLE IF NOT EXISTS group_task_receipts (
  "messageId" uuid PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
  "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "reporterId" uuid NOT NULL,
  operation text NOT NULL CHECK (operation IN ('create','continue','status','stop')),
  "issueId" uuid,
  result jsonb,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);
COMMIT;
