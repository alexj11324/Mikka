-- target: MIKKA_DATABASE_URL
-- Publication history belongs to the retained run/task, like checkpoints and
-- artifact versions. userId remains immutable historical attribution; it is
-- never permission to act as a deleted account. Keep both run/task cascades.
SET LOCAL lock_timeout = '5s';
ALTER TABLE run_publications DROP CONSTRAINT IF EXISTS "run_publications_userId_fkey";
