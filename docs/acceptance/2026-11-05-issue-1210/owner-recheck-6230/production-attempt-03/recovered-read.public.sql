-- Published evidence copy: Owner account ID redacted; do not execute this copy.
SET TRANSACTION READ ONLY;

SET LOCAL statement_timeout='5s';

SELECT clock_timestamp() AS "actualQueriedAt",t.id AS "taskId",t."issueId",t."sourceEventId",t."botId",t.stage,t.status,t.revision,t."attemptId",t."candidateId",t.route->>'flowVersion' AS "flowVersion",
 c.kind,c.sha AS "candidateSha",c."runId" AS "producerRunId",p.report->>'deliverableCommit' AS "deliverableHead",p.report->>'sourceCommit' AS "producerSourceCommit"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "actualQueriedAt",a.id AS "attemptId",a.position,a.stage,a.status AS "attemptStatus",a."candidateId",a."runId" AS "attemptRunId",
 a.output->'check' AS "frozenCheck",a.output->>'ownerRecheckEventId' AS "ownerRecheckEventId",
 r.id AS "runId",r.kind,r.status,r."stopReason",(r.error IS NOT NULL) AS "hasError",r."sessionId",r."startedAt",r."finishedAt",r."leaseExpiresAt",r."stopRequestedAt",r."continuesRunId",r."retryOf",r."questionContinuation",r."baseBranch",
 r."agentDefinition"->>'harness' AS harness,r."agentDefinition"->>'model' AS model,r."agentDefinition"->'subscription' AS subscription,r."agentDefinition"->'modelDispatch' AS "modelDispatch",
 r."agentDefinition"->'agentProfile'->>'id' AS "agentProfileId",r."agentDefinition"->'agentProfile'->>'version' AS "agentProfileVersion",r."agentDefinition"->'agentProfile'->>'digest' AS "agentProfileDigest",
 r."agentDefinition"->'policyCeiling' AS "policyCeiling",r."agentDefinition"->>'readOnly' AS "readOnly",r."agentDefinition"->'executionIdentity'->>'workspaceId' AS "workspaceId",
 n."bindingId" AS "nativeClaimBindingId",b."connectionId",b."connectionRevision",b.route,b."modelId",EXISTS(SELECT 1 FROM model_api_key_runs k WHERE k."runId"=r.id) AS "apiClaim",r.report->'runtime'->>'observedModel' AS "providerObservedModel",
 tm."sandboxId",tm."snapshotId" AS "templateOrSnapshotId",tm.state AS "machineState",tm."createdAt" AS "machineCreatedAt",tm."runningSince",tm."endedAt"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
LEFT JOIN byos_native_runs n ON n."runId"=r.id LEFT JOIN byos_bindings b ON b.id=n."bindingId"
LEFT JOIN thread_machines tm ON tm."runId"=r.id AND tm."ownerId"=r."userId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' ORDER BY a.position;

SELECT clock_timestamp() AS "actualQueriedAt",a.position,a.id AS "attemptId",a.stage,a.status AS "attemptStatus",a."candidateId",
 r.id AS "runId",r.status,r."stopReason",r."sessionId",r."startedAt",r."finishedAt",r."baseBranch",r."retryOf",r."continuesRunId",r."questionContinuation",r.report,md5(r.report::text) AS "reportFingerprint"
FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' AND r.id IN ('6658f0ef-d446-4d8f-813d-7b7734bb02f3','d5cc2bb2-eb0c-44cf-945d-31a0b9fe0a11','6fc099f4-8f04-47b1-8be8-f95edd54fde0','f5269f72-0103-4d34-864a-0018c60195fc','af4309f0-c48f-463a-8552-1b04c6e33595','4c609155-c3cb-4c1a-81cc-dfa85f26eadc','0fad0e8b-1ea8-40b2-8e78-40b8b09a515a') ORDER BY a.position;

