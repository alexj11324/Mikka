import type { PoolClient } from 'pg'
import type { FactoryTask } from './store'
import type { InheritedCommandObservation } from './inherited-command-observations'
import { reportedCandidateShaSql, resolveFactoryCandidateSha } from './deliverable-snapshot'
import { questionExecutionContinuation } from './questions/execution-continuation'
import { redactArtifact } from './evidence'

type Query = Pick<PoolClient, 'query'>
type Task = Pick<FactoryTask, 'id' | 'userId' | 'issueId'>
type Candidate = { id: string; executionSha: string; producerExecution: { runId: string; sessionId: string } }
const empty = () => ({ records: [] as InheritedCommandObservation[], omitted: false })
const time = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN

/** Completed command evidence has a stronger boundary than execution-budget
 * attribution: actual native claims, resumed SID, timing and candidate SHA. */
export async function completedQuestionExecution(tx: Query, task: Task, candidate: Candidate) {
  const producer = candidate.producerExecution
  const { rows: [bound] } = await tx.query(`SELECT c.id,c.kind,${reportedCandidateShaSql('c', 'p')} AS "reportedSha",
      t."sourceEventId",t."botId",pa.id AS "producerAttemptId"
    FROM factory_tasks t JOIN factory_candidates c ON c."taskId"=t.id AND c.id=t."candidateId"
    JOIN agent_runs p ON p.id=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
    JOIN factory_attempts pa ON pa."taskId"=t.id AND pa."runId"=p.id AND pa.stage='execute'
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND c.id=$4 AND p.id=$5 AND p."sessionId"=$6
      AND t.stage IN ('review','verify') AND c.kind='deliverable'`,
  [task.id, task.userId, task.issueId, candidate.id, producer.runId, producer.sessionId])
  if (!bound || await resolveFactoryCandidateSha(tx, task, bound, bound.reportedSha) !== candidate.executionSha) return null
  const edge = await questionExecutionContinuation(tx, { ...task, sourceEventId: bound.sourceEventId, botId: bound.botId }, bound.producerAttemptId)
  if (!edge || edge.continuationRunId !== producer.runId || edge.originSessionId !== producer.sessionId) return null
  const { rows: [row] } = await tx.query(`SELECT s.status AS "sourceStatus",s."stopReason" AS "sourceStopReason",
      s."startedAt" AS "sourceStartedAt",s."finishedAt" AS "sourceFinishedAt",
      p."startedAt" AS "producerStartedAt",p."finishedAt" AS "producerFinishedAt",
      q."answeredAt",e."createdAt" AS "recoveryCreatedAt",
      p."agentDefinition"->'subscription' AS subscription,
      pn."bindingId" AS "producerBindingId",sn."bindingId" AS "sourceBindingId"
    FROM agent_runs p JOIN agent_runs s ON s.id=$2
      AND s."userId"=p."userId" AND s."issueId"=p."issueId"
    JOIN factory_questions q ON q.id=$7 AND q."userId"=p."userId" AND q."issueId"=p."issueId" AND q."taskId"=$6
    JOIN factory_events e ON e."taskId"=q."taskId" AND e."eventId"=$8
    LEFT JOIN byos_native_runs pn ON pn."runId"=p.id LEFT JOIN byos_native_runs sn ON sn."runId"=s.id
    WHERE p.id=$1 AND p."userId"=$3 AND p."issueId"=$4
      AND (p."continuesRunId"=s.id OR (p."continuesRunId" IS NULL AND e.request->>'kind'='question_resume' AND q."originRunId"=s.id))
      AND p."sessionId"=$5 AND s."sessionId"=$5
      AND p.status='succeeded' AND p."stopReason"='submitted' AND p."stopRequestedAt" IS NULL
      AND s."stopRequestedAt" IS NULL AND p."retryOf" IS NULL AND s."retryOf" IS NULL
      AND p.kind='implement' AND s.kind='implement'
      AND q.status='resolved' AND q."continuationRunId"=p.id
      AND p."worktreePath" IS NOT NULL AND p."worktreePath"=s."worktreePath"
      AND COALESCE(s."agentDefinition"->'policy'->>'readOnly','false')<>'true'
      AND COALESCE(s."agentDefinition"->>'readOnly','false')<>'true'`,
  [producer.runId, edge.sourceRunId, task.userId, task.issueId, producer.sessionId, task.id, edge.questionId, edge.recoveryEventId])
  if (!row || row.sourceStatus !== (edge.kind === 'question_resume' ? 'stopped' : 'failed')) return null
  if (row.subscription && (row.producerBindingId !== row.subscription.bindingId || row.sourceBindingId !== row.subscription.bindingId)) return null
  const started = time(row.sourceStartedAt), finished = time(row.sourceFinishedAt), answered = time(row.answeredAt)
  const recovered = time(row.recoveryCreatedAt), producerStarted = time(row.producerStartedAt), producerFinished = time(row.producerFinishedAt)
  if (![started, finished, answered, recovered, producerStarted, producerFinished].every(Number.isFinite) ||
    started > finished || finished > recovered || recovered > producerStarted || producerStarted > producerFinished ||
    (edge.kind === 'question_resume' ? finished > answered || answered > recovered : answered > started)) return null
  return { edge, bound, row }
}

