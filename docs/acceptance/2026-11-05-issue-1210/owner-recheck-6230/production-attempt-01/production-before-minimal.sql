-- Published SQL copy: the Owner account ID is redacted; do not execute this evidence copy.
-- Pre-click minimal before; READ ONLY. Deployment not asserted READY.
-- Requested at 2026-11-05T23:04:12.076Z
SET TRANSACTION READ ONLY;

SET LOCAL statement_timeout='5s';

SELECT clock_timestamp() AS "observedAt",t.id AS "taskId",t."issueId",t."sourceEventId",t."botId",
 t.stage,t.status,t.revision,t."attemptId",t."candidateId",t.route->>'flowVersion' AS "flowVersion",
 c.kind,c.sha AS "candidateSha",c."runId" AS "producerRunId",
 p.report->>'deliverableCommit' AS "deliverableHead",p.report->>'sourceCommit' AS "producerSourceCommit",p."baseBranch" AS "producerBaseBranch"
FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",id,stage,status,revision,"expiresAt","originRunId","originSessionId","attemptId","candidateId","waitingBinding",
 "answerId","answerSource","answerSourceEventId","answerFingerprint","answeredAt",answer IS NULL AS "answerNull",result IS NULL AS "resultNull","continuationRunId"
FROM factory_questions WHERE id='31b87a5f-7be6-49e9-9031-126dd2144007'
 AND "taskId"='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND "userId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",id,status,"stopReason","sessionId","startedAt","finishedAt",md5(report::text) AS "reportFingerprint",
 kind,"baseBranch","leaseExpiresAt","stopRequestedAt","retryOf","continuesRunId","questionContinuation"
FROM agent_runs WHERE "userId"='[owner-account-id-redacted]' AND "issueId"='0b9e6f79-790b-4931-aa54-2f45f5d142de'
 AND id IN ('6658f0ef-d446-4d8f-813d-7b7734bb02f3','6fc099f4-8f04-47b1-8be8-f95edd54fde0',
 'd5cc2bb2-eb0c-44cf-945d-31a0b9fe0a11','f5269f72-0103-4d34-864a-0018c60195fc') ORDER BY id;

SELECT clock_timestamp() AS "observedAt",m."workspaceId",m.state AS "parentState",m."sandboxId" AS "parentSandboxId",
 m."runtimeReady",m."deviceId",m."lastActiveAt",d.enabled AS "deviceEnabled"
FROM cloud_machines m LEFT JOIN devices d ON d.id=m."deviceId"
WHERE m."workspaceId"='887238ef-410c-4c65-bb08-cfa15e1f8ec9' AND m."ownerId"='[owner-account-id-redacted]';

SELECT clock_timestamp() AS "observedAt",
 (SELECT count(*)::integer FROM factory_events e WHERE e."taskId"=t.id AND e.request->>'kind'='owner_candidate_recheck') AS "ownerRecheckCount",
 (SELECT count(*)::integer FROM factory_deliverable_acceptances x WHERE x."taskId"=t.id) AS "acceptanceCount",
 (SELECT count(*)::integer FROM factory_attempts a WHERE a."taskId"=t.id AND a.position>4) AS "postBaselineAttemptCount",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
  WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r.status NOT IN ('succeeded','completed','failed','stopped','cancelled')) AS "activeRuns",
 (SELECT count(*)::integer FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
  WHERE a."taskId"=t.id AND r."userId"=t."userId" AND r."leaseExpiresAt">clock_timestamp()) AS "activeLeases"
FROM factory_tasks t
WHERE t.id='e42571e5-58f7-40e3-9418-c02ee8843fe6' AND t."userId"='[owner-account-id-redacted]';

