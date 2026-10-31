-- target: MIKKA_DATABASE_URL
BEGIN;
CREATE TABLE user_schedules (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 workspace_id uuid, bot_id uuid REFERENCES bots(id) ON DELETE CASCADE, source_event_id uuid NOT NULL,
 request_id text NOT NULL, definition jsonb NOT NULL, request_definition jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('active','paused','cancelled','completed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), next_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE NULLS NOT DISTINCT(owner_id,bot_id,request_id)
);
CREATE INDEX user_schedules_due ON user_schedules(next_at) WHERE status='active';
CREATE INDEX user_schedules_owner ON user_schedules(owner_id,bot_id,created_at DESC);
CREATE TABLE schedule_occurrences (
 id uuid PRIMARY KEY, schedule_id uuid NOT NULL REFERENCES user_schedules(id) ON DELETE CASCADE,
 version integer NOT NULL, due_at timestamptz NOT NULL, definition jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped','cancelled')),
 execution_decision text NOT NULL CHECK(execution_decision IN ('execute','skip')),
 operation_id uuid NOT NULL UNIQUE, event_id uuid REFERENCES coordinator_events(id) ON DELETE SET NULL,
 attempts integer NOT NULL DEFAULT 0, next_retry_at timestamptz NOT NULL,
 lease_token uuid, lease_until timestamptz, result jsonb, error text,
 started_at timestamptz, finished_at timestamptz, reported_at timestamptz,
 report_next_at timestamptz NOT NULL DEFAULT now(), report_attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(schedule_id,version,due_at)
);
CREATE INDEX schedule_occurrences_due ON schedule_occurrences(next_retry_at) WHERE status IN ('pending','running');
CREATE INDEX schedule_occurrences_report_due ON schedule_occurrences(report_next_at,finished_at,id) WHERE status='failed' AND reported_at IS NULL;
CREATE UNIQUE INDEX schedule_occurrences_event ON schedule_occurrences(event_id) WHERE event_id IS NOT NULL;
CREATE FUNCTION preserve_schedule_execution_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.execution_decision IS DISTINCT FROM NEW.execution_decision THEN RAISE EXCEPTION 'schedule execution decision is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER schedule_execution_decision_immutable BEFORE UPDATE OF execution_decision ON schedule_occurrences FOR EACH ROW EXECUTE FUNCTION preserve_schedule_execution_decision();
COMMIT;
