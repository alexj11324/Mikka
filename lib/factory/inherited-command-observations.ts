import type { PoolClient } from 'pg'
import type { FactoryTask } from './store'
import { factoryEventId } from './event-id'
import { readDeliverableSnapshotReceipt } from './deliverable-snapshot'
import { humanQuestionAnswerSchema, questionFingerprint, questionRecoverySchema } from './questions/contract'
import { redactArtifact } from './evidence'

type Query = Pick<PoolClient, 'query'>
type Task = Pick<FactoryTask, 'id' | 'userId' | 'issueId'>
type Candidate = { id: string; executionSha: string; producerExecution: { runId: string; sessionId: string } }
type Observation = {
  inherited: true
  sourceRunId: string
  sourceSessionId: string
  sourceStatus: 'failed'
  sourceStopReason: string | null
  recoveryEventId: string
  snapshotRecoveryEventId: string
  questionId: string
  answerId: string
  requestEpoch: string
  candidateSha: string
  inputChunkId: string
  outputChunkId: string
  seq: number
  toolName: string
  inputObservedAt: string
  observedAt: string
  outputType: string
  input: unknown
  output: unknown
}
const empty = () => ({ records: [] as Observation[], omitted: false })
const time = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN

/** A direct host-recorded question recovery may expose its prior turn's tool
 * observations. This never turns them into the current producer's commands or
 * a pass, and never follows recursive, repair or same-SID-only ancestry.
 * The internal recovery followUp is not an owner answer or an acceptance rule. */
