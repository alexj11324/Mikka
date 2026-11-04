-- target: MIKKA_DATABASE_URL
-- Traces reference existing messages/tasks; no prompt or private member configuration.
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.group-decision-quality', 0));
ALTER TABLE group_turns ADD COLUMN IF NOT EXISTS trace jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS group_decision_feedback (
  id uuid PRIMARY KEY,
  "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  "messageId" uuid NOT NULL REFERENCES group_turns("messageId") ON DELETE CASCADE,
  "userId" text NOT NULL,
  source text NOT NULL CHECK (source IN ('human_explicit','human_correction','human_cancellation','agent_evaluation')),
  kind text NOT NULL CHECK (kind IN ('helpful','unhelpful','wrong_member','missed_intervention','unwanted_task','reaction_positive','reaction_negative','cancelled_task','cancelled_turn')),
  "targetId" uuid,
  "sourceMessageId" uuid REFERENCES conversation_messages(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("messageId","userId",source,kind)
);
CREATE INDEX IF NOT EXISTS group_decision_feedback_conversation_idx ON group_decision_feedback("conversationId","createdAt" DESC);
