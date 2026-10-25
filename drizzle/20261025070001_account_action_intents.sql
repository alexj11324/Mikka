-- Durable intent references, not a second execution or approval state machine.
-- SQL may commit before the migration ledger write; replay preserves bound intents.
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS "accountActionBatch" jsonb;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "sourceEventId" uuid REFERENCES coordinator_events(id);
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS "actionSlotId" uuid;
CREATE UNIQUE INDEX IF NOT EXISTS pending_actions_source_slot_key ON pending_actions ("userId", "sourceEventId", "actionSlotId") WHERE "sourceEventId" IS NOT NULL;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "accountActionRefs" jsonb NOT NULL DEFAULT '[]'::jsonb;