export async function inheritedCommandObservations(tx: Query, task: Task, candidate: Candidate): Promise<{ records: Observation[]; omitted: boolean }> {
  const receipt = await readDeliverableSnapshotReceipt(tx, task, candidate.id)
  const legacy = receipt?.scope.legacyQuestionSubmission
  const producer = candidate.producerExecution
  if (!receipt || !legacy || receipt.snapshot.head !== candidate.executionSha ||
    receipt.scope.producerRunId !== producer.runId || receipt.scope.producerSessionId !== producer.sessionId) return empty()

  const { rows } = await tx.query(`SELECT t."sourceEventId",t."botId",
      p.id AS "producerRunId",p."sessionId" AS "producerSessionId",p."questionContinuation" AS "producerContinuation",
      p."agentDefinition"->>'definitionDigest' AS "producerDefinitionDigest",p."agentDefinition"->'subscription' AS "producerSubscription",
      p."agentDefinition"->>'harness' AS harness,p."agentDefinition"->>'model' AS model,p."startedAt" AS "producerStartedAt",
      s.id AS "sourceRunId",s."sessionId" AS "sourceSessionId",s."questionContinuation" AS "sourceContinuation",s."stopReason" AS "sourceStopReason",
      s."agentDefinition"->>'definitionDigest' AS "sourceDefinitionDigest",s."agentDefinition"->'subscription' AS "sourceSubscription",
      s."startedAt" AS "sourceStartedAt",s."finishedAt" AS "sourceFinishedAt",
      pa.id AS "producerAttemptId",pa.position AS "producerPosition",sa.id AS "sourceAttemptId",sa.position AS "sourcePosition",
      q.id AS "questionId",q.revision AS "questionRevision",q."attemptId" AS "originAttemptId",q."candidateId" AS "questionCandidateId",
      q."originRunId",q."originSessionId",q."waitingBinding",q."answerId",q."answerSource",q."answerSourceEventId",q.answer,q."answerFingerprint",q."answeredAt",
      e."eventId" AS "recoveryEventId",e."createdAt" AS "recoveryCreatedAt",e.request,e.result,
      b.id AS "bindingId",b.route,b."modelId",
      EXISTS(SELECT 1 FROM coordinator_events owner_event WHERE owner_event.id=q."answerSourceEventId" AND owner_event."userId"=t."userId"
        AND owner_event.kind='user_message' AND (owner_event."issueId" IS NULL OR owner_event."issueId"=t."issueId")
        AND owner_event."botId" IS NOT DISTINCT FROM t."botId" AND owner_event.payload->>'humanSessionId' IS NOT NULL
        AND owner_event.payload->>'text'=q.answer->'input'->>'text' AND owner_event."createdAt">=q."createdAt"
        AND (owner_event.payload->>'questionId' IS NULL OR owner_event.payload->>'questionId'=q.id::text)) AS "ownerEventMatches"
    FROM factory_tasks t JOIN factory_candidates c ON c."taskId"=t.id AND c.id=t."candidateId"
    JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
    JOIN agent_runs s ON s.id=p."continuesRunId" AND s."userId"=t."userId" AND s."issueId"=t."issueId"
    JOIN factory_attempts pa ON pa."taskId"=t.id AND pa."runId"=p.id AND pa.stage='execute'
    JOIN factory_attempts sa ON sa."taskId"=t.id AND sa."runId"=s.id AND sa.stage='execute' AND sa.position+1=pa.position
    JOIN factory_questions q ON q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId" AND q."continuationRunId"=p.id
    JOIN agent_runs origin ON origin.id=q."originRunId" AND origin."userId"=t."userId" AND origin."issueId"=t."issueId"
    JOIN factory_attempts oa ON oa.id=q."attemptId" AND oa."taskId"=t.id AND oa."runId"=origin.id AND oa.stage='execute' AND oa.position<sa.position
    JOIN factory_events e ON e."taskId"=t.id AND e.request->>'kind'='question_recover' AND e.result->>'continuationRunId'=p.id::text
    JOIN computer_run_bindings pc ON pc."runId"=p.id AND pc."ownerId"=t."userId" AND pc."botId" IS NOT DISTINCT FROM t."botId"
    JOIN computer_run_bindings sc ON sc."runId"=s.id AND sc."ownerId"=pc."ownerId" AND sc."workspaceId"=pc."workspaceId" AND sc."botId" IS NOT DISTINCT FROM pc."botId"
    JOIN byos_native_runs pn ON pn."runId"=p.id
    JOIN byos_native_runs sn ON sn."runId"=s.id AND sn."bindingId"=pn."bindingId"
    JOIN byos_bindings b ON b.id=pn."bindingId" AND b."ownerId"=t."userId"
      AND b."workspaceId"=pc."workspaceId"::text AND b."consumerId"=p."agentId"::text
    JOIN byos_connections connection ON connection.id=b."connectionId" AND connection."ownerId"=b."ownerId" AND connection.epoch=b."connectionRevision"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND c.id=$4 AND c.kind='deliverable'
      AND t.stage IN ('review','verify') AND p.id=$5 AND p."sessionId"=$6
      AND q.id=$7 AND s.id=$8 AND pc."workspaceId"::text=$9 AND p."worktreePath"=$10
      AND p.status='succeeded' AND p."stopReason"='submitted' AND p."stopRequestedAt" IS NULL AND p."retryOf" IS NULL AND p.kind='implement'
      AND s.status='failed' AND s."stopRequestedAt" IS NULL AND s."retryOf" IS NULL AND s.kind='implement'
      AND (s."stopReason" IS NULL OR s."stopReason" NOT IN ('cancelled','revoked'))
      AND origin.status='stopped' AND origin."stopRequestedAt" IS NULL AND origin."sessionId"=q."originSessionId"
      AND q.status='resolved' AND q.stage='execute' AND q."candidateId" IS NULL AND q."originSessionId"=p."sessionId" AND s."sessionId"=p."sessionId"
      AND pa."candidateId" IS NULL AND sa."candidateId" IS NULL
      AND pa.status='blocked' AND sa.status='blocked' AND pa."sessionId"=p."sessionId" AND sa."sessionId"=s."sessionId"
      AND (pa.output->>'requestEpoch' IS NULL OR pa.output->>'requestEpoch'=t."sourceEventId"::text)
      AND (sa.output->>'requestEpoch' IS NULL OR sa.output->>'requestEpoch'=t."sourceEventId"::text)
      AND p."botId" IS NOT DISTINCT FROM t."botId" AND s."botId" IS NOT DISTINCT FROM t."botId"
      AND s."deviceId"=p."deviceId" AND s."deviceRepoId"=p."deviceRepoId" AND s."agentId"=p."agentId"
      AND s."baseBranch" IS NOT DISTINCT FROM p."baseBranch" AND s."worktreePath"=p."worktreePath"
      AND p."agentDefinition"->>'harness' IN ('codex','claude_code') AND s."agentDefinition"->>'harness'=p."agentDefinition"->>'harness'
      AND s."agentDefinition"->>'model'=p."agentDefinition"->>'model'
      AND COALESCE(s."agentDefinition"->'policy'->>'readOnly','false')<>'true' AND COALESCE(s."agentDefinition"->>'readOnly','false')<>'true'
      AND connection.provider=CASE WHEN p."agentDefinition"->>'harness'='codex' THEN 'codex' ELSE 'claude' END`,
    [task.id, task.userId, task.issueId, candidate.id, producer.runId, producer.sessionId, legacy.questionId, legacy.continuesRunId, receipt.scope.workspaceId, receipt.scope.worktreePath])
  if (rows.length !== 1) return empty()
  const row = rows[0]
  const recovered = row.result, savedTask = recovered?.task
  const recovery = questionRecoverySchema.safeParse(row.request?.input)
  const parsedAnswer = humanQuestionAnswerSchema.safeParse(row.answer?.input)
  const linkMatches = (value: Record<string, unknown> | null | undefined) => !!value && value.questionId === row.questionId &&
    value.originRunId === row.originRunId && value.originSessionId === row.originSessionId && value.requireSessionResume === true
  if (!recovery.success || !parsedAnswer.success || row.request?.userId !== task.userId ||
    row.recoveryEventId !== factoryEventId('question-recover', recovery.data.requestId) ||
    !linkMatches(row.producerContinuation) || !linkMatches(row.sourceContinuation) ||
    recovered?.questionId !== row.questionId || recovered.continuationRunId !== producer.runId ||
    recovered.historyRunId !== row.sourceRunId || recovered.originRunId !== row.originRunId || recovered.originSessionId !== producer.sessionId ||
    savedTask?.id !== task.id || savedTask.userId !== task.userId || savedTask.issueId !== task.issueId ||
    savedTask.sourceEventId !== row.sourceEventId || savedTask.sourceEventId !== receipt.scope.sourceEventId ||
    savedTask.attemptId !== row.producerAttemptId || savedTask.stage !== 'execute' || savedTask.status !== 'running' || savedTask.candidateId !== null ||
    !Number.isInteger(savedTask.revision) || savedTask.revision <= recovery.data.reference.binding.revision ||
    recovery.data.expectedFailedRunId !== row.sourceRunId || recovery.data.reference.questionId !== row.questionId ||
    recovery.data.reference.originRunId !== row.originRunId || recovery.data.reference.originSessionId !== producer.sessionId ||
    recovery.data.reference.questionRevision > row.questionRevision ||
    // FactoryBinding intentionally carries no stage; its exact attempt is
    // joined above with stage='execute', as are the question and producer.
    recovery.data.reference.binding.taskId !== task.id || recovery.data.reference.binding.issueId !== task.issueId ||
    recovery.data.reference.binding.attemptId !== row.sourceAttemptId || recovery.data.reference.binding.candidateId !== null ||
    typeof row.producerDefinitionDigest !== 'string' || !row.producerDefinitionDigest || row.producerDefinitionDigest !== row.sourceDefinitionDigest ||
    questionFingerprint(row.producerSubscription) !== questionFingerprint(row.sourceSubscription)) return empty()

  const pinned = row.producerSubscription
  if (!pinned || pinned.bindingId !== row.bindingId || pinned.modelId !== row.modelId || pinned.route !== row.route ||
    row.model !== row.modelId || row.route !== (row.harness === 'codex' ? 'codex_cli' : 'claude_code_cli')) return empty()
  if (!['human', 'human_event'].includes(row.answerSource) || row.answer?.source !== row.answerSource || row.answer?.userId !== task.userId ||
    row.answerFingerprint !== questionFingerprint(row.answer)) return empty()
  const answer = parsedAnswer.data, reference = answer.reference
  if (answer.answerId !== row.answerId || reference.questionId !== row.questionId || reference.originRunId !== row.originRunId ||
    reference.originSessionId !== producer.sessionId || reference.binding.taskId !== task.id || reference.binding.issueId !== task.issueId ||
    reference.binding.attemptId !== row.originAttemptId || reference.binding.candidateId !== row.questionCandidateId ||
    questionFingerprint(reference.binding) !== questionFingerprint(row.waitingBinding) ||
    (row.answerSource === 'human_event' && (!row.ownerEventMatches || answer.sourceEventId !== row.answerSourceEventId))) return empty()
  const answeredAt = time(row.answeredAt), sourceStartedAt = time(row.sourceStartedAt), sourceFinishedAt = time(row.sourceFinishedAt)
  const recoveredAt = time(row.recoveryCreatedAt), producerStartedAt = time(row.producerStartedAt)
  if (![answeredAt, sourceStartedAt, sourceFinishedAt, recoveredAt, producerStartedAt].every(Number.isFinite) ||
    answeredAt > sourceStartedAt || sourceStartedAt > sourceFinishedAt || sourceFinishedAt > recoveredAt || recoveredAt > producerStartedAt) return empty()

  // These times are persisted source chunk observations, never a fresh command.
  const { rows: chunks } = await tx.query(`SELECT i.id AS "inputChunkId",o.id AS "outputChunkId",i.seq,i.chunk->>'toolName' AS "toolName",
      i."createdAt" AS "inputObservedAt",o."createdAt" AS "observedAt",
      left((i.chunk->'input')::text,4000) AS "inputJson",length((i.chunk->'input')::text)>4000 AS "inputTruncated",
      o.chunk->>'type' AS "outputType",left(coalesce((o.chunk->'output')::text,to_jsonb(o.chunk->>'errorText')::text),6000) AS "outputJson",
      length(coalesce((o.chunk->'output')::text,to_jsonb(o.chunk->>'errorText')::text))>6000 AS "outputTruncated"
    FROM run_chunks i JOIN run_chunks o ON o."runId"=i."runId" AND o.seq>i.seq AND o.chunk->>'toolCallId'=i.chunk->>'toolCallId'
    WHERE i."runId"=$1 AND i.chunk->>'type'='tool-input-available'
      AND lower(i.chunk->>'toolName') IN ('bash','shell','mcp__mikka__verify_command')
      AND o.chunk->>'type' IN ('tool-output-available','tool-output-error')
      AND i."createdAt">=$2 AND i."createdAt">=$3 AND o."createdAt">=i."createdAt" AND o."createdAt"<=$4
    ORDER BY i.seq DESC,o.seq DESC LIMIT 33`, [row.sourceRunId, row.answeredAt, row.sourceStartedAt, row.sourceFinishedAt])
  // No partial or oversized historical set can look like complete evidence.
  if (chunks.length > 32 || chunks.some(chunk => chunk.inputTruncated || chunk.outputTruncated)) return { records: [], omitted: true }
  const records: Observation[] = chunks.reverse().map(chunk => ({
    inherited: true,
    sourceRunId: row.sourceRunId, sourceSessionId: row.sourceSessionId, sourceStatus: 'failed', sourceStopReason: row.sourceStopReason,
    recoveryEventId: row.recoveryEventId, snapshotRecoveryEventId: receipt.eventId,
    questionId: row.questionId, answerId: row.answerId, requestEpoch: row.sourceEventId, candidateSha: candidate.executionSha,
    inputChunkId: chunk.inputChunkId, outputChunkId: chunk.outputChunkId, seq: chunk.seq, toolName: chunk.toolName,
    inputObservedAt: new Date(chunk.inputObservedAt).toISOString(), observedAt: new Date(chunk.observedAt).toISOString(), outputType: chunk.outputType,
    input: redactArtifact(JSON.parse(chunk.inputJson ?? 'null')), output: redactArtifact(JSON.parse(chunk.outputJson ?? 'null')),
  }))
  return JSON.stringify(records).length <= 12_000 ? { records, omitted: false } : { records: [], omitted: true }
}
