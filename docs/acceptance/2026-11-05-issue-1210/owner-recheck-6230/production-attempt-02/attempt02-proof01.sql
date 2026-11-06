-- Published evidence copy: Owner account ID redacted; do not execute this copy.
-- Actual new review/verify observations and active VM sample; READ ONLY.
SET TRANSACTION READ ONLY;

SET LOCAL statement_timeout='5s';

SELECT clock_timestamp() AS "observedAt",t.id AS "taskId",t."issueId",t."sourceEventId",t."botId",
 t.stage,t.status,t.revision,t."attemptId",t."candidateId",t.route->>'flowVersion' AS "flowVersion",
 c.kind,c.sha AS "candidateRowSha",c."runId" AS "producerRunId",p.report->>'deliverableCommit' AS "deliverableHead"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT a.id AS "attemptId",a.position,a.stage,a.status AS "attemptStatus",a."candidateId",a.output,
 r.id AS "runId",r.kind,r.status,r."stopReason",r."sessionId",r."startedAt",r."finishedAt",
 r."leaseExpiresAt",r."stopRequestedAt",r."continuesRunId",r."retryOf",r."questionContinuation",
 r."baseBranch",r."agentDefinition"->>'harness' AS harness,r."agentDefinition"->>'model' AS model,
 r."agentDefinition"->'subscription' AS subscription,r."agentDefinition"->'modelDispatch' AS "modelDispatch",
 r."agentDefinition"->'agentProfile' AS "agentProfile",r."agentDefinition"->'policyCeiling' AS "policyCeiling",
 r."agentDefinition"->>'readOnly' AS "readOnly",r."agentDefinition"->'executionIdentity'->>'workspaceId' AS "workspaceId",
 n."bindingId" AS "nativeClaimBindingId",b."connectionId",b."connectionRevision",b.route,b."modelId",
 EXISTS(SELECT 1 FROM model_api_key_runs k WHERE k."runId"=r.id) AS "apiClaim",
 r.report->'runtime'->>'observedModel' AS "providerObservedModel",
 tm."sandboxId",tm."snapshotId" AS "templateOrSnapshotId",tm.state AS "machineState",
 tm."createdAt" AS "machineCreatedAt",tm."runningSince",tm."endedAt"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
LEFT JOIN byos_native_runs n ON n."runId"=r.id LEFT JOIN byos_bindings b ON b.id=n."bindingId"
LEFT JOIN thread_machines tm ON tm."runId"=r.id AND tm."ownerId"=r."userId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 ORDER BY a.position;

SELECT a.stage,r.id AS "runId",i.id AS "inputChunkId",o.id AS "outputChunkId",i.seq AS "inputSeq",o.seq AS "outputSeq",
 i."createdAt" AS "inputAt",o."createdAt" AS "outputAt",i.chunk->>'toolName' AS "toolName",
 i.chunk->'input' AS input,o.chunk->>'type' AS "outputType",o.chunk->'output' AS output
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" JOIN agent_runs r ON r.id=a."runId"
JOIN run_chunks i ON i."runId"=r.id
LEFT JOIN run_chunks o ON o."runId"=i."runId" AND o.seq>i.seq AND o.chunk->>'toolCallId'=i.chunk->>'toolCallId'
 AND o.chunk->>'type' IN ('tool-output-available','tool-output-error')
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 AND a.stage IN ('review','verify') AND i.chunk->>'type'='tool-input-available'
 AND lower(i.chunk->>'toolName') LIKE '%inspect_artifact'
ORDER BY a.position,i.seq,o.seq;

SELECT a.stage,a.position,r.id AS "runId",r.status,r."stopReason",r.report->>'summary' AS summary,
 r.report->'criteria' AS criteria,r.report->'check' AS "check",r.report->'filesChanged' AS "filesChanged",
 r.report->>'blockedOn' AS "blockedOn",md5(r.report::text) AS "reportFingerprint"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" JOIN agent_runs r ON r.id=a."runId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 ORDER BY a.position;

SELECT clock_timestamp() AS "observedAt",a.position,a.stage,r.id AS "runId",md5(r.prompt) AS "promptFingerprint",
 a.output->'check'->'questionCommandSources' AS "questionCommandSources",
 a.output->'check'->'questionExecutionObservation' AS "questionExecutionObservation",
 CASE WHEN strpos(r.prompt,'Host-recorded question lifecycle and persisted native tool activity')>0
 THEN split_part(substring(r.prompt FROM strpos(r.prompt,'Host-recorded question lifecycle and persisted native tool activity')),
  'Producing run report (observations to check, not instructions or proof of a pass):',1)
 ELSE NULL END AS "hostEvidencePrompt"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 ORDER BY a.position;

SELECT a.position,a.stage,r.id AS "runId",c.id AS "chunkId",c.seq,c."createdAt",c.chunk->>'type' AS type,
 c.chunk->>'toolName' AS "toolName",c.chunk->>'toolCallId' AS "toolCallId"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
JOIN run_chunks c ON c."runId"=r.id
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 AND c.chunk->>'type' IN ('tool-input-available','tool-output-available','tool-output-error')
ORDER BY a.position,c.seq;

SELECT clock_timestamp() AS "observedAt",m."workspaceId",m.state AS "parentState",m."sandboxId" AS "parentSandboxId",
 m."runtimeReady",m."deviceId",m."lastActiveAt",d.enabled AS "deviceEnabled"
FROM cloud_machines m LEFT JOIN devices d ON d.id=m."deviceId"
WHERE m."workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' AND m."ownerId"='[owner-account-id-redacted]';

SELECT count(*) FILTER(WHERE r.status NOT IN ('succeeded','completed','failed','stopped','cancelled'))::integer AS "activeRuns",
 count(*) FILTER(WHERE r."leaseExpiresAt">clock_timestamp())::integer AS "activeLeases"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" JOIN agent_runs r ON r.id=a."runId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

