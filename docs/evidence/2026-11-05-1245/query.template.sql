-- One bounded read-only verification. $OWNER_ID is substituted with the already authorized Owner ID.
-- No prompt, report, raw answer, session identifier, credential, token, or message text is returned.
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
WITH target AS MATERIALIZED (
  SELECT p.id AS project_id, p."userId" AS owner_id,
    EXISTS (SELECT 1 FROM issues i WHERE i.id='c866b8df-6ae9-44c6-a38b-0f527504f3f4'::uuid AND i."userId"=p."userId") AS issue_owned
  FROM workspace_projects p
  WHERE p.id='5034db32-324a-4fc9-b723-4e9da0286334'::uuid
  LIMIT 1
), scope AS MATERIALIZED (
  SELECT project_id, owner_id FROM target
  WHERE owner_id='$OWNER_ID' AND issue_owned
    AND current_database()='orvilo_mvp' AND current_setting('transaction_read_only')='on'
), chosen AS MATERIALIZED (
  SELECT d.id,d."ownerId",d."workspaceId",d."projectId",d."issueId",d."factoryTaskId",d."runId",
    d.kind,d."recordedAt",d."occurredAt",d.provenance,d."captureMode",d."recordStatus",
    d."recordedBy",d."decidedBy",d.options,d."selectedOptionId",d."contextOptionRef",
    d."predecessorDecisionIds",d."supersedesId",d."idempotencyKey",
    length(btrim(d.title))>0 AS title_present,
    length(btrim(d.summary))>0 AS summary_present,
    length(btrim(d.reason))>0 AS reason_present
  FROM scope s JOIN project_decisions d ON d."projectId"=s.project_id AND d."ownerId"=s.owner_id
  WHERE d."issueId"='c866b8df-6ae9-44c6-a38b-0f527504f3f4'::uuid
  ORDER BY d."recordedAt",d.id LIMIT 20
), decision_rows AS (
  SELECT d.id AS decision_id,d.kind,d."recordedAt" AS recorded_at,d."occurredAt" AS occurred_at,
    d.provenance,d."captureMode" AS capture_mode,d."recordStatus" AS record_status,
    d."runId" AS run_id,d."factoryTaskId" AS factory_task_id,d."selectedOptionId" AS selected_option_id,
    jsonb_build_object('decisionId',d."contextOptionRef"->>'decisionId','optionId',d."contextOptionRef"->>'optionId') AS context_option,
    d."predecessorDecisionIds" AS predecessor_ids,d."supersedesId" AS supersedes_id,
    jsonb_build_object(
      'kind',d."recordedBy"->>'kind','harness',d."recordedBy"->>'harness','model',d."recordedBy"->>'modelId',
      'identityAssurance',d."recordedBy"->>'identityAssurance',
      'runIdMatches',d."recordedBy"->>'runId'=d."runId"::text,
      'ownerMatches',d."recordedBy"->>'userId'=d."ownerId",
      'decidedByKind',d."decidedBy"->>'kind',
      'humanDeciderMatchesOwner',CASE WHEN d."decidedBy"->>'kind'='human' THEN d."decidedBy"->>'id'=d."ownerId" ELSE NULL END,
      'liveRunNamespaceMatches',CASE WHEN d."recordedBy"->>'kind'='agent' THEN d."idempotencyKey" LIKE ('run:'||d."runId"::text||':%') ELSE NULL END
    ) AS recorded_identity,
    jsonb_build_object(
      'titlePresent',d.title_present,'summaryPresent',d.summary_present,'reasonPresent',d.reason_present,
      'selectedOptionIsUnique',CASE WHEN d.kind IN ('choose','redirect') THEN
        (SELECT count(*)=1 FROM jsonb_array_elements(d.options) opt WHERE opt->>'id'=d."selectedOptionId" AND opt->>'disposition'='selected') ELSE NULL END,
      'options',COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',opt->>'id','disposition',opt->>'disposition','reasonPresent',length(btrim(COALESCE(opt->>'reason','')))>0,
        'stoppedAtSourceRef',opt->>'stoppedAtSourceRef'
      )) FROM jsonb_array_elements(d.options) opt),'[]'::jsonb)
    ) AS validated_fields,
    jsonb_build_object(
      'runPresent',r.id IS NOT NULL,'status',r.status,'startedAt',r."startedAt",'finishedAt',r."finishedAt",
      'hasNativeSession',NULLIF(r."sessionId",'') IS NOT NULL,
      'harness',r."agentDefinition"->>'harness','model',r."agentDefinition"->>'model',
      'modelSource',r."agentDefinition"->>'modelSource',
      'subscriptionRoute',r."agentDefinition"->'subscription'->>'route',
      'apiKeyPresent',COALESCE(r."agentDefinition"->'apiKey','null'::jsonb)<>'null'::jsonb,
      'nativeClaimPresent',n."runId" IS NOT NULL,
      'claimMatchesFrozenBinding',n."bindingId"::text=r."agentDefinition"->'subscription'->>'bindingId',
      'bindingRoute',b.route,'bindingModel',b."modelId",
      'bindingOwnerMatchesRun',b."ownerId"=r."userId",
      'bindingConsumerMatchesAgent',b."consumerId"=r."agentId"::text,
      'bindingWorkspaceMatchesDecision',b."workspaceId"::text=d."workspaceId"::text,
      'bindingModelMatchesFrozen',b."modelId"=r."agentDefinition"->>'model' AND b."modelId"=r."agentDefinition"->'subscription'->>'modelId',
      'recordedIdentityMatchesFrozen',d."recordedBy"->>'harness'=r."agentDefinition"->>'harness' AND d."recordedBy"->>'modelId'=r."agentDefinition"->>'model',
      'connectionProvider',bc.provider,'connectionPresent',bc.id IS NOT NULL,
      'recordedDuringRun',r."startedAt"<=d."recordedAt" AND (r."finishedAt" IS NULL OR d."recordedAt"<=r."finishedAt"),
      'attemptBoundToTask',EXISTS(SELECT 1 FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
        WHERE a."runId"=r.id AND a."taskId"=d."factoryTaskId" AND t."userId"=d."ownerId" AND t."issueId"=d."issueId"),
      'continuationQuestionId',r."questionContinuation"->>'questionId',
      'continuationOriginRunId',r."questionContinuation"->>'originRunId'
    ) AS runtime
  FROM chosen d
  LEFT JOIN agent_runs r ON r.id=d."runId" AND r."userId"=d."ownerId" AND r."issueId"=d."issueId"
  LEFT JOIN byos_native_runs n ON n."runId"=r.id
  LEFT JOIN byos_bindings b ON b.id=n."bindingId"
  LEFT JOIN byos_connections bc ON bc.id=b."connectionId" AND bc."ownerId"=b."ownerId"
), source_rows AS MATERIALIZED (
  SELECT s.id AS source_ref,d.id AS decision_id,s.role,s."optionId" AS option_id,
    s."sourceType" AS source_type,s."sourceId" AS source_id,s.relation,s."verifiedAt" AS verified_at,
    s.locator->>'runId' AS locator_run_id,s.locator->>'answerId' AS locator_answer_id,
    CASE WHEN q.id IS NOT NULL THEN jsonb_build_object(
      'questionId',q.id,'status',q.status,'kind',q.kind,'questionCreatedAt',q."createdAt",
      'originRunId',q."originRunId",'answerId',q."answerId",'answerSource',q."answerSource",'answeredAt',q."answeredAt",
      'currentContinuationRunId',q."continuationRunId",
      'sourceLocatorAnswerMatches',CASE WHEN s."sourceType"='answer' THEN s.locator->>'answerId'=q."answerId"::text ELSE NULL END,
      'humanAnswerOwnerMatches',q."answerSource" IN ('human','human_event') AND q.answer->>'userId'=q."userId" AND q.answer->>'source'=q."answerSource",
      'answerReferenceMatches',q.answer->'input'->>'answerId'=q."answerId"::text
        AND q.answer->'input'->'reference'->>'questionId'=q.id::text
        AND q.answer->'input'->'reference'->>'originRunId'=q."originRunId"::text
        AND q.answer->'input'->'reference'->'binding'->>'issueId'=q."issueId"::text
        AND q.answer->'input'->'reference'->'binding'->>'taskId'=q."taskId"::text,
      'humanDeciderMatchesAnswer',CASE WHEN d."decidedBy"->>'kind'='human' THEN d."decidedBy"->>'id'=q."userId" ELSE NULL END,
      'recordingRunContinuationMatches',rr."questionContinuation"->>'questionId'=q.id::text
        AND rr."questionContinuation"->>'originRunId'=q."originRunId"::text,
      'sameNativeSessionAsQuestionOrigin',NULLIF(rr."sessionId",'') IS NOT NULL
        AND rr."sessionId"=q."originSessionId" AND origin."sessionId"=q."originSessionId",
      'frozenHarnessModelAndSubscriptionUnchanged',rr."agentDefinition"->>'harness'=origin."agentDefinition"->>'harness'
        AND rr."agentDefinition"->>'model'=origin."agentDefinition"->>'model'
        AND rr."agentDefinition"->'subscription'=origin."agentDefinition"->'subscription',
      'recordingRunHasHostResumeReceipt',EXISTS(SELECT 1 FROM factory_events e WHERE e."taskId"=q."taskId"
        AND e.request->>'kind' IN ('question_resume','question_recover') AND e.result->>'continuationRunId'=rr.id::text),
      'answerPrecedesDecision',q."answeredAt"<=d."recordedAt",
      'sourceVerifiedAfterAnswer',CASE WHEN s."sourceType"='answer' THEN s."verifiedAt">=q."answeredAt" ELSE NULL END
    ) ELSE NULL END AS question_answer
  FROM chosen d JOIN project_decision_sources s ON s."decisionId"=d.id AND s."ownerId"=d."ownerId" AND s."workspaceId"=d."workspaceId"
  LEFT JOIN factory_questions q ON s."sourceType" IN ('question','answer') AND q.id::text=s."sourceId"
    AND q."userId"=d."ownerId" AND q."issueId"=d."issueId" AND q."taskId"=d."factoryTaskId"
  LEFT JOIN agent_runs rr ON rr.id=d."runId" AND rr."userId"=d."ownerId" AND rr."issueId"=d."issueId"
  LEFT JOIN agent_runs origin ON origin.id=q."originRunId" AND origin."userId"=d."ownerId" AND origin."issueId"=d."issueId"
  ORDER BY d."recordedAt",d.id,s."createdAt",s.id LIMIT 20
)
SELECT current_database() AS database_name,current_setting('transaction_read_only') AS transaction_read_only,
  statement_timestamp() AS observed_at,
  EXISTS(SELECT 1 FROM target) AS project_found,
  EXISTS(SELECT 1 FROM target WHERE owner_id='$OWNER_ID') AS project_owner_matches_authorized,
  COALESCE((SELECT issue_owned FROM target),false) AS issue_owner_matches_project,
  EXISTS(SELECT 1 FROM scope) AS exact_scope_confirmed,
  (SELECT count(*) FROM chosen) AS decision_count,(SELECT count(*)=20 FROM chosen) AS decision_limit_reached,
  (SELECT count(*) FROM source_rows) AS source_count,(SELECT count(*)=20 FROM source_rows) AS source_limit_reached,
  COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.recorded_at,d.decision_id) FROM decision_rows d),'[]'::jsonb) AS decisions,
  COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.verified_at,s.source_ref) FROM source_rows s),'[]'::jsonb) AS sources;
