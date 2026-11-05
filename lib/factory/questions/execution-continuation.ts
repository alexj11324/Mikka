import type { PoolClient } from 'pg'
import type { FactoryTask } from '../store'
import { FactoryError } from '../contract'
import { factoryRunBotMatches } from '../run-scope'
import { factoryEventId } from '../event-id'
import { contextQuestionAnswerSchema, humanQuestionAnswerSchema, orchestratorMayAnswer, questionFingerprint, questionRecoverySchema } from './contract'

type Query = Pick<PoolClient, 'query'>
type Scope = Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'sourceEventId' | 'botId'>
type Question = {
  id: string; userId: string; issueId: string; taskId: string; attemptId: string; candidateId: string | null
  stage: string; status: string; revision: number; kind: string; originRunId: string; originSessionId: string
  waitingBinding: unknown; answerId: string | null; answerSource: string | null; answerSourceEventId: string | null
  answer: { source?: string; userId?: string; input?: unknown } | null; answerFingerprint: string | null
}

function verifiedAnswer(q: Question, scope: Scope, ownerEventMatches: boolean) {
  const source = q.answerSource
  const parsed = source === 'orchestrator'
    ? contextQuestionAnswerSchema.safeParse(q.answer?.input)
    : humanQuestionAnswerSchema.safeParse(q.answer?.input)
  if (!parsed.success || !['human', 'human_event', 'orchestrator'].includes(source ?? '') ||
    q.userId !== scope.userId || q.issueId !== scope.issueId || q.taskId !== scope.id ||
    q.answer?.source !== source || q.answer?.userId !== scope.userId ||
    !q.answerFingerprint || q.answerFingerprint !== questionFingerprint(q.answer) ||
    (source === 'orchestrator' && !orchestratorMayAnswer(q.kind as Parameters<typeof orchestratorMayAnswer>[0]))) return null
  const answer = parsed.data, reference = answer.reference
  if (answer.answerId !== q.answerId || reference.questionId !== q.id || reference.questionRevision > q.revision ||
    reference.originRunId !== q.originRunId || reference.originSessionId !== q.originSessionId ||
    reference.binding.taskId !== scope.id || reference.binding.issueId !== scope.issueId ||
    reference.binding.attemptId !== q.attemptId || reference.binding.candidateId !== q.candidateId ||
    questionFingerprint(reference.binding) !== questionFingerprint(q.waitingBinding) ||
    (source === 'human_event' && (!ownerEventMatches || !('sourceEventId' in answer) || answer.sourceEventId !== q.answerSourceEventId))) return null
  return answer
}

const ownerEvent = `EXISTS(SELECT 1 FROM coordinator_events e WHERE e.id=q."answerSourceEventId" AND e."userId"=q."userId"
  AND e.kind='user_message' AND (e."issueId" IS NULL OR e."issueId"=q."issueId")
  AND e."botId" IS NOT DISTINCT FROM t."botId" AND e.payload->>'humanSessionId' IS NOT NULL
  AND e.payload->>'text'=q.answer->'input'->>'text' AND e."createdAt">=q."createdAt"
  AND (e.payload->>'questionId' IS NULL OR e.payload->>'questionId'=q.id::text))`

export type QuestionExecutionContinuation = {
  kind: 'question_resume' | 'question_recover'
  originAttemptId: string
  continuationAttemptId: string
  questionOriginAttemptId: string
  sourceRunId: string
  continuationRunId: string
  questionOriginRunId: string
  originSessionId: string
  questionId: string
  answerId: string
  recoveryEventId: string
}

/** Only immutable host receipts establish execution continuity. This proves
 * attribution, not successful native resume or command execution: a queued
 * child has no actual SID yet. Evidence consumers must additionally validate
 * actual sessions, observation times and the fixed candidate independently.
 * Normal cloud resumes leave continuesRunId empty; only their validated
 * question_resume receipt may bind the direct question origin instead. */
