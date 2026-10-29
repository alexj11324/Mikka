-- target: MIKKA_DATABASE_URL
-- Freeze the issue scope generation when the host first routes a Factory task.
-- Unknown historical grants stay null: current membership is not evidence of
-- authorization in the task's original generation. Owners retain own-issue access.
ALTER TABLE factory_tasks ADD COLUMN IF NOT EXISTS "scopeVersion" integer;
