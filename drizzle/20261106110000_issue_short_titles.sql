-- target: MIKKA_DATABASE_URL
-- A task's short title (Alex 2026-11-06): written once by the Coordinator's flash model after the task is created,
-- with the title it was written from, so a later rename shows the new title instead. Nullable columns only: no row
-- is rewritten and old tasks are not backfilled.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "shortTitle" varchar(60);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS "shortTitleFrom" varchar(200);
COMMIT;