export async function questionExecutionContinuation(tx: Query, scope: Scope, continuationAttemptId: string): Promise<QuestionExecutionContinuation | null> {
  const { rows } = await tx.query(`SELECT to_jsonb(q) AS question, ${ownerEvent} AS "ownerEventMatches",
    e."eventId",e.request,e.result,pa.id AS "childAttemptId",sa.id AS "sourceAttemptId",oa.id AS "questionOriginAttemptId",
    p.id AS "childRunId",s.id AS "sourceRunId",p."botId" AS "childBotId",s."botId" AS "sourceBotId",o."botId" AS "originBotId",p."questionContinuation" AS "childContinuation",s."questionContinuation" AS "sourceContinuation"
    FROM factory_tasks t JOIN factory_attempts pa ON pa."taskId"=t.id AND pa.id=$6 AND pa.stage='execute'
    JOIN agent_runs p ON p.id=pa."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
    JOIN factory_questions q ON q.id::text=p."questionContinuation"->>'questionId'
      AND q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId" AND q.stage='execute'
    JOIN factory_events e ON e."taskId"=t.id AND e.request->>'kind' IN ('question_resume','question_recover') AND e.result->>'continuationRunId'=p.id::text
    JOIN agent_runs s ON s.id=CASE
      WHEN e.request->>'kind'='question_resume' AND p."continuesRunId" IS NULL THEN q."originRunId"
      ELSE p."continuesRunId" END AND s."userId"=t."userId" AND s."issueId"=t."issueId"
    JOIN factory_attempts sa ON sa."taskId"=t.id AND sa."runId"=s.id AND sa.stage='execute' AND sa.position+1=pa.position
    JOIN agent_runs o ON o.id=q."originRunId" AND o."userId"=t."userId" AND o."issueId"=t."issueId"
    JOIN factory_attempts oa ON oa.id=q."attemptId" AND oa."taskId"=t.id AND oa."runId"=o.id AND oa.stage='execute' AND oa.position<=sa.position
    LEFT JOIN computer_run_bindings pc ON pc."runId"=p.id LEFT JOIN computer_run_bindings sc ON sc."runId"=s.id
    JOIN devices d ON d.id=p."deviceId" AND d."ownerId"=t."userId"
    LEFT JOIN byos_bindings b ON b.id::text=p."agentDefinition"->'subscription'->>'bindingId'
    LEFT JOIN byos_connections bc ON bc.id=b."connectionId" AND bc."ownerId"=b."ownerId" AND bc.epoch=b."connectionRevision"
    LEFT JOIN byos_native_runs pn ON pn."runId"=p.id LEFT JOIN byos_native_runs sn ON sn."runId"=s.id
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND t."sourceEventId"=$4 AND t."botId" IS NOT DISTINCT FROM $5::uuid
      AND q.status IN ('answered','resuming','resolved','blocked') AND q."candidateId" IS NULL
      AND p.kind='implement' AND s.kind='implement' AND p."retryOf" IS NULL AND s."retryOf" IS NULL
      AND s."stopRequestedAt" IS NULL AND o."stopRequestedAt" IS NULL AND o.status='stopped'
      AND s."sessionId"=q."originSessionId" AND o."sessionId"=q."originSessionId"
      AND s."deviceId"=p."deviceId" AND s."deviceRepoId"=p."deviceRepoId" AND s."agentId"=p."agentId"
      AND s."baseBranch" IS NOT DISTINCT FROM p."baseBranch"
      AND o."deviceId"=p."deviceId" AND o."deviceRepoId"=p."deviceRepoId" AND o."agentId"=p."agentId"
      AND o."baseBranch" IS NOT DISTINCT FROM p."baseBranch"
      AND p."agentDefinition"->>'definitionDigest' IS NOT NULL AND p."agentDefinition"->>'definitionDigest'<>''
      AND s."agentDefinition"->>'definitionDigest'=p."agentDefinition"->>'definitionDigest'
      AND s."agentDefinition"->>'harness' IS NOT DISTINCT FROM p."agentDefinition"->>'harness' AND s."agentDefinition"->>'model' IS NOT DISTINCT FROM p."agentDefinition"->>'model'
      AND s."agentDefinition"->'subscription' IS NOT DISTINCT FROM p."agentDefinition"->'subscription'
      AND s."agentDefinition"->'apiKey' IS NOT DISTINCT FROM p."agentDefinition"->'apiKey'
      AND o."agentDefinition"->>'definitionDigest'=p."agentDefinition"->>'definitionDigest'
      AND o."agentDefinition"->>'harness' IS NOT DISTINCT FROM p."agentDefinition"->>'harness' AND o."agentDefinition"->>'model' IS NOT DISTINCT FROM p."agentDefinition"->>'model'
      AND o."agentDefinition"->'subscription' IS NOT DISTINCT FROM p."agentDefinition"->'subscription'
      AND o."agentDefinition"->'apiKey' IS NOT DISTINCT FROM p."agentDefinition"->'apiKey'
      AND ((COALESCE(p."agentDefinition"->'subscription','null'::jsonb)='null'::jsonb AND e.request->>'kind'='question_resume') OR
        (b."ownerId"=t."userId" AND b."consumerId"=p."agentId"::text
          AND (pc."runId" IS NULL OR b."workspaceId"=pc."workspaceId"::text)
          AND b."modelId"=p."agentDefinition"->>'model' AND b."modelId"=p."agentDefinition"->'subscription'->>'modelId'
          AND b.route=p."agentDefinition"->'subscription'->>'route'
          AND b.route=CASE p."agentDefinition"->>'harness' WHEN 'codex' THEN 'codex_cli' WHEN 'claude_code' THEN 'claude_code_cli' END
          AND bc.provider=CASE p."agentDefinition"->>'harness' WHEN 'codex' THEN 'codex' WHEN 'claude_code' THEN 'claude' END
          AND (pn."runId" IS NULL OR pn."bindingId"=b.id) AND (sn."runId" IS NULL OR sn."bindingId"=b.id)
          AND (e.request->>'kind'='question_resume' OR sn."bindingId"=b.id)))
      AND sa."candidateId" IS NULL AND oa."candidateId" IS NULL
      AND COALESCE(pa.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND COALESCE(sa.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND COALESCE(oa.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND ((pc."runId" IS NULL AND sc."runId" IS NULL AND d.kind='local' AND e.request->>'kind'='question_resume')
        OR (pc."ownerId"=t."userId" AND sc."ownerId"=pc."ownerId" AND sc."workspaceId"=pc."workspaceId"
          AND pc."botId" IS NOT DISTINCT FROM sc."botId"
          AND (t."botId" IS NULL OR EXISTS(SELECT 1 FROM bots chat WHERE chat.id=t."botId" AND chat."ownerId"=t."userId" AND chat."workspaceId"=pc."workspaceId"))
          AND EXISTS(SELECT 1 FROM bots runtime WHERE runtime.id=pc."botId" AND runtime."ownerId"=pc."ownerId" AND runtime."workspaceId"=pc."workspaceId")))
      AND ((e.request->>'kind'='question_resume' AND s.id=o.id AND sa.id=oa.id AND s.status='stopped')
        OR (e.request->>'kind'='question_recover' AND s.status='failed' AND oa.position<sa.position
          AND (s."stopReason" IS NULL OR s."stopReason" NOT IN ('cancelled','revoked'))))`,
  [scope.id, scope.userId, scope.issueId, scope.sourceEventId, scope.botId, continuationAttemptId])
  if (rows.length !== 1) return null
  const row = rows[0], q = row.question as Question
  for (const run of [{ id: row.childRunId, botId: row.childBotId }, { id: row.sourceRunId, botId: row.sourceBotId }, { id: q.originRunId, botId: row.originBotId }])
    if (!(await factoryRunBotMatches(tx, scope, run))) return null
  const answer = verifiedAnswer(q, scope, row.ownerEventMatches)
  const saved = row.result?.task
  const linkMatches = (value: Record<string, unknown> | null) => value?.questionId === q.id && value.originRunId === q.originRunId &&
    value.originSessionId === q.originSessionId && value.requireSessionResume === true
  if (!answer || !linkMatches(row.childContinuation) || row.request?.userId !== scope.userId ||
    row.result?.questionId !== q.id || row.result.continuationRunId !== row.childRunId ||
    row.result.originRunId !== q.originRunId || row.result.originSessionId !== q.originSessionId ||
    saved?.id !== scope.id || saved.userId !== scope.userId || saved.issueId !== scope.issueId || saved.botId !== scope.botId ||
    saved.sourceEventId !== scope.sourceEventId || saved.attemptId !== row.childAttemptId || saved.stage !== 'execute' ||
    saved.status !== 'running' || saved.candidateId !== null || !Number.isInteger(saved.revision)) return null
  const kind = row.request.kind as QuestionExecutionContinuation['kind']
  if (kind === 'question_resume') {
    if (row.eventId !== factoryEventId('question-resume', answer.answerId) || row.request.source !== q.answerSource ||
      questionFingerprint(row.request.input) !== questionFingerprint(answer) ||
      row.result.answerId !== answer.answerId || row.result.answerFingerprint !== q.answerFingerprint ||
      row.result.originAttemptId !== q.attemptId || saved.revision <= answer.reference.binding.revision) return null
  } else {
    const parsed = questionRecoverySchema.safeParse(row.request.input)
    if (!parsed.success || !linkMatches(row.sourceContinuation)) return null
    const recovery = parsed.data, reference = recovery.reference
    if (row.eventId !== factoryEventId('question-recover', recovery.requestId) ||
      recovery.expectedFailedRunId !== row.sourceRunId || row.result.historyRunId !== row.sourceRunId ||
      reference.questionId !== q.id || reference.originRunId !== q.originRunId || reference.originSessionId !== q.originSessionId ||
      reference.questionRevision > q.revision || reference.binding.taskId !== scope.id || reference.binding.issueId !== scope.issueId ||
      reference.binding.attemptId !== row.sourceAttemptId || reference.binding.candidateId !== null || saved.revision <= reference.binding.revision) return null
  }
  return { kind, originAttemptId: row.sourceAttemptId, continuationAttemptId: row.childAttemptId,
    questionOriginAttemptId: row.questionOriginAttemptId, sourceRunId: row.sourceRunId, continuationRunId: row.childRunId,
    questionOriginRunId: q.originRunId, originSessionId: q.originSessionId, questionId: q.id,
    answerId: answer.answerId, recoveryEventId: row.eventId }
}

