-- target: MIKKA_DATABASE_URL
-- Context disclosure and the model account are different authorities. An owner
-- can use their own native subscription in a clean Shared task, but its native
-- session may never become another actor's inherited credential environment.
-- Unknown history remains unknown; the immutable receipt trigger is unchanged.
ALTER TABLE run_resource_disclosures
  ADD COLUMN "credentialKind" text NOT NULL DEFAULT 'legacy_unknown'
    CHECK ("credentialKind" IN ('legacy_unknown','api_key','subscription','native_login')),
  ADD COLUMN "credentialId" text,
  ADD COLUMN "credentialOwnerId" text,
  ADD CONSTRAINT run_disclosure_credential_reference CHECK (
    ("credentialKind"='legacy_unknown' AND "credentialId" IS NULL AND "credentialOwnerId" IS NULL)
    OR ("credentialKind"<>'legacy_unknown' AND length("credentialId")>0 AND length("credentialOwnerId")>0
      AND "credentialId" IS NOT NULL AND "credentialOwnerId" IS NOT NULL));
CREATE INDEX run_resource_disclosures_credential_device_idx ON run_resource_disclosures("deviceId","credentialKind");

-- References come only from the already-frozen host identity, and must agree
-- with the native provider selection. This function never reads key material.
CREATE FUNCTION mikka_run_model_credential_provenance(run_id uuid)
RETURNS TABLE ("credentialKind" text,"credentialId" text,"credentialOwnerId" text) LANGUAGE sql STABLE AS $$
  WITH frozen AS (
    SELECT r.*,r."agentDefinition"->'executionIdentity' AS identity,
      r."agentDefinition"#>'{executionIdentity,billingAccount,model}' AS model
    FROM agent_runs r WHERE r.id=run_id
  ), candidate AS (
    SELECT model,CASE WHEN identity->>'version' IN ('1','2') AND identity->>'executionPrincipal'="userId"
      AND length(model->>'resourceId')>0 AND length(model->>'ownerId')>0 THEN CASE
        WHEN model->>'kind'='api_key' AND "agentDefinition"#>>'{apiKey,keyId}'=model->>'resourceId'
          AND coalesce(jsonb_typeof("agentDefinition"->'subscription'),'null')='null' THEN 'api_key'
        WHEN model->>'kind'='subscription' AND "agentDefinition"#>>'{subscription,bindingId}'=model->>'resourceId'
          AND model->>'ownerId'="userId" AND coalesce(jsonb_typeof("agentDefinition"->'apiKey'),'null')='null' THEN 'subscription'
        WHEN model->>'kind'='native_login' AND model->>'resourceId'="deviceId"::text AND model->>'ownerId'="userId"
          AND coalesce(jsonb_typeof("agentDefinition"->'apiKey'),'null')='null'
          AND coalesce(jsonb_typeof("agentDefinition"->'subscription'),'null')='null' THEN 'native_login'
        ELSE 'legacy_unknown' END ELSE 'legacy_unknown' END AS kind FROM frozen
  ) SELECT kind,CASE WHEN kind<>'legacy_unknown' THEN model->>'resourceId' END,
      CASE WHEN kind<>'legacy_unknown' THEN model->>'ownerId' END FROM candidate;
$$;

