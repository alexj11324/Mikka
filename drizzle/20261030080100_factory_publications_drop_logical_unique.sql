-- target: MIKKA_DATABASE_URL
-- BE-4 retry, step 2: drop UNIQUE("taskId","candidateId",action,target). Runs after
-- 20261030080000 built factory_publications_active_key (partial, WHERE status <> 'failed'), which
-- keeps the "never repeat a possibly performed action" guarantee for reserved/uncertain/succeeded rows.
-- DROP CONSTRAINT takes ACCESS EXCLUSIVE briefly (catalog-only, no scan); lock_timeout bounds the wait.
-- Rollback (fails if a retry row already exists beside a failed one, by design):
--   alter table factory_publications add constraint factory_publications_taskId_candidateId_action_target_key unique ("taskId","candidateId",action,target);
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE factory_publications DROP CONSTRAINT IF EXISTS "factory_publications_taskId_candidateId_action_target_key";
COMMIT;