export async function resumedCommandObservations(tx: Query, task: Task, candidate: Candidate) {
  const completed = await completedQuestionExecution(tx, task, candidate)
  if (!completed) return empty()
  const { edge, bound, row } = completed, producer = candidate.producerExecution
  const { rows: chunks } = await tx.query(`SELECT i.id AS "inputChunkId",o.id AS "outputChunkId",i.seq,
      i.chunk->>'toolName' AS "toolName",i."createdAt" AS "inputObservedAt",o."createdAt" AS "observedAt",
      left((i.chunk->'input')::text,4000) AS "inputJson",length((i.chunk->'input')::text)>4000 AS "inputTruncated",
      o.chunk->>'type' AS "outputType",left(coalesce((o.chunk->'output')::text,to_jsonb(o.chunk->>'errorText')::text),6000) AS "outputJson",
      length(coalesce((o.chunk->'output')::text,to_jsonb(o.chunk->>'errorText')::text))>6000 AS "outputTruncated"
    FROM run_chunks i LEFT JOIN run_chunks o ON o."runId"=i."runId" AND o.seq>i.seq
      AND o.chunk->>'toolCallId'=i.chunk->>'toolCallId' AND o.chunk->>'type' IN ('tool-output-available','tool-output-error')
      AND o."createdAt">=i."createdAt" AND o."createdAt"<=$3
    WHERE i."runId"=$1 AND i.chunk->>'type'='tool-input-available'
      AND lower(i.chunk->>'toolName') IN ('bash','shell','mcp__mikka__verify_command')
      AND i."createdAt">=$2 AND i."createdAt"<=$3
    ORDER BY i.seq DESC,o.seq DESC LIMIT 33`, [edge.sourceRunId, row.sourceStartedAt, row.sourceFinishedAt])
  if (chunks.length > 32 || new Set(chunks.map(chunk => chunk.inputChunkId)).size !== chunks.length ||
    chunks.some(chunk => !chunk.outputChunkId || chunk.inputTruncated || chunk.outputTruncated)) return { records: [], omitted: true }
  const records: InheritedCommandObservation[] = chunks.reverse().map(chunk => ({
    inherited: true, sourceRunId: edge.sourceRunId, sourceSessionId: producer.sessionId,
    sourceStatus: row.sourceStatus, sourceStopReason: row.sourceStopReason,
    recoveryEventId: edge.recoveryEventId, snapshotRecoveryEventId: null,
    questionId: edge.questionId, answerId: edge.answerId, requestEpoch: bound.sourceEventId, candidateSha: candidate.executionSha,
    inputChunkId: chunk.inputChunkId, outputChunkId: chunk.outputChunkId, seq: chunk.seq, toolName: chunk.toolName,
    inputObservedAt: new Date(chunk.inputObservedAt).toISOString(), observedAt: new Date(chunk.observedAt).toISOString(),
    outputType: chunk.outputType, input: redactArtifact(JSON.parse(chunk.inputJson ?? 'null')), output: redactArtifact(JSON.parse(chunk.outputJson ?? 'null')),
  }))
  return JSON.stringify(records).length <= 12_000 ? { records, omitted: false } : { records: [], omitted: true }
}
