-- target: MIKKA_DATABASE_URL
BEGIN;
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS execution_decision text;
-- Never infer execute from a transient error that may have overwritten skip.
-- Historical ambiguous failures are review-only; completed effects cannot be undone.
UPDATE schedule_occurrences SET execution_decision=CASE
 WHEN status='skipped' OR error='misfireSkipped' THEN 'skip'
 WHEN definition->>'misfire'='skip' AND status IN ('pending','running','failed') AND error IS NOT NULL THEN 'review'
 ELSE 'execute' END WHERE execution_decision IS NULL;
ALTER TABLE schedule_occurrences ALTER COLUMN execution_decision SET DEFAULT 'execute';
ALTER TABLE schedule_occurrences ALTER COLUMN execution_decision SET NOT NULL;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='schedule_occurrences'::regclass AND conname='schedule_occurrences_execution_decision_check') THEN
 ALTER TABLE schedule_occurrences ADD CONSTRAINT schedule_occurrences_execution_decision_check CHECK(execution_decision IN ('execute','skip','review'));
 END IF;
END $$;
CREATE OR REPLACE FUNCTION preserve_schedule_execution_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.execution_decision IS DISTINCT FROM NEW.execution_decision THEN RAISE EXCEPTION 'schedule execution decision is immutable'; END IF;
 RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='schedule_occurrences'::regclass AND tgname='schedule_execution_decision_immutable') THEN
 CREATE TRIGGER schedule_execution_decision_immutable BEFORE UPDATE OF execution_decision ON schedule_occurrences FOR EACH ROW EXECUTE FUNCTION preserve_schedule_execution_decision();
 END IF;
END $$;
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS report_next_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE schedule_occurrences ADD COLUMN IF NOT EXISTS report_attempts integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS schedule_occurrences_report_due ON schedule_occurrences(report_next_at,finished_at,id) WHERE status='failed' AND reported_at IS NULL;
COMMIT;
