-- target: MIKKA_DATABASE_URL
-- Where the task (title, issue text, run note) sits in a run's prompt, in code points (Alex 2026-11-06): the thread
-- shows only that part; Factory guidance and repository checks around it stay in the prompt the Agent receives.
-- Two nullable integers: no row is rewritten, and older runs without them show their whole prompt as before.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "promptTaskStart" integer;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS "promptTaskLength" integer;
COMMIT;