/** Before the child exists, the verified answer and the host retry event
 * identify the one original execution being queued. No input flag grants a
 * frozen Profile exception, and the native definition must stay unchanged. */
export async function questionExecutionQueueSource(tx: Query, input: {
  userId: string; issueId: string; botId: string | null; sourceRunId: string
}): Promise<string | null> {
  const { rows } = await tx.query(`SELECT to_jsonb(q) AS question,to_jsonb(t) AS task,${ownerEvent} AS "ownerEventMatches",
      r.id AS "runId",r."botId" AS "runBotId",e."eventId",e.request,e.result
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    JOIN factory_questions q ON q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId"
    JOIN factory_attempts previous ON previous.id=q."attemptId" AND previous."taskId"=t.id AND previous.position+1=a.position
    JOIN agent_runs r ON r.id=q."originRunId" AND r.id=previous."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN factory_events e ON e."taskId"=t.id AND e.request->'change'->>'action'='retry' AND e.result->'task'->>'attemptId'=a.id::text
    WHERE t."userId"=$1 AND t."issueId"=$2 AND t."botId" IS NOT DISTINCT FROM $3::uuid AND r.id=$4
      AND t.stage='execute' AND a.stage='execute' AND t.status='pending' AND a.status='pending' AND a."runId" IS NULL
      AND q.stage='execute' AND q.status='answered' AND q."candidateId" IS NULL AND t."candidateId" IS NULL
      AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp())
      AND r.status='stopped' AND r."stopRequestedAt" IS NULL AND r."startedAt" IS NOT NULL
      AND NULLIF(r."sessionId",'')=q."originSessionId"
      AND COALESCE(previous.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
    FOR SHARE OF t,a,q,previous,r,e`, [input.userId,input.issueId,input.botId,input.sourceRunId])
  if (rows.length !== 1) return null
  const row = rows[0], q = row.question as Question, task = row.task as FactoryTask, saved = row.result?.task
  if (!verifiedAnswer(q,task,row.ownerEventMatches) || row.eventId !== factoryEventId('question-next-attempt',q.id) ||
      row.request.binding?.taskId !== task.id || saved?.id !== task.id || saved.userId !== task.userId ||
      saved.issueId !== task.issueId || saved.botId !== task.botId || saved.sourceEventId !== task.sourceEventId ||
      saved.attemptId !== task.attemptId || saved.revision !== task.revision || saved.stage !== 'execute' || saved.status !== 'pending' ||
      !(await factoryRunBotMatches(tx,task,{id:row.runId,botId:row.runBotId}))) return null
  return row.runId as string
}

