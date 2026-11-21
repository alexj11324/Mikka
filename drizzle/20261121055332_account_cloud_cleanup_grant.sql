-- target: DATABASE_URL
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION mikka_account_guard_workspace_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  workspace_scope text := row_data->>'workspaceId';
  ledger_owner text := row_data->>'ownerId';
  grant_value text := nullif(current_setting('mikka.account_cloud_cleanup_grant',true),'');
BEGIN
  IF TG_TABLE_NAME = 'operation_ledger'
     AND ledger_owner IS NOT NULL
     AND workspace_scope = 'personal:' || ledger_owner THEN
    PERFORM mikka_account_assert_writable(ledger_owner);
    RETURN NEW;
  END IF;
  -- The companion lock exists only while the deletion job performs external cleanup.
  IF grant_value IS NOT NULL AND TG_TABLE_NAME IN ('agent_runs','cloud_machines') AND EXISTS (
    SELECT 1 FROM account_deletion_workspace_guards w
    JOIN account_deletion_guards g ON g."jobId"=w."jobId"
    JOIN pg_catalog.pg_locks holder ON holder.locktype='advisory' AND holder.mode='ExclusiveLock' AND holder.granted AND holder.objsubid=1
      AND ((holder.classid::bigint<<32) | holder.objid::bigint)=hashtextextended('mikka-account-deletion-job:' || w."jobId"::text,0)
    JOIN pg_catalog.pg_locks child ON child.pid=holder.pid AND child.database=holder.database AND child.locktype='advisory'
      AND child.mode='ExclusiveLock' AND child.granted AND child.objsubid=1
      AND ((child.classid::bigint<<32) | child.objid::bigint)=hashtextextended('mikka-account-cloud-cleanup:' || w."jobId"::text || ':' || grant_value,0)
    WHERE w."workspaceId"=workspace_scope::uuid
      AND g."subjectId"=CASE WHEN TG_TABLE_NAME='agent_runs' THEN row_data->>'userId' ELSE ledger_owner END
  ) THEN RETURN NEW; END IF;
  IF EXISTS(SELECT 1 FROM account_deletion_workspace_guards WHERE "workspaceId"=workspace_scope::uuid) THEN
    RAISE EXCEPTION 'account_deletion_pending' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
COMMIT;
