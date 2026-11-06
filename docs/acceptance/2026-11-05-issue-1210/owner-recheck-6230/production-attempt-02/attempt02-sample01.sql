-- Published evidence copy: Owner account ID redacted; do not execute this copy.
-- After normal single click02 at 2026-11-06T00:00:55.806Z. READ ONLY.
SET TRANSACTION READ ONLY;

SET LOCAL statement_timeout='5s';

SELECT clock_timestamp() AS "observedAt",t.id AS "taskId",t."issueId",t."sourceEventId",t."botId",t.stage,t.status,t.revision,t."attemptId",t."candidateId",t.route->>'flowVersion' AS "flowVersion",
 c.kind,c.sha AS "candidateSha",c."runId" AS "producerRunId",p.report->>'deliverableCommit' AS "deliverableHead"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",e."eventId",e."createdAt",e.request,e.result->'task' AS "resultTask"
FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND e.request->>'kind'='owner_candidate_recheck'
ORDER BY e."createdAt",e."eventId";

SELECT clock_timestamp() AS "observedAt",a.id AS "attemptId",a.position,a.stage,a.status AS "attemptStatus",a."candidateId",a.output,
 r.id AS "runId",r.kind,r.status,r."stopReason",r.error,r."sessionId",r."startedAt",r."finishedAt",r."leaseExpiresAt",r."stopRequestedAt",r."continuesRunId",r."retryOf",r."questionContinuation",r."baseBranch",
 r."agentDefinition"->>'harness' AS harness,r."agentDefinition"->>'model' AS model,r."agentDefinition"->'subscription' AS subscription,r."agentDefinition"->'modelDispatch' AS "modelDispatch",r."agentDefinition"->'agentProfile' AS "agentProfile",r."agentDefinition"->'policyCeiling' AS "policyCeiling",r."agentDefinition"->>'readOnly' AS "readOnly",r."agentDefinition"->'executionIdentity'->>'workspaceId' AS "workspaceId",
 n."bindingId" AS "nativeClaimBindingId",b."connectionId",b."connectionRevision",b.route,b."modelId",EXISTS(SELECT 1 FROM model_api_key_runs k WHERE k."runId"=r.id) AS "apiClaim",r.report->'runtime'->>'observedModel' AS "providerObservedModel",
 tm."sandboxId",tm."snapshotId" AS "templateOrSnapshotId",tm.state AS "machineState",tm."createdAt" AS "machineCreatedAt",tm."runningSince",tm."endedAt"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
LEFT JOIN byos_native_runs n ON n."runId"=r.id LEFT JOIN byos_bindings b ON b.id=n."bindingId"
LEFT JOIN thread_machines tm ON tm."runId"=r.id AND tm."ownerId"=r."userId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 ORDER BY a.position;

SELECT clock_timestamp() AS "observedAt",id,stage,status,revision,"expiresAt","originRunId","originSessionId","attemptId","candidateId","waitingBinding",
 "answerId","answerSource","answerSourceEventId","answerFingerprint","answeredAt",answer IS NULL AS "answerNull",result IS NULL AS "resultNull","continuationRunId"
FROM factory_questions WHERE id='31b87a5f-7be6-49e9-9031-126dd2144007'
 AND "taskId"='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND "userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",m."workspaceId",m.state AS "parentState",m."sandboxId" AS "parentSandboxId",m."runtimeReady",m."deviceId",m."lastActiveAt",d.enabled AS "deviceEnabled"
FROM cloud_machines m LEFT JOIN devices d ON d.id=m."deviceId"
WHERE m."workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' AND m."ownerId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",
 (SELECT count(*)::integer FROM factory_events e WHERE e."taskId"=t.id AND e.request->>'kind'='owner_candidate_recheck') AS "ownerRecheckCount",
 (SELECT count(*)::integer FROM factory_deliverable_acceptances x WHERE x."taskId"=t.id) AS "acceptanceCount",
 (SELECT count(*)::integer FROM factory_attempts a WHERE a."taskId"=t.id AND a.position>4) AS "postBaselineAttemptCount",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r.status NOT IN ('succeeded','completed','failed','stopped','cancelled')) AS "activeRuns",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r."leaseExpiresAt">clock_timestamp()) AS "activeLeases"
FROM factory_tasks t WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

-- Read-only selected subscription quota and exact catalogue eligibility.
-- Quota has only the public protocol fields (no credential/account/token columns).
WITH task_scope AS (
  SELECT id,"userId","issueId" FROM factory_tasks
  WHERE id='e42571e5-58f7-40e3-9418-c02ee8843fe6'::uuid
), sources AS (
  SELECT a.stage,r.id AS "runId",r."userId",
    r."agentDefinition"->>'model' AS model,
    r."agentDefinition"->>'harness' AS harness,
    r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS "workspaceId",
    r."agentDefinition"#>>'{subscription,bindingId}' AS "bindingId"
  FROM task_scope t JOIN factory_attempts a ON a."taskId"=t.id
  JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
  WHERE a.id IN ('41e41625-f1e2-4b2d-9d62-9fecbc4d62ae'::uuid,
                 'aa77cb0b-bb48-4c7a-ab73-ad68e7df7dba'::uuid)
)
SELECT clock_timestamp() AS "observedAt",s.stage,s."runId",s.model,s.harness,s."workspaceId",
  c.id AS "connectionId",c.provider,
  EXISTS(
    SELECT 1 FROM byos_bindings cb JOIN byos_connections cc
      ON cc.id=cb."connectionId" AND cc."ownerId"=cb."ownerId"
      AND cc.epoch=cb."connectionRevision" AND cc.state='connected' AND cc.paused=false
    WHERE cb."ownerId"=s."userId" AND cb."connectionId"=c.id AND cb."modelId"=s.model
      AND cb.route IN ('codex_cpa','claude_cpa','openai_siwc')
      AND (cc."modelCatalog" IS NULL OR cc."modelCatalog"->>'revision'<>cc.epoch::text
        OR cc."modelCatalog"->'models' ? cb."modelId")
  ) AS "exactOrderCandidateExists",
  jsonb_typeof(c.quota) AS "quotaType",
  c.quota ?& ARRAY['vendor','source','status','plan','windows','observedAt'] AS "quotaRequiredKeysPresent",
  jsonb_typeof(c.quota->'windows') AS "quotaWindowsType",
  CASE WHEN jsonb_typeof(c.quota->'windows')='array' THEN
    NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.quota->'windows') w
      WHERE NOT (w ?& ARRAY['kind','used','resetsAt'])) ELSE false END AS "quotaWindowsRequiredKeysPresent",
  jsonb_build_object(
    'vendor',c.quota->'vendor','source',c.quota->'source','status',c.quota->'status',
    'plan',c.quota->'plan','observedAt',c.quota->'observedAt',
    'windows',CASE WHEN jsonb_typeof(c.quota->'windows')='array' THEN
      (SELECT COALESCE(jsonb_agg(
        jsonb_build_object('kind',w->'kind','used',w->'used','resetsAt',w->'resetsAt')
        || CASE WHEN w ? 'model' THEN jsonb_build_object('model',w->'model') ELSE '{}'::jsonb END
        || CASE WHEN w ? 'meter' THEN jsonb_build_object('meter',w->'meter') ELSE '{}'::jsonb END
      ),'[]'::jsonb) FROM jsonb_array_elements(c.quota->'windows') w)
      ELSE 'null'::jsonb END
  ) AS "quotaSnapshot"
FROM sources s
LEFT JOIN byos_bindings b ON b.id::text=s."bindingId"
LEFT JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
ORDER BY s.stage;;

