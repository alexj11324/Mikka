-- Published evidence copy: Owner account ID redacted; do not execute this copy.
-- Fresh minimal before the second normal UI Retry review.
-- No provider refresh, model call or mutation; original snapshots remain intact.
SET TRANSACTION READ ONLY;

SET LOCAL statement_timeout='5s';

SELECT clock_timestamp() AS "observedAt",t.id AS "taskId",t."issueId",t."sourceEventId",t."botId",t.stage,t.status,t.revision,t."attemptId",t."candidateId",t.route->>'flowVersion' AS "flowVersion",
 c.kind,c.sha AS "candidateSha",c."runId" AS "producerRunId",p.report->>'deliverableCommit' AS "deliverableHead"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",id,stage,status,revision,"expiresAt","originRunId","originSessionId","attemptId","candidateId","waitingBinding",
 "answerId","answerSource","answerSourceEventId","answerFingerprint","answeredAt",answer IS NULL AS "answerNull",result IS NULL AS "resultNull","continuationRunId"
FROM factory_questions WHERE id='31b87a5f-7be6-49e9-9031-126dd2144007'
 AND "taskId"='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND "userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",e."eventId",e."createdAt",e.request,e.result->'task' AS "resultTask"
FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND e.request->>'kind'='owner_candidate_recheck' ORDER BY e."createdAt",e."eventId";

SELECT a.id AS "attemptId",a.position,a.stage,a.status AS "attemptStatus",a."candidateId",a."runId",
 r.status AS "runStatus",r."stopReason",r.error,r."sessionId",r."startedAt",r."finishedAt",r."leaseExpiresAt"
FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId" LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]'
 AND a.position>4 ORDER BY a.position;

SELECT clock_timestamp() AS "observedAt",
 (SELECT count(*)::integer FROM factory_events e WHERE e."taskId"=t.id AND e.request->>'kind'='owner_candidate_recheck') AS "ownerRecheckCount",
 (SELECT count(*)::integer FROM factory_deliverable_acceptances x WHERE x."taskId"=t.id) AS "acceptanceCount",
 (SELECT count(*)::integer FROM factory_attempts a WHERE a."taskId"=t.id AND a.position>4) AS "postBaselineAttemptCount",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r.status NOT IN ('succeeded','completed','failed','stopped','cancelled')) AS "activeRuns",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r."leaseExpiresAt">clock_timestamp()) AS "activeLeases"
FROM factory_tasks t WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",m."workspaceId",m.state AS "parentState",m."sandboxId" AS "parentSandboxId",m."runtimeReady",m."deviceId",m."lastActiveAt",d.enabled AS "deviceEnabled"
FROM cloud_machines m LEFT JOIN devices d ON d.id=m."deviceId"
WHERE m."workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' AND m."ownerId"='[owner-account-id-redacted]';

