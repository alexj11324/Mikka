-- target: MIKKA_DATABASE_URL
-- Additive group routing queue/corrections and nullable explicit lead metadata.
-- Existing groups default to no lead; explicit mentions/high-confidence model routes
-- still work. Fallback returns group_lead_required until the owner configures one.
-- No backfill or implicit first-joined/name-based designation.
-- Rollback after disabling group generation: DROP TABLE group_routing_corrections;
-- DROP TABLE group_turns; ALTER TABLE conversations DROP COLUMN "leadAgentId";
-- This discards queued turns/corrections/designation, never conversation history.
-- Own family lock only; 5s lock timeout bounds additive DDL wait. No history rewrite.
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.group-turns', 0));
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS "leadAgentId" uuid;
CREATE TABLE IF NOT EXISTS group_turns (
 "messageId" uuid PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
 "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 "userId" text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed')),
 "agentId" uuid, "activeRunId" uuid, route jsonb, error text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE group_turns ADD COLUMN IF NOT EXISTS "activeRunId" uuid;
CREATE INDEX IF NOT EXISTS group_turns_queue_idx ON group_turns ("conversationId",status,"createdAt");
CREATE TABLE IF NOT EXISTS group_routing_corrections (
 "messageId" uuid PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
 "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 message text NOT NULL, "wrongId" uuid NOT NULL, "rightId" uuid,
 "createdAt" timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE group_routing_corrections ADD COLUMN IF NOT EXISTS "decisionExecution" jsonb;
CREATE INDEX IF NOT EXISTS group_routing_corrections_recent_idx ON group_routing_corrections ("conversationId","createdAt" DESC);
