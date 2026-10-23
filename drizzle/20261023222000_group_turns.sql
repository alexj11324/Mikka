-- target: MIKKA_DATABASE_URL
-- Additive group routing queue/corrections. No existing rows rewritten.
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || '.group-turns', 0));
CREATE TABLE IF NOT EXISTS group_turns (
 "messageId" uuid PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
 "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 "userId" text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','complete','failed')),
 "agentId" uuid, route jsonb, error text, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_turns_queue_idx ON group_turns ("conversationId",status,"createdAt");
CREATE TABLE IF NOT EXISTS group_routing_corrections (
 "messageId" uuid PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
 "conversationId" uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 message text NOT NULL, "wrongId" uuid NOT NULL, "rightId" uuid,
 "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS group_routing_corrections_recent_idx ON group_routing_corrections ("conversationId","createdAt" DESC);