/** Only the answer/recover transaction can reach the transient answered state.
 * Re-read its locked authority before the store creates a continuation attempt;
 * an event ID, reason string or client-provided boolean is never an exemption. */
export async function assertQuestionExecutionRetry(tx: PoolClient, task: FactoryTask, questionId: string) {
  const { rows: [row] } = await tx.query(`SELECT to_jsonb(q) AS question,${ownerEvent} AS "ownerEventMatches",r.id AS "runId",
      r."questionContinuation" AS continuation,r."botId" AS "runBotId",o."botId" AS "originBotId",q."continuationRunId",q."originRunId"
    FROM factory_tasks t JOIN factory_questions q ON q."taskId"=t.id AND q.id=$6 AND q."userId"=t."userId" AND q."issueId"=t."issueId"
    JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a.stage=t.stage
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN agent_runs o ON o.id=q."originRunId" AND o."userId"=t."userId" AND o."issueId"=t."issueId"
    JOIN factory_attempts oa ON oa.id=q."attemptId" AND oa."taskId"=t.id AND oa."runId"=o.id
    LEFT JOIN computer_run_bindings rc ON rc."runId"=r.id LEFT JOIN computer_run_bindings oc ON oc."runId"=o.id
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=t."userId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND t."sourceEventId"=$4 AND t."botId" IS NOT DISTINCT FROM $5::uuid
      AND t."attemptId"=$7 AND t.revision=$8 AND t.stage=q.stage AND t."candidateId" IS NOT DISTINCT FROM q."candidateId"
      AND q.status='answered' AND q."answerId" IS NOT NULL AND q."answerFingerprint" IS NOT NULL
      AND r."stopRequestedAt" IS NULL AND o."stopRequestedAt" IS NULL AND o.status='stopped'
      AND r."sessionId"=q."originSessionId" AND o."sessionId"=q."originSessionId"
      AND r."deviceId"=o."deviceId" AND r."deviceRepoId"=o."deviceRepoId" AND r."agentId"=o."agentId" AND r."baseBranch" IS NOT DISTINCT FROM o."baseBranch"
      AND r."agentDefinition"->>'definitionDigest'=o."agentDefinition"->>'definitionDigest' AND COALESCE(r."agentDefinition"->>'definitionDigest','')<>''
      AND r."agentDefinition"->>'harness' IS NOT DISTINCT FROM o."agentDefinition"->>'harness' AND r."agentDefinition"->>'model' IS NOT DISTINCT FROM o."agentDefinition"->>'model'
      AND r."agentDefinition"->'subscription' IS NOT DISTINCT FROM o."agentDefinition"->'subscription'
      AND r."agentDefinition"->'apiKey' IS NOT DISTINCT FROM o."agentDefinition"->'apiKey'
      AND COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND COALESCE(oa.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND ((r.id=q."originRunId" AND a.id=q."attemptId" AND r.status='stopped') OR (r.id=q."continuationRunId" AND r.status='failed' AND oa.position<a.position))
      AND ((rc."runId" IS NULL AND oc."runId" IS NULL AND d.kind='local') OR
        (rc."ownerId"=t."userId" AND oc."ownerId"=rc."ownerId" AND oc."workspaceId"=rc."workspaceId"
          AND rc."botId" IS NOT DISTINCT FROM oc."botId"
          AND (t."botId" IS NULL OR EXISTS(SELECT 1 FROM bots chat WHERE chat.id=t."botId" AND chat."ownerId"=t."userId" AND chat."workspaceId"=rc."workspaceId"))
          AND EXISTS(SELECT 1 FROM bots runtime WHERE runtime.id=rc."botId" AND runtime."ownerId"=rc."ownerId" AND runtime."workspaceId"=rc."workspaceId"))) FOR UPDATE OF q,a,r,o`,
  [task.id, task.userId, task.issueId, task.sourceEventId, task.botId, questionId, task.attemptId, task.revision])
  if (!row || !verifiedAnswer(row.question, task, row.ownerEventMatches)) throw new FactoryError('factoryQuestionContinuationUnavailable')
  const q = row.question as Question, link = row.continuation
  if (!(await factoryRunBotMatches(tx, task, { id: row.runId, botId: row.runBotId })) ||
    !(await factoryRunBotMatches(tx, task, { id: q.originRunId, botId: row.originBotId }))) throw new FactoryError('factoryQuestionContinuationUnavailable')
  if (row.runId !== q.originRunId && (link?.questionId !== q.id || link.originRunId !== q.originRunId || link.originSessionId !== q.originSessionId || link.requireSessionResume !== true))
    throw new FactoryError('factoryQuestionContinuationUnavailable')
  return row.runId as string
}
