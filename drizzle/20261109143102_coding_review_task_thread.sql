-- The review surface follows latestTaskRun's Task-thread predicate, never an
-- independent Factory checker. Factory queue and bind_run commit together, but
-- the binding is absent at agent_runs INSERT time. The Task row/FK still fences
-- concurrent grants; this deferred source fence runs before COMMIT succeeds.
CREATE OR REPLACE FUNCTION mikka_fence_coding_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source jsonb;
  target text;
  affected uuid[];
BEGIN
  source := CASE WHEN TG_OP='INSERT' OR TG_TABLE_NAME='factory_attempts' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
  -- Dispatch inserts the run before its Factory attempt is bound. Only the
  -- committed row and ledger classify it; prompt/readOnly are not authority.
  -- An insert deleted again, or older than the final Task executor, changes
  -- no review surface. This check runs at deferred-trigger execution time.
  IF TG_OP='INSERT' AND TG_TABLE_NAME='agent_runs' AND TG_ARGV[0]='task' THEN
    SELECT to_jsonb(r) INTO source FROM agent_runs r
      WHERE r.id=NEW.id AND r."issueId" IS NOT NULL AND r.kind<>'group_chat'
        AND NOT EXISTS (SELECT 1 FROM factory_attempts fa WHERE fa."runId"=r.id AND fa.stage IN ('review','verify','monitor'))
        AND NOT EXISTS (SELECT 1 FROM agent_runs newer WHERE newer."issueId"=r."issueId"
          AND newer.kind<>'group_chat'
          AND NOT EXISTS (SELECT 1 FROM factory_attempts fa WHERE fa."runId"=newer.id AND fa.stage IN ('review','verify','monitor'))
          AND (newer."createdAt",newer.id)>(r."createdAt",r.id));
    IF source IS NULL THEN RETURN NEW; END IF;
  END IF;
  target := source->>TG_ARGV[1];
  -- Actual bind_run owns this lock too. Taking it in the source trigger also
  -- serializes a direct ledger write with a grant before observing its leases.
  IF TG_TABLE_NAME='factory_attempts' THEN
    PERFORM id FROM agent_runs WHERE id=target::uuid FOR UPDATE;
  END IF;
  -- All invalidators keep machine→lease order, including logout from a
  -- different browser racing a begin on the same run with another credential.
  SELECT array_agg(DISTINCT s."runId") INTO affected FROM coding_review_sessions s
    WHERE CASE TG_ARGV[0]
      WHEN 'session' THEN s."credentialKind"='session' AND s."credentialId"=target
      WHEN 'pat' THEN s."credentialKind"='pat' AND s."credentialId"=target
      WHEN 'task' THEN s."taskId"=target::uuid
      WHEN 'run' THEN s."runId"=target::uuid
      WHEN 'device' THEN s."deviceId"=target::uuid
      WHEN 'repo' THEN s."repoId"=target::uuid
      WHEN 'deviceToken' THEN s."deviceTokenId"=target::uuid
      ELSE false END;
  IF affected IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  PERFORM "runId" FROM thread_machines WHERE "runId"=ANY(affected) ORDER BY "runId" FOR UPDATE;
  WITH fenced AS (
    UPDATE coding_review_sessions s
      SET "revokedAt"=COALESCE(s."revokedAt",clock_timestamp()),
        reason=COALESCE(s.reason,TG_ARGV[2]),"retryAt"=clock_timestamp()
      WHERE CASE TG_ARGV[0]
        WHEN 'session' THEN s."credentialKind"='session' AND s."credentialId"=target
        WHEN 'pat' THEN s."credentialKind"='pat' AND s."credentialId"=target
        WHEN 'task' THEN s."taskId"=target::uuid
        WHEN 'run' THEN s."runId"=target::uuid
        WHEN 'device' THEN s."deviceId"=target::uuid
        WHEN 'repo' THEN s."repoId"=target::uuid
        WHEN 'deviceToken' THEN s."deviceTokenId"=target::uuid
        ELSE false END
      RETURNING s."runId"
  ) SELECT array_agg(DISTINCT "runId") INTO affected FROM fenced;
  -- This metadata-only update does not re-enter the machine identity trigger.
  IF affected IS NOT NULL THEN
    UPDATE thread_machines SET "lifecycleAt"=clock_timestamp(),
      lifecycle=lifecycle-'reconcileId'-'reconcileUntil' WHERE "runId"=ANY(affected);
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER coding_review_new_run ON agent_runs;
CREATE CONSTRAINT TRIGGER coding_review_new_run
  AFTER INSERT ON agent_runs DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW."issueId" IS NOT NULL)
  EXECUTE FUNCTION mikka_fence_coding_review('task','issueId','run_changed');


-- A late binding of an existing active run withdraws only that checker's own
-- capabilities. Ordinary output/status changes never enter this trigger.
CREATE TRIGGER coding_review_checker_insert AFTER INSERT ON factory_attempts
  FOR EACH ROW WHEN (NEW."runId" IS NOT NULL AND NEW.stage IN ('review','verify','monitor'))
  EXECUTE FUNCTION mikka_fence_coding_review('run','runId','run_changed');
CREATE TRIGGER coding_review_checker_bind AFTER UPDATE OF "runId",stage ON factory_attempts
  FOR EACH ROW WHEN (NEW."runId" IS NOT NULL AND NEW.stage IN ('review','verify','monitor')
    AND (OLD."runId" IS DISTINCT FROM NEW."runId" OR OLD.stage IS DISTINCT FROM NEW.stage))
  EXECUTE FUNCTION mikka_fence_coding_review('run','runId','run_changed');
