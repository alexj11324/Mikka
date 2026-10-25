-- target: MIKKA_DATABASE_URL
-- No scheduler is enabled by this migration. All effects currently stay in PG.
BEGIN;
CREATE TABLE IF NOT EXISTS user_schedules (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id), workspace_id uuid NOT NULL,
 conversation text NOT NULL CHECK (conversation IN ('bot','coordinator')), session_id text NOT NULL, source_id text NOT NULL,
 request_id text NOT NULL, definition jsonb NOT NULL, request_definition jsonb NOT NULL, status text NOT NULL CHECK (status IN ('active','paused','cancelled','completed')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0), next_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id, workspace_id, request_id)
);
CREATE INDEX IF NOT EXISTS user_schedules_due ON user_schedules(next_at) WHERE status='active';
CREATE INDEX IF NOT EXISTS user_schedules_owner ON user_schedules(owner_id,workspace_id,created_at DESC);
CREATE TABLE IF NOT EXISTS schedule_occurrences (
 id uuid PRIMARY KEY, schedule_id uuid NOT NULL REFERENCES user_schedules(id), version integer NOT NULL,
 due_at timestamptz NOT NULL, definition jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','running','succeeded','failed','skipped','cancelled')),
 operation_id uuid NOT NULL UNIQUE, attempts integer NOT NULL DEFAULT 0, next_retry_at timestamptz NOT NULL,
 lease_token uuid, lease_until timestamptz, result jsonb, error text,
 started_at timestamptz, finished_at timestamptz, reported_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(schedule_id,version,due_at)
);
CREATE INDEX IF NOT EXISTS schedule_occurrences_due ON schedule_occurrences(next_retry_at) WHERE status IN ('pending','running');
-- Compensation metadata belongs to the existing Coordinator inbox, not a second outbox.
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_next_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_lease_until timestamptz;
ALTER TABLE coordinator_events ADD COLUMN IF NOT EXISTS wake_error text;
CREATE INDEX IF NOT EXISTS coordinator_events_wake_due ON coordinator_events(wake_next_at) WHERE "deliveredAt" IS NULL;
COMMIT;