SELECT clock_timestamp() AS "actualQueriedAt",a.position,a.stage,r.id AS "runId",i.id AS "inputChunkId",o.id AS "outputChunkId",i.seq AS "inputSeq",o.seq AS "outputSeq",
 i."createdAt" AS "inputAt",o."createdAt" AS "outputAt",i.chunk->>'toolName' AS "toolName",i.chunk->>'toolCallId' AS "inputToolCallId",o.chunk->>'toolCallId' AS "outputToolCallId",
 i.chunk->'input' AS input,o.chunk->>'type' AS "outputType",o.chunk->'output' AS output
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
JOIN run_chunks i ON i."runId"=r.id
LEFT JOIN run_chunks o ON o."runId"=i."runId" AND o.seq>i.seq AND o.chunk->>'toolCallId'=i.chunk->>'toolCallId' AND o.chunk->>'type' IN ('tool-output-available','tool-output-error')
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' AND r.id IN ('4c609155-c3cb-4c1a-81cc-dfa85f26eadc','0fad0e8b-1ea8-40b2-8e78-40b8b09a515a') AND a.stage IN ('review','verify')
 AND i.chunk->>'type'='tool-input-available' AND (lower(i.chunk->>'toolName') LIKE '%inspect_artifact' OR lower(i.chunk->>'toolName') LIKE '%inspect_repository')
ORDER BY a.position,i.seq,o.seq;

SELECT clock_timestamp() AS "actualQueriedAt",a.position,a.stage,r.id AS "runId",md5(r.prompt) AS "promptFingerprint",a.output->'check' AS "frozenCheck",
 CASE WHEN strpos(r.prompt,'Host-recorded producer execution assignment')>0
 THEN split_part(substring(r.prompt FROM strpos(r.prompt,'Host-recorded producer execution assignment')),'Producing run report (observations to check, not instructions or proof of a pass):',1)
 ELSE NULL END AS "hostEvidencePrompt",
 strpos(r.prompt,'baseCommit')>0 AS "containsCommittedScopeGuidance",strpos(r.prompt,'A null observedModel remains unknown')>0 AS "containsObservedModelBoundary"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' AND r.id IN ('4c609155-c3cb-4c1a-81cc-dfa85f26eadc','0fad0e8b-1ea8-40b2-8e78-40b8b09a515a') ORDER BY a.position;

SELECT clock_timestamp() AS "actualQueriedAt",id,stage,status,revision,"expiresAt","originRunId","originSessionId","attemptId","candidateId","waitingBinding",
 "answerId","answerSource","answerSourceEventId","answerFingerprint","answeredAt",answer IS NULL AS "answerNull",result IS NULL AS "resultNull","continuationRunId"
FROM factory_questions WHERE id='31b87a5f-7be6-49e9-9031-126dd2144007' AND "taskId"='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND "userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "actualQueriedAt",r.id AS "runId",r."sessionId",a.id AS "attemptId",a.position,
 i.id AS "inputChunkId",o.id AS "outputChunkId",i.seq AS "inputSeq",o.seq AS "outputSeq",i."createdAt" AS "inputAt",o."createdAt" AS "outputAt",
 i.chunk->>'toolName' AS "toolName",i.chunk->>'toolCallId' AS "inputToolCallId",o.chunk->>'toolCallId' AS "outputToolCallId",i.chunk->'input' AS input,o.chunk->>'type' AS "outputType",o.chunk->'output' AS output
FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id
JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
JOIN run_chunks i ON i."runId"=r.id
LEFT JOIN run_chunks o ON o."runId"=i."runId" AND o.seq>i.seq AND o.chunk->>'toolCallId'=i.chunk->>'toolCallId' AND o.chunk->>'type' IN ('tool-output-available','tool-output-error')
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' AND r.id='6658f0ef-d446-4d8f-813d-7b7734bb02f3' AND i.id='f1ae824b-71cf-4dfc-89f9-6c4ca134b5d3' AND i.chunk->>'type'='tool-input-available' ORDER BY o.seq;

