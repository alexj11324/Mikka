-- target: MIKKA_DATABASE_URL
-- Domain model outcome, not another quota ledger or scheduler.
BEGIN;
DO $$ DECLARE fresh boolean; BEGIN
 SELECT NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='schedule_occurrences'::regclass AND attname='generation_state' AND NOT attisdropped) INTO fresh;
 ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS generation_state text NOT NULL DEFAULT 'not_started';
 -- An old in-flight model attempt has no trustworthy send/outcome marker.
 -- Preserve it for reconciliation instead of guessing that it never sent.
 IF fresh THEN
 UPDATE schedule_occurrences SET generation_state='uncertain' WHERE definition->'task'->>'kind'='agent_read' AND attempts>0 AND status IN ('pending','running');
 END IF;
END $$;
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS generation_context jsonb;
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS generation_checkpoint jsonb;
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS generation_digest text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='schedule_occurrences'::regclass AND conname='schedule_generation_state_check') THEN
 ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_generation_state_check CHECK(generation_state IN ('not_started','sending','returned','uncertain'));
 END IF;
END $$;
CREATE OR REPLACE FUNCTION preserve_schedule_generation_outcome() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.generation_context IS NOT NULL AND OLD.generation_context IS DISTINCT FROM NEW.generation_context THEN RAISE EXCEPTION 'schedule generation context is immutable'; END IF;
 IF OLD.generation_checkpoint IS NOT NULL AND (OLD.generation_checkpoint IS DISTINCT FROM NEW.generation_checkpoint OR OLD.generation_digest IS DISTINCT FROM NEW.generation_digest) THEN RAISE EXCEPTION 'schedule generation outcome is immutable'; END IF;
 IF OLD.generation_state IN ('returned','uncertain') AND OLD.generation_state IS DISTINCT FROM NEW.generation_state THEN RAISE EXCEPTION 'schedule generation decision is immutable'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='schedule_occurrences'::regclass AND tgname='schedule_generation_outcome_immutable') THEN
 CREATE TRIGGER schedule_generation_outcome_immutable BEFORE UPDATE OF generation_state,generation_context,generation_checkpoint,generation_digest ON schedule_occurrences FOR EACH ROW EXECUTE FUNCTION preserve_schedule_generation_outcome();
 END IF;
END $$;
COMMIT;
