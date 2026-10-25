-- Durable intent references, not a second execution or approval state machine.
ALTER TABLE coordinator_events ADD COLUMN "accountActionBatch" jsonb;
ALTER TABLE pending_actions ADD COLUMN "sourceEventId" uuid REFERENCES coordinator_events(id);
ALTER TABLE pending_actions ADD COLUMN "actionSlotId" uuid;
CREATE UNIQUE INDEX pending_actions_source_slot_key ON pending_actions ("userId", "sourceEventId", "actionSlotId") WHERE "sourceEventId" IS NOT NULL;
ALTER TABLE agent_runs ADD COLUMN "accountActionRefs" jsonb NOT NULL DEFAULT '[]'::jsonb;