-- Admission must separately validate the live, bounded collaboration receipt.
-- This additional guard prevents changing the latest model selection from
-- laundering an earlier subscription/login or a different private API key.
CREATE FUNCTION mikka_run_model_credential_history_allowed(source_run_id uuid,device_id uuid,actor_id text,
  execution_owner_id text,credential_kind text,credential_id text,credential_owner_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage AS (
    SELECT r.id,r."userId",r."workspaceId",r."issueId",r."continuesRunId",r."retryOf",
      r."questionContinuation"->>'originRunId' AS origin,0 AS depth,ARRAY[r.id] AS path,false AS cycle
      FROM agent_runs r WHERE r.id=source_run_id
    UNION ALL SELECT p.id,p."userId",p."workspaceId",p."issueId",p."continuesRunId",p."retryOf",
      p."questionContinuation"->>'originRunId',l.depth+1,l.path||p.id,coalesce(p.id=ANY(l.path),false)
      FROM lineage l CROSS JOIN LATERAL (
        SELECT DISTINCT id FROM unnest(ARRAY[l."continuesRunId",l."retryOf",
          CASE WHEN l.origin ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN l.origin::uuid END]) id WHERE id IS NOT NULL
      ) edge LEFT JOIN agent_runs p ON p.id=edge.id WHERE l.depth<32 AND NOT l.cycle AND l.id IS NOT NULL
  ) SELECT coalesce((SELECT r."userId"=execution_owner_id AND length(actor_id)>0
    AND credential_kind IN ('api_key','subscription','native_login') AND length(credential_id)>0 AND length(credential_owner_id)>0
    AND (actor_id=execution_owner_id OR (credential_kind='api_key'
      AND NOT EXISTS(SELECT 1 FROM lineage l WHERE l.id IS NULL OR l.cycle OR l.depth>=32
        OR l."userId" IS DISTINCT FROM r."userId" OR l."workspaceId" IS DISTINCT FROM r."workspaceId"
        OR l."issueId" IS DISTINCT FROM r."issueId"
        OR (l.origin IS NOT NULL AND l.origin !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
        OR (l.depth>0 AND NOT EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=l.id)))
      AND NOT EXISTS(SELECT 1 FROM run_resource_disclosures d
        WHERE (d."deviceId" IN(device_id,r."deviceId") OR d."runId" IN(SELECT id FROM lineage))
          AND (d."credentialKind"<>'api_key' OR d."credentialId" IS DISTINCT FROM credential_id
            OR d."credentialOwnerId" IS DISTINCT FROM credential_owner_id))))
    FROM agent_runs r WHERE r.id=source_run_id),false);
$$;

-- Keep the established machine/source checks, and require the host's clean
-- snapshot marker at every replay edge. An ACL update is not a clean snapshot.
CREATE OR REPLACE FUNCTION mikka_run_clean_execution_allowed(run_id uuid,device_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  WITH RECURSIVE lineage AS (
    SELECT r.id,r."userId",r."workspaceId",r."issueId",r."continuesRunId",r."retryOf",
      r."questionContinuation"->>'originRunId' AS origin,r."agentDefinition"->>'contextIsolation' AS isolation,
      0 AS depth,ARRAY[r.id] AS path,false AS cycle FROM agent_runs r WHERE r.id=run_id
    UNION ALL SELECT p.id,p."userId",p."workspaceId",p."issueId",p."continuesRunId",p."retryOf",
      p."questionContinuation"->>'originRunId',p."agentDefinition"->>'contextIsolation',
      l.depth+1,l.path||p.id,coalesce(p.id=ANY(l.path),false)
      FROM lineage l CROSS JOIN LATERAL (
        SELECT DISTINCT id FROM unnest(ARRAY[l."continuesRunId",l."retryOf",
          CASE WHEN l.origin ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' THEN l.origin::uuid END]) id WHERE id IS NOT NULL
      ) edge LEFT JOIN agent_runs p ON p.id=edge.id WHERE l.depth<32 AND NOT l.cycle AND l.id IS NOT NULL
  ) SELECT coalesce((SELECT r."deviceId"=device_id AND (mikka_run_personal_resources_allowed(r.id) OR (
      EXISTS(SELECT 1 FROM thread_machines m JOIN devices v ON v.id=m."deviceId"
        WHERE m."runId"=r.id AND m."deviceId"=device_id AND m."ownerId"=r."userId"
          AND m."workspaceId"=r."workspaceId" AND m."issueId"=r."issueId"
          AND m.state IN ('starting','running') AND m."sandboxId" IS NOT NULL AND m."resourceIsolation"='shared_clean'
          AND v.kind='cloud' AND v."ownerId"=r."userId" AND v."removedAt" IS NULL AND v.enabled)
      AND NOT EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE (d."deviceId"=device_id OR d."runId"=r.id)
        AND (d."personalResources" OR d.provenance='legacy_unknown'))
      AND NOT EXISTS(SELECT 1 FROM lineage l WHERE l.id IS NULL OR l.cycle OR l.depth>=32 OR l.isolation IS DISTINCT FROM 'shared_clean'
        OR l."userId" IS DISTINCT FROM r."userId" OR l."workspaceId" IS DISTINCT FROM r."workspaceId"
        OR l."issueId" IS DISTINCT FROM r."issueId"
        OR (l.origin IS NOT NULL AND l.origin !~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
        OR (l.depth>0 AND (NOT EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=l.id)
          OR EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=l.id AND (d."personalResources" OR d.provenance='legacy_unknown')))))
      AND mikka_run_model_credential_history_allowed(r.id,device_id,
        coalesce(r."agentDefinition"#>>'{executionIdentity,actor}',r."userId"),r."userId",
        credential."credentialKind",credential."credentialId",credential."credentialOwnerId")
    )) FROM agent_runs r CROSS JOIN LATERAL mikka_run_model_credential_provenance(r.id) credential WHERE r.id=run_id),false);
$$;
