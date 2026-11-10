-- target: MIKKA_DATABASE_URL
-- A shared child can still be exclusive behind a private ancestor. The same
-- predicate is used before queueing and again at every personal-resource read.
CREATE FUNCTION mikka_resource_personal_resources_allowed(resource_kind text,resource_id uuid,owner_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestry AS (
    SELECT p.*,0 AS depth FROM resource_access_policies p WHERE p.kind=resource_kind AND p.id=resource_id
    UNION ALL SELECT p.*,a.depth+1 FROM ancestry a JOIN resource_access_policies p
      ON p.kind=a."parentKind" AND p.id=a."parentId" WHERE a.depth<32
  ) SELECT coalesce((SELECT
      mikka_resource_acl_allowed('account',owner_id,root."workspaceId",root.kind,root.id,'canSteer')
      AND EXISTS(SELECT 1 FROM ancestry private WHERE private.visibility='private' AND private."ownerId"=owner_id
        AND NOT EXISTS(SELECT 1 FROM resource_access_grants g
          WHERE g."resourceKind"=private.kind AND g."resourceId"=private.id
            AND (g."subjectKind"<>'account' OR g."subjectId"<>owner_id)
            AND (g."expiresAt" IS NULL OR g."expiresAt">statement_timestamp())
            AND g.capabilities && ARRAY['canReadContent','canSteer','canApprove','canUseCredential','canUseMachine']::text[]))
    FROM ancestry root WHERE root.depth=0),false);
$$;

CREATE OR REPLACE FUNCTION mikka_run_personal_resources_allowed(run_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT
      coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId")=r."userId"
      AND NOT coalesce(r."agentDefinition"->'executionIdentity' ? 'collaborationAuthorizationId',false)
      AND mikka_resource_personal_resources_allowed('thread',r.id,r."userId")
    FROM agent_runs r WHERE r.id=run_id),false);
$$;

-- An old, unclaimed VM is not evidence of a clean HOME. Only the provider's
-- fresh official-template creation path may mark a new instance shared_clean.
-- Retained task-machine handoffs copy this state; a private claim taints it.
ALTER TABLE thread_machines ADD COLUMN "resourceIsolation" text NOT NULL DEFAULT 'legacy_unknown'
  CHECK ("resourceIsolation" IN ('legacy_unknown','shared_clean','owner_private'));
CREATE FUNCTION mikka_thread_machine_resource_isolation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."resourceIsolation"='owner_private' AND NEW."resourceIsolation"<>'owner_private' THEN
    RAISE EXCEPTION 'private_machine_disclosure_immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER thread_machine_resource_isolation BEFORE UPDATE OF "resourceIsolation" ON thread_machines
  FOR EACH ROW EXECUTE FUNCTION mikka_thread_machine_resource_isolation();

-- Native sessions, retry checkpoints and retained devices are all part of the
-- execution boundary. Every source must match the same owner, task and tenant;
-- missing/cyclic/deep/unknown history denies sharing, including Owner=Actor.
CREATE FUNCTION mikka_run_clean_execution_allowed(run_id uuid,device_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage AS (
    SELECT r.id,r."userId",r."workspaceId",r."issueId",r."continuesRunId",r."retryOf",
      r."questionContinuation"->>'originRunId' AS origin,0 AS depth,ARRAY[r.id] AS path,false AS cycle
      FROM agent_runs r WHERE r.id=run_id
    UNION ALL SELECT p.id,p."userId",p."workspaceId",p."issueId",p."continuesRunId",p."retryOf",
      p."questionContinuation"->>'originRunId',l.depth+1,l.path||p.id,coalesce(p.id=ANY(l.path),false)
      FROM lineage l CROSS JOIN LATERAL (
        SELECT DISTINCT id FROM unnest(ARRAY[l."continuesRunId",l."retryOf",
          CASE WHEN l.origin ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN l.origin::uuid END]) id WHERE id IS NOT NULL
      ) edge LEFT JOIN agent_runs p ON p.id=edge.id WHERE l.depth<32 AND NOT l.cycle AND l.id IS NOT NULL
  ) SELECT coalesce((SELECT r."deviceId"=device_id AND (
      mikka_run_personal_resources_allowed(r.id) OR (
        EXISTS(SELECT 1 FROM thread_machines m JOIN devices v ON v.id=m."deviceId"
          WHERE m."runId"=r.id AND m."deviceId"=device_id AND m."ownerId"=r."userId"
            AND m."workspaceId"=r."workspaceId" AND m."issueId"=r."issueId"
            AND m.state IN ('starting','running') AND m."sandboxId" IS NOT NULL AND m."resourceIsolation"='shared_clean'
            AND v.kind='cloud' AND v."ownerId"=r."userId" AND v."removedAt" IS NULL AND v.enabled)
        AND NOT EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE (d."deviceId"=device_id OR d."runId"=r.id)
          AND (d."personalResources" OR d.provenance='legacy_unknown'))
        AND NOT EXISTS(SELECT 1 FROM lineage l WHERE l.id IS NULL OR l.cycle OR l.depth>=32
          OR l."userId" IS DISTINCT FROM r."userId" OR l."workspaceId" IS DISTINCT FROM r."workspaceId"
          OR l."issueId" IS DISTINCT FROM r."issueId"
          OR (l.origin IS NOT NULL AND l.origin !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
          OR (l.depth>0 AND (NOT EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=l.id)
            OR EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=l.id AND (d."personalResources" OR d.provenance='legacy_unknown')))))
      )) FROM agent_runs r WHERE r.id=run_id),false);
$$;
