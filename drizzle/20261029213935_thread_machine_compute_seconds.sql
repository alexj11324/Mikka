-- Track E2B-billed compute time per thread machine. E2B bills only while a
-- sandbox is running; paused sandboxes cost nothing and keep their state. The
-- spend guard therefore needs running intervals, not wall-clock lifetime.
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "runningSince" timestamptz;
ALTER TABLE thread_machines ADD COLUMN IF NOT EXISTS "computeSeconds" bigint NOT NULL DEFAULT 0;
