BEGIN;
SET LOCAL lock_timeout = '5s';

-- A child can acknowledge custody only while its coordinator still owns both
-- the canonical deletion job lock and this run's private companion lock.
CREATE FUNCTION mikka_account_allows_byos_cleanup(table_name text, before_row jsonb, after_row jsonb)
RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE
  grant_value text := nullif(current_setting('mikka.byos_cleanup_grant',true),'');
  conn_id text := CASE WHEN table_name='byos_connections' THEN before_row->>'id' ELSE before_row->>'connectionId' END;
  cleared text[] := ARRAY['quota','secretName','secretDigest','accessSecretName','accessDigest','providerSubject',
    'operationId','operationKind','operationDeadline','stagedSecretName','stagedDigest','stagedAccessName','stagedAccessDigest','lastErrorCode'];
  allowed text[];
BEGIN
  IF grant_value IS NULL OR table_name NOT IN ('byos_connections','byos_oauth_attempts','byos_secret_artifacts','byos_enrollment_transfers') THEN
    RETURN false;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_deletion_workspace_guards w
    JOIN account_deletion_guards g USING ("jobId")
    JOIN account_deletion_jobs j ON j.id=w."jobId" AND j."subjectUserId"=g."subjectId"
    JOIN byos_connections c ON c.id=conn_id::uuid AND c."ownerId"=g."subjectId" AND c."workspaceId"=w."workspaceId"::text
    JOIN pg_locks holder ON holder.locktype='advisory' AND holder.mode='ExclusiveLock' AND holder.granted AND holder.objsubid=1
      AND ((holder.classid::bigint<<32) | holder.objid::bigint)=hashtextextended('mikka-account-deletion-job:' || j.id::text,0)
    JOIN pg_locks child ON child.pid=holder.pid AND child.database=holder.database AND child.locktype='advisory'
      AND child.mode='ExclusiveLock' AND child.granted AND child.objsubid=1
      AND ((child.classid::bigint<<32) | child.objid::bigint)=hashtextextended('mikka-account-byos-cleanup:' || j.id::text || ':' || grant_value,0)
    WHERE holder.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND j.stage='external_pending' AND j.plan->'solo' ? (before_row->>'workspaceId')
      AND g."subjectId"=before_row->>'ownerId' AND c."workspaceId"=before_row->>'workspaceId'
      AND (NOT (before_row ? 'provider') OR c.provider=before_row->>'provider')
  ) THEN RETURN false; END IF;

  CASE table_name
    WHEN 'byos_connections' THEN
      IF (before_row - 'removedAt')=(after_row - 'removedAt') THEN
        RETURN before_row->>'state'='disconnected' AND after_row->>'removedAt' IS NOT NULL
          AND NOT (jsonb_strip_nulls(before_row) ?| ARRAY['secretName','accessSecretName','stagedSecretName','stagedAccessName'])
          AND NOT EXISTS(SELECT 1 FROM byos_secret_artifacts WHERE "connectionId"=conn_id::uuid AND "deletedAt" IS NULL)
          AND NOT EXISTS(SELECT 1 FROM byos_enrollment_sources WHERE "connectionId"=conn_id::uuid AND "deletedAt" IS NULL);
      END IF;
      allowed := cleared || ARRAY['state','epoch','updatedAt'];
      RETURN before_row-allowed=after_row-allowed AND before_row->>'state'<>'disconnected'
        AND after_row->>'state'='disconnected' AND (after_row->>'epoch')::bigint=(before_row->>'epoch')::bigint+1
        AND NOT (jsonb_strip_nulls(after_row) ?| cleared);
    WHEN 'byos_oauth_attempts' THEN
      RETURN before_row-'consumedAt'=after_row-'consumedAt' AND after_row->>'consumedAt' IS NOT NULL
        AND (before_row->>'consumedAt' IS NULL OR before_row->>'consumedAt'=after_row->>'consumedAt');
    WHEN 'byos_secret_artifacts' THEN
      IF before_row->>'deletedAt' IS NOT NULL THEN RETURN false; END IF;
      IF before_row-'deletingAt'=after_row-'deletingAt' THEN
        RETURN after_row->>'deletingAt' IS NOT NULL;
      END IF;
      IF before_row->>'deletingAt' IS NULL OR before_row-ARRAY['deletedAt','lastError']<>after_row-ARRAY['deletedAt','lastError'] THEN RETURN false; END IF;
      IF after_row->>'deletedAt' IS NULL THEN RETURN after_row->>'lastError' IN ('deletion_failed','creation_outcome_unknown'); END IF;
      RETURN after_row->>'lastError' IS NULL AND NOT (before_row->>'createUncertain')::boolean
        AND (NOT (before_row->>'createStarted')::boolean OR (before_row->>'createSettled')::boolean);
    WHEN 'byos_enrollment_transfers' THEN
      allowed := ARRAY['claimConfirmedAt','sourceCreationState','attemptCreationSettled'];
      RETURN before_row-allowed=after_row-allowed AND after_row->>'claimConfirmedAt' IS NOT NULL
        AND (before_row->>'claimConfirmedAt' IS NULL OR before_row->>'claimConfirmedAt'=after_row->>'claimConfirmedAt')
        AND (before_row->>'sourceCreationState'=after_row->>'sourceCreationState' OR after_row->>'sourceCreationState'='uncertain'
          OR (before_row->>'sourceCreationState'='unknown' AND after_row->>'sourceCreationState'='settled'))
        AND (NOT (before_row->>'attemptCreationSettled')::boolean OR (after_row->>'attemptCreationSettled')::boolean);
  END CASE;
  RETURN false;
END $$;

-- APP can already carry the historical Workspace guard. On a fresh combined
-- database the Workspace migration pass installs that guard later.
CREATE FUNCTION mikka_install_account_byos_cleanup_guards() RETURNS void LANGUAGE plpgsql AS $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['byos_connections','byos_oauth_attempts','byos_secret_artifacts','byos_enrollment_transfers'] LOOP
    IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass(tab) AND tgname='account_deletion_workspace_guard'
      AND tgfoid=to_regprocedure('mikka_account_guard_workspace_write()') AND tgtype=23 AND tgenabled='O' AND NOT tgisinternal) THEN
      EXECUTE format('DROP TRIGGER account_deletion_workspace_guard ON %I',tab);
      EXECUTE format('DROP TRIGGER IF EXISTS account_deletion_byos_workspace_insert ON %I',tab);
      EXECUTE format('CREATE TRIGGER account_deletion_byos_workspace_insert BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION mikka_account_guard_workspace_write()',tab);
      EXECUTE format('CREATE TRIGGER account_deletion_workspace_guard BEFORE UPDATE ON %I FOR EACH ROW WHEN (
        nullif(current_setting(''mikka.byos_cleanup_grant'',true),'''') IS NULL OR
        mikka_account_allows_byos_cleanup(%L,to_jsonb(OLD),to_jsonb(NEW)) IS NOT TRUE
      ) EXECUTE FUNCTION mikka_account_guard_workspace_write()',tab,tab);
    END IF;
  END LOOP;
END $$;
SELECT mikka_install_account_byos_cleanup_guards();
COMMIT;
