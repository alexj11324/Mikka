-- Sharing content never grants a private account or machine. These explicit,
-- revocable grants fund bounded turns on this thread's isolated cloud machine.
-- No balances, subscription tokens or existing runs are reassigned.
CREATE TABLE thread_execution_grants (
  id uuid PRIMARY KEY,
  "workspaceId" uuid NOT NULL,
  "threadId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "actorId" text NOT NULL,
  "policyRevision" integer NOT NULL CHECK ("policyRevision">0),
  "credentialId" uuid NOT NULL,
  "credentialOwnerId" text NOT NULL,
  model text NOT NULL,
  harness text NOT NULL CHECK (harness IN ('claude_code','codex')),
  "computeOwnerId" text NOT NULL,
  "totalComputeSeconds" integer NOT NULL CHECK ("totalComputeSeconds" BETWEEN 60 AND 86400),
  "maxTurnSeconds" integer NOT NULL CHECK ("maxTurnSeconds" BETWEEN 30 AND 3600),
  "reservedComputeSeconds" integer NOT NULL DEFAULT 0,
  "expiresAt" timestamptz NOT NULL,
  "revokedAt" timestamptz,
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  CHECK ("ownerId"<>"actorId"),
  CHECK ("computeOwnerId"="ownerId"),
  CHECK ("maxTurnSeconds"<="totalComputeSeconds"),
  CHECK ("reservedComputeSeconds" BETWEEN 0 AND "totalComputeSeconds")
);
CREATE INDEX thread_execution_grants_thread_idx ON thread_execution_grants("workspaceId","threadId","actorId");

CREATE TABLE thread_execution_authorizations (
  id uuid PRIMARY KEY,
  "grantId" uuid NOT NULL REFERENCES thread_execution_grants(id),
  "grantRevision" integer NOT NULL,
  "requestId" uuid NOT NULL,
  "requestFingerprint" text NOT NULL CHECK ("requestFingerprint" ~ '^[a-f0-9]{64}$'),
  "workspaceId" uuid NOT NULL,
  "threadId" uuid NOT NULL,
  "sourceRunId" uuid NOT NULL,
  "ownerId" text NOT NULL,
  "actorId" text NOT NULL,
  "sessionId" text NOT NULL,
  "reservedSeconds" integer NOT NULL CHECK ("reservedSeconds">0),
  "expiresAt" timestamptz NOT NULL,
  "runId" uuid UNIQUE,
  "releasedAt" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("actorId","requestId")
);
CREATE INDEX thread_execution_authorizations_scope_idx ON thread_execution_authorizations("workspaceId","actorId","expiresAt");

CREATE FUNCTION mikka_thread_execution_source_allowed(thread_id uuid, source_id uuid, tenant uuid, owner_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE parents AS (
    SELECT p.kind,p.id,p."parentKind",p."parentId",0 AS depth FROM resource_access_policies p
      WHERE p.kind='thread' AND p.id=source_id AND p."workspaceId"=tenant
    UNION ALL SELECT p.kind,p.id,p."parentKind",p."parentId",a.depth+1 FROM parents a
      JOIN resource_access_policies p ON p.kind=a."parentKind" AND p.id=a."parentId"
      WHERE a.depth<32 AND p."workspaceId"=tenant
  ) SELECT EXISTS(SELECT 1 FROM parents WHERE kind='thread' AND id=thread_id)
    AND EXISTS(SELECT 1 FROM agent_runs source JOIN agent_runs root ON root.id=thread_id
      WHERE source.id=source_id AND source."userId"=owner_id AND root."userId"=owner_id
        AND source."workspaceId"=tenant AND root."workspaceId"=tenant
        AND source."issueId"=root."issueId");
$$;

CREATE UNIQUE INDEX agent_runs_collaboration_receipt_idx ON agent_runs
  (("agentDefinition"->'executionIdentity'->>'collaborationAuthorizationId'))
  WHERE "agentDefinition"->'executionIdentity'->>'collaborationAuthorizationId' IS NOT NULL;

CREATE FUNCTION mikka_bind_collaborative_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE identity jsonb := NEW."agentDefinition"->'executionIdentity'; receipt uuid; human_session text;
BEGIN
  IF identity->>'collaborationAuthorizationId' IS NULL THEN RETURN NEW; END IF;
  receipt := (identity->>'collaborationAuthorizationId')::uuid;
  SELECT "sessionId" INTO human_session FROM thread_execution_authorizations WHERE id=receipt;
  IF human_session IS NULL THEN RAISE EXCEPTION 'collaborative_run_authority_unavailable' USING ERRCODE='23514'; END IF;
  -- Same lock as the existing session-revocation trigger. A session deletion
  -- cannot miss an uncommitted admission and then leave it running.
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('enterprise-live-session:'||human_session,0));
  UPDATE thread_execution_authorizations a SET "runId"=NEW.id
    FROM thread_execution_grants g
    WHERE a.id=receipt AND g.id=a."grantId" AND g.revision=a."grantRevision"
      AND a."ownerId"=NEW."userId" AND a."actorId"=identity->>'actor'
      AND a."workspaceId"=NEW."workspaceId" AND a."runId" IS NULL
      AND a."releasedAt" IS NULL AND a."expiresAt">clock_timestamp()
      AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp()
      AND EXISTS(SELECT 1 FROM "session" s WHERE s.id=a."sessionId" AND s."userId"=a."actorId" AND s."expiresAt">clock_timestamp())
      AND EXISTS(SELECT 1 FROM resource_access_policies p WHERE p.kind='thread' AND p.id=g."threadId"
        AND p."workspaceId"=g."workspaceId" AND p."ownerId"=g."ownerId" AND p.revision=g."policyRevision")
      AND mikka_resource_acl_allowed('account',a."actorId",a."workspaceId",'thread',a."sourceRunId",'canSteer')
      AND mikka_thread_execution_source_allowed(g."threadId",a."sourceRunId",a."workspaceId",a."ownerId");
  IF NOT FOUND THEN RAISE EXCEPTION 'collaborative_run_authority_unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bind_collaborative_run BEFORE INSERT ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION mikka_bind_collaborative_run();

CREATE FUNCTION mikka_thread_execution_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO resource_access_events("resourceKind","resourceId","workspaceId","actorId","ownerId",revision,source,action,detail)
    VALUES('thread',NEW."threadId",NEW."workspaceId",
      coalesce(nullif(current_setting('mikka.acl_actor',true),''),'system'),NEW."ownerId",NEW.revision,
      'thread_execution_authority',CASE WHEN TG_OP='INSERT' THEN 'execution_granted'
        WHEN NEW."revokedAt" IS NOT NULL THEN 'execution_revoked' ELSE 'execution_reserved' END,
      jsonb_build_object('grantId',NEW.id,'actorId',NEW."actorId",'credentialId',NEW."credentialId",
        'credentialOwnerId',NEW."credentialOwnerId",'computeOwnerId',NEW."computeOwnerId",
        'totalComputeSeconds',NEW."totalComputeSeconds",'reservedComputeSeconds',NEW."reservedComputeSeconds",
        'maxTurnSeconds',NEW."maxTurnSeconds",'expiresAt',NEW."expiresAt"));
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_execution_grant_audit AFTER INSERT OR UPDATE ON thread_execution_grants
  FOR EACH ROW EXECUTE FUNCTION mikka_thread_execution_grant_audit();
