-- Short-lived control-plane leases only. No shell input/output or credentials.
-- No cascading source FK: a deleted source must retain its remote-close target
-- until acknowledgement. Successful close deletes the lease; failures remain
-- due in the existing run-recovery owner. Machine gateways enforce the same TTL.
CREATE TABLE coding_review_sessions (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('terminal','preview')),
  "taskId" uuid NOT NULL,
  "runId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "workspaceId" uuid NOT NULL,
  "deviceId" uuid NOT NULL,
  "repoId" uuid NOT NULL,
  "deviceTokenId" uuid NOT NULL,
  "bindingId" text NOT NULL CHECK ("bindingId" ~ '^[0-9a-f]{64}$'),
  "sandboxId" text NOT NULL,
  "machineEpoch" bigint NOT NULL CHECK ("machineEpoch">=0),
  "machineOperationId" uuid NOT NULL,
  "credentialKind" text NOT NULL CHECK ("credentialKind" IN ('session','pat')),
  "credentialId" text NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz,
  reason text,
  "retryAt" timestamptz,
  UNIQUE ("runId",kind),
  CHECK ("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '5 minutes'),
  CHECK (("revokedAt" IS NULL AND reason IS NULL AND "retryAt" IS NULL)
    OR ("revokedAt" IS NOT NULL AND reason IS NOT NULL AND "retryAt" IS NOT NULL))
);
CREATE INDEX coding_review_sessions_due ON coding_review_sessions ((COALESCE("retryAt","expiresAt")));
CREATE INDEX coding_review_sessions_credential ON coding_review_sessions ("credentialKind","credentialId");
CREATE INDEX coding_review_sessions_owner ON coding_review_sessions ("ownerId","workspaceId");
CREATE INDEX coding_review_sessions_task ON coding_review_sessions ("taskId");

-- A source mutation fences already-issued capabilities in the same commit.
-- App control hooks push the close immediately; this durable row survives a
-- lost post-commit callback and is retried by the existing recovery owner.
CREATE FUNCTION mikka_fence_coding_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source jsonb;
  target text;
  affected uuid[];
BEGIN
  source := CASE WHEN TG_OP='INSERT' THEN to_jsonb(NEW) ELSE to_jsonb(OLD) END;
  target := source->>TG_ARGV[1];
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

CREATE TRIGGER coding_review_session_delete AFTER DELETE ON "session"
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('session','id','credential_revoked');
CREATE TRIGGER coding_review_session_update AFTER UPDATE OF "userId","expiresAt" ON "session"
  FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId" OR NEW."expiresAt"<OLD."expiresAt")
  EXECUTE FUNCTION mikka_fence_coding_review('session','id','credential_revoked');
CREATE TRIGGER coding_review_pat_delete AFTER DELETE ON personal_access_tokens
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('pat','id','credential_revoked');
CREATE TRIGGER coding_review_pat_update AFTER UPDATE OF "userId","workspaceId","revokedAt","expiresAt" ON personal_access_tokens
  FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD."workspaceId" IS DISTINCT FROM NEW."workspaceId"
    OR (NEW."revokedAt" IS NOT NULL AND OLD."revokedAt" IS DISTINCT FROM NEW."revokedAt")
    OR (NEW."expiresAt" IS NOT NULL AND (OLD."expiresAt" IS NULL OR NEW."expiresAt"<OLD."expiresAt")))
  EXECUTE FUNCTION mikka_fence_coding_review('pat','id','credential_revoked');

CREATE TRIGGER coding_review_task_delete AFTER DELETE ON issues
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('task','id','task_changed');
CREATE TRIGGER coding_review_task_update AFTER UPDATE OF "userId",scope,status,content ON issues
  FOR EACH ROW WHEN (OLD."userId" IS DISTINCT FROM NEW."userId" OR OLD.scope IS DISTINCT FROM NEW.scope
    OR (NEW.status IN ('done','canceled','duplicate') AND OLD.status IS DISTINCT FROM NEW.status)
    OR (COALESCE(OLD.content->'attrs'->'mikka',OLD.content->'attrs'->'orvilo')->>'deletedAt')
      IS DISTINCT FROM (COALESCE(NEW.content->'attrs'->'mikka',NEW.content->'attrs'->'orvilo')->>'deletedAt')
    OR (CASE WHEN COALESCE(OLD.content->'attrs'->'mikka',OLD.content->'attrs'->'orvilo')->'assignee'->>'kind'='member'
      THEN COALESCE(OLD.content->'attrs'->'mikka',OLD.content->'attrs'->'orvilo')->'assignee'->>'id' ELSE OLD."userId" END)
      IS DISTINCT FROM (CASE WHEN COALESCE(NEW.content->'attrs'->'mikka',NEW.content->'attrs'->'orvilo')->'assignee'->>'kind'='member'
      THEN COALESCE(NEW.content->'attrs'->'mikka',NEW.content->'attrs'->'orvilo')->'assignee'->>'id' ELSE NEW."userId" END))
  EXECUTE FUNCTION mikka_fence_coding_review('task','id','task_changed');

-- The latest admitted run owns the task's review surface. The task FK's
-- KEY SHARE conflicts with beginReviewSession's Task FOR UPDATE authority lock.
CREATE TRIGGER coding_review_new_run AFTER INSERT ON agent_runs
  FOR EACH ROW WHEN (NEW."issueId" IS NOT NULL)
  EXECUTE FUNCTION mikka_fence_coding_review('task','issueId','run_changed');
