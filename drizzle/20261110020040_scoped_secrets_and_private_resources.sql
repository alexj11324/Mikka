-- target: MIKKA_DATABASE_URL
-- Extend the existing encrypted vault; never copy, decrypt or change a stored value.
-- Rollback retains these tables and the ACL-aware reader. Old membership-only
-- application versions cannot safely read resource-scoped rows.
ALTER TABLE workspace_secrets DROP CONSTRAINT "workspace_secrets_scopeType_check";
ALTER TABLE workspace_secrets DROP CONSTRAINT workspace_secrets_scope_ref;
ALTER TABLE workspace_secrets ADD CONSTRAINT "workspace_secrets_scopeType_check"
  CHECK ("scopeType" IN ('workspace','repository','project','thread'));
ALTER TABLE workspace_secrets ADD CONSTRAINT workspace_secrets_scope_ref CHECK (
  ("scopeType"='workspace' AND "scopeRef"='')
  OR ("scopeType"='repository' AND "scopeRef" ~ '^[a-z0-9_.-]{1,100}/[a-z0-9_.-]{1,100}$' AND "scopeRef" !~ '(^|/)\.{1,2}(/|$)')
  OR ("scopeType" IN ('project','thread') AND "scopeRef" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
);

-- The full execution authority still comes from frozen identity, membership,
-- SSO, receipt and machine checks. This narrower predicate answers only whether
-- this execution may receive its owner's *personal* resources. Sharing content
-- never grants them. Even a viewer can read tool output, so an explicit content
-- grant makes a private Thread non-exclusive for this purpose.
CREATE FUNCTION mikka_run_personal_resources_allowed(run_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT p.visibility='private' AND p."ownerId"=r."userId"
      AND coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId")=r."userId"
      AND NOT coalesce(r."agentDefinition"->'executionIdentity' ? 'collaborationAuthorizationId',false)
      AND mikka_resource_acl_allowed('account',r."userId",r."workspaceId",'thread',r.id,'canSteer')
      AND NOT EXISTS (SELECT 1 FROM resource_access_grants g
        WHERE g."resourceKind"='thread' AND g."resourceId"=r.id
          AND (g."subjectKind"<>'account' OR g."subjectId"<>r."userId")
          AND (g."expiresAt" IS NULL OR g."expiresAt">statement_timestamp())
          AND g.capabilities && ARRAY['canReadContent','canSteer','canApprove','canUseCredential','canUseMachine']::text[])
    FROM agent_runs r JOIN resource_access_policies p ON p.kind='thread' AND p.id=r.id
      AND p."workspaceId"=r."workspaceId" WHERE r.id=run_id),false);
$$;

-- A VM/native session retains files between turns. This sticky record prevents
-- a later collaboration grant from laundering an earlier private execution.
-- Legacy attempts are conservatively treated as having received personal data.
CREATE TABLE run_resource_disclosures (
  "runId" uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt>0),
  "workspaceId" uuid,
  "ownerId" text NOT NULL,
  "actorId" text NOT NULL,
  "deviceId" uuid,
  "personalResources" boolean NOT NULL,
  "policySnapshot" text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('legacy_unknown','claim')),
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("runId",attempt)
);
CREATE INDEX run_resource_disclosures_device_idx ON run_resource_disclosures("deviceId") WHERE "personalResources";
INSERT INTO run_resource_disclosures("runId",attempt,"workspaceId","ownerId","actorId","deviceId","personalResources","policySnapshot",provenance)
  SELECT id,greatest(attempt,1),"workspaceId","userId","userId","deviceId",true,'legacy_unknown','legacy_unknown'
  FROM agent_runs WHERE status<>'queued' OR "startedAt" IS NOT NULL;

CREATE FUNCTION mikka_disclosure_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'run_disclosure_immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'run_disclosure_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER run_disclosure_immutable BEFORE UPDATE OR DELETE ON run_resource_disclosures FOR EACH ROW EXECUTE FUNCTION mikka_disclosure_monotonic();

CREATE FUNCTION mikka_scoped_secret_tenant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scopeType" IN ('project','thread') AND NOT EXISTS (
    SELECT 1 FROM resource_access_policies p WHERE p.kind=NEW."scopeType" AND p.id=NEW."scopeRef"::uuid
      AND p."workspaceId"=NEW."workspaceId" AND p.visibility<>'quarantined'
  ) THEN RAISE EXCEPTION 'secret_scope_unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER workspace_secret_resource_scope BEFORE INSERT OR UPDATE ON workspace_secrets FOR EACH ROW EXECUTE FUNCTION mikka_scoped_secret_tenant();