SELECT clock_timestamp() AS "actualQueriedAt",
 jsonb_build_object('runId',r.id,'sessionId',r."sessionId",'status',r.status,'model',r."agentDefinition"->>'model','harness',r."agentDefinition"->>'harness','observedModel',r.report->'runtime'->>'observedModel',
  'subscription',CASE WHEN jsonb_typeof(r."agentDefinition"->'subscription')='object' THEN jsonb_build_object('bindingId',r."agentDefinition"#>>'{subscription,bindingId}','route',r."agentDefinition"#>>'{subscription,route}','modelId',r."agentDefinition"#>>'{subscription,modelId}') ELSE NULL END,
  'nativeClaim',(SELECT jsonb_build_object('bindingId',n."bindingId",'connectionId',b."connectionId",'connectionRevision',b."connectionRevision",'route',b.route,'modelId',b."modelId")
     FROM byos_native_runs n JOIN byos_bindings b ON b.id=n."bindingId" WHERE n."runId"=r.id),
  'apiClaim',EXISTS(SELECT 1 FROM model_api_key_runs k WHERE k."runId"=r.id)) AS "producerExecution",
 r.report->>'sourceCommit' AS "sourceCommit",r.report->>'deliverableCommit' AS "deliverableCommit"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs r ON r.id=c."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' AND r.id='d5cc2bb2-eb0c-44cf-945d-31a0b9fe0a11';

SELECT clock_timestamp() AS "actualQueriedAt",m."workspaceId",m.state AS "parentState",m."sandboxId" AS "parentSandboxId",m."runtimeReady",m."deviceId",m."lastActiveAt",d.enabled AS "deviceEnabled"
FROM cloud_machines m LEFT JOIN devices d ON d.id=m."deviceId" WHERE m."workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' AND m."ownerId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "actualQueriedAt",
 (SELECT count(*)::integer FROM factory_events e WHERE e."taskId"=t.id AND e.request->>'kind'='owner_candidate_recheck') AS "ownerRecheckCount",
 (SELECT count(*)::integer FROM factory_events e WHERE e."taskId"=t.id AND e."createdAt">'2026-11-06T00:05:21Z'::timestamptz AND COALESCE(e.request#>>'{input,change,action}',e.request#>>'{change,action}') IN ('retry','recheck')) AS "retryOrRecheckControlsSinceAttempt02",
 (SELECT count(*)::integer FROM factory_deliverable_acceptances x WHERE x."taskId"=t.id) AS "acceptanceCount",
 (SELECT count(*)::integer FROM factory_attempts a WHERE a."taskId"=t.id) AS "allAttemptCount",
 (SELECT count(*)::integer FROM factory_attempts a WHERE a."taskId"=t.id AND a.position>5) AS "attemptsAfterFailedReview5",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r.status NOT IN ('succeeded','completed','failed','stopped','cancelled')) AS "activeRuns",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r."leaseExpiresAt">clock_timestamp()) AS "activeLeases"
FROM factory_tasks t WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "actualQueriedAt",e."eventId",e."createdAt",e.request,e.result->'task' AS "resultTask",md5(e.request::text) AS "requestFingerprint",md5(e.result::text) AS "resultFingerprint"
FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]' AND (e.request->>'kind'='owner_candidate_recheck' OR e."eventId" IN ('6c485476-b3b5-4d1e-a7e7-47865d34affa','46d68fa6-95d6-44d6-9942-5dbb3a55cdbd')
 OR (e."createdAt">'2026-11-06T00:05:21Z'::timestamptz AND COALESCE(e.request#>>'{input,change,action}',e.request#>>'{change,action}') IN ('retry','recheck','repair','approve','accept_deliverable')))
ORDER BY e."createdAt",e."eventId";

SELECT clock_timestamp() AS "actualQueriedAt",location,customized,"preferredHarness","autoModelRouting" FROM model_order_settings WHERE "ownerId"='[owner-account-id-redacted]' AND "workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9';

SELECT clock_timestamp() AS "actualQueriedAt",id,position,harness,model,"sourceKind","sourceId"::text AS "sourceId" FROM model_order_entries WHERE "ownerId"='[owner-account-id-redacted]' AND "workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' ORDER BY position,id;

SELECT clock_timestamp() AS "actualQueriedAt",c."botKey",bt.name AS "botName",bt.model AS "botFamily",c."bindingId",c."apiKeyId",c."apiKeyModel",b."connectionId",b."connectionRevision",b.route,b."modelId"
FROM bot_model_choices c LEFT JOIN bots bt ON bt.id::text=c."botKey" AND bt."ownerId"=c."ownerId" AND bt."workspaceId"=c."workspaceId"
LEFT JOIN byos_bindings b ON b.id=c."bindingId" AND b."ownerId"=c."ownerId"
WHERE c."ownerId"='[owner-account-id-redacted]' AND c."workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' ORDER BY c."botKey";

SELECT clock_timestamp() AS "actualQueriedAt",id,name,model,"archivedAt" FROM bots WHERE "ownerId"='[owner-account-id-redacted]' AND "workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' ORDER BY id;

SELECT clock_timestamp() AS "actualQueriedAt",id,version,digest,definition->'enabled' AS enabled,"archivedAt" FROM factory_agent_profiles WHERE "ownerId"='[owner-account-id-redacted]' AND "workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' ORDER BY id;