CREATE TRIGGER coding_review_run_delete AFTER DELETE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('run','id','run_changed');
CREATE TRIGGER coding_review_run_update AFTER UPDATE OF "userId","issueId","deviceId","deviceRepoId","deviceTokenId","agentDefinition",
  "worktreePath",attempt,"sessionId","stopRequestedAt","stopReason",status,"leaseExpiresAt" ON agent_runs
  FOR EACH ROW WHEN (ROW(OLD."userId",OLD."issueId",OLD."deviceId",OLD."deviceRepoId",OLD."deviceTokenId",OLD."worktreePath",OLD.attempt,OLD."sessionId")
      IS DISTINCT FROM ROW(NEW."userId",NEW."issueId",NEW."deviceId",NEW."deviceRepoId",NEW."deviceTokenId",NEW."worktreePath",NEW.attempt,NEW."sessionId")
    OR (OLD."agentDefinition"#>'{executionIdentity,workspaceId}') IS DISTINCT FROM (NEW."agentDefinition"#>'{executionIdentity,workspaceId}')
    OR (OLD."agentDefinition"->'repositoryAdmission') IS DISTINCT FROM (NEW."agentDefinition"->'repositoryAdmission')
    OR (NEW."stopRequestedAt" IS NOT NULL AND OLD."stopRequestedAt" IS DISTINCT FROM NEW."stopRequestedAt")
    OR (NEW."stopReason"='device_lost' AND OLD."stopReason" IS DISTINCT FROM NEW."stopReason")
    OR (NEW.status IN ('stopped','cancelled') AND OLD.status IS DISTINCT FROM NEW.status)
    OR (NEW.status IN ('preparing','running','waiting_input','finishing')
      AND OLD."leaseExpiresAt" IS DISTINCT FROM NEW."leaseExpiresAt"
      AND (NEW."leaseExpiresAt" IS NULL OR NEW."leaseExpiresAt"<=clock_timestamp())))
  EXECUTE FUNCTION mikka_fence_coding_review('run','id','run_changed');

CREATE TRIGGER coding_review_binding_delete AFTER DELETE ON computer_run_bindings
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('run','runId','run_changed');
CREATE TRIGGER coding_review_binding_update AFTER UPDATE OF "ownerId","workspaceId","botId" ON computer_run_bindings
  FOR EACH ROW WHEN (ROW(OLD."ownerId",OLD."workspaceId",OLD."botId") IS DISTINCT FROM ROW(NEW."ownerId",NEW."workspaceId",NEW."botId"))
  EXECUTE FUNCTION mikka_fence_coding_review('run','runId','run_changed');

CREATE TRIGGER coding_review_machine_delete AFTER DELETE ON thread_machines
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('run','runId','machine_changed');
CREATE TRIGGER coding_review_machine_update AFTER UPDATE OF "ownerId","workspaceId","issueId","deviceId","repoId","sandboxId",epoch,"operationId",state ON thread_machines
  FOR EACH ROW WHEN (ROW(OLD."ownerId",OLD."workspaceId",OLD."issueId",OLD."deviceId",OLD."repoId",OLD."sandboxId",OLD.epoch,OLD."operationId")
      IS DISTINCT FROM ROW(NEW."ownerId",NEW."workspaceId",NEW."issueId",NEW."deviceId",NEW."repoId",NEW."sandboxId",NEW.epoch,NEW."operationId")
    OR (NEW.state='ended' AND OLD.state IS DISTINCT FROM NEW.state))
  EXECUTE FUNCTION mikka_fence_coding_review('run','runId','machine_changed');
CREATE TRIGGER coding_review_device_delete AFTER DELETE ON devices
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('device','id','machine_changed');
CREATE TRIGGER coding_review_device_update AFTER UPDATE OF "ownerId",enabled,"removedAt" ON devices
  FOR EACH ROW WHEN (OLD."ownerId" IS DISTINCT FROM NEW."ownerId" OR (OLD.enabled AND NOT NEW.enabled)
    OR (NEW."removedAt" IS NOT NULL AND OLD."removedAt" IS DISTINCT FROM NEW."removedAt"))
  EXECUTE FUNCTION mikka_fence_coding_review('device','id','machine_changed');
CREATE TRIGGER coding_review_repo_delete AFTER DELETE ON device_repos
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('repo','id','machine_changed');
CREATE TRIGGER coding_review_repo_update AFTER UPDATE OF "userId","deviceId","repoPath","remoteUrl" ON device_repos
  FOR EACH ROW WHEN (ROW(OLD."userId",OLD."deviceId",OLD."repoPath",OLD."remoteUrl")
    IS DISTINCT FROM ROW(NEW."userId",NEW."deviceId",NEW."repoPath",NEW."remoteUrl"))
  EXECUTE FUNCTION mikka_fence_coding_review('repo','id','machine_changed');
CREATE TRIGGER coding_review_device_token_delete AFTER DELETE ON device_tokens
  FOR EACH ROW EXECUTE FUNCTION mikka_fence_coding_review('deviceToken','id','credential_revoked');
-- Ordinary parking revokes execution tokens without revokedBy. That retained
-- claim is provenance only; an explicit credential revocation is different.
CREATE TRIGGER coding_review_device_token_update AFTER UPDATE OF "revokedBy" ON device_tokens
  FOR EACH ROW WHEN (NEW."revokedBy" IS NOT NULL AND OLD."revokedBy" IS DISTINCT FROM NEW."revokedBy")
  EXECUTE FUNCTION mikka_fence_coding_review('deviceToken','id','credential_revoked');
