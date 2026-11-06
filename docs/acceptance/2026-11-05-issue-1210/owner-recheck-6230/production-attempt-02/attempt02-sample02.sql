-- Published evidence copy: Owner account ID redacted; do not execute this copy.
-- Follow-up sample after internal start retry; no UI action.
SET TRANSACTION READ ONLY;

SET LOCAL statement_timeout='5s';

SELECT clock_timestamp() AS "observedAt",t.id AS "taskId",t."issueId",t."sourceEventId",t."botId",t.stage,t.status,t.revision,t."attemptId",t."candidateId",t.route->>'flowVersion' AS "flowVersion",
 c.kind,c.sha AS "candidateSha",c."runId" AS "producerRunId",p.report->>'deliverableCommit' AS "deliverableHead"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

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

