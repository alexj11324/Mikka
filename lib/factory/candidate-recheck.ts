import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { threadRunModel } from '../computer/run-model'
import { nativeRunBinding } from '../computer/native-run-binding'
import { workerDefinitionDigest } from '../agent-kit/worker-digest'
import { intersectRunPolicy } from '../run-assignment-policy'
import { credentialStates, orderCandidates } from '../model-order'
import type { OrderEntry } from '../model-order-plan'
import { historicalFactoryCheckAssignment } from './checks'
import { FactoryError, factoryFlowVersion } from './contract'
import type { FrozenFactoryCheck } from './check-start-recovery'
import type { FactoryTask } from './store'

type Query = Pick<PoolClient, 'query'>
export type CandidateRecheck = { review: FrozenFactoryCheck; verify: FrozenFactoryCheck; question: {
  id: string; revision: number; status: 'open' | 'waiting_user' | 'expired'; disposition: 'superseded' | 'expired'
} | null }
const mismatch = () => { throw new FactoryError('factoryCheckBindingMismatch') }

/** The saved dispatch entry is required for a pre-Profile run. Reading this
 * selection never fabricates a Profile or chooses from current preferences. */
function frozenEntry(source: FrozenFactoryCheck): OrderEntry {
  const definition = source.run.agentDefinition
  const entry = source.selection.agentProfile?.targetEntry ?? source.selection.modelDispatch?.entry
  if (!entry || typeof entry.id !== 'string' || !entry.id || entry.harness !== definition.harness || entry.model !== source.selection.model ||
      entry.source?.kind !== 'subscription' || !z.uuid().safeParse(entry.source.connectionId).success ||
      !source.selection.subscriptionBindingId || source.selection.apiKeyId) return mismatch()
  return entry
}

async function frozenCheck(tx: Query, task: FactoryTask, attemptId: string, stage: 'review' | 'verify', lock = false): Promise<FrozenFactoryCheck | null> {
  const { rows: [run] } = await tx.query(`SELECT r.*,a.output AS "checkOutput",a."sessionId" AS "attemptSessionId",a.stage AS "attemptStage",
      a.status AS "attemptStatus",a.position AS "attemptPosition",a."candidateId" AS "attemptCandidateId",d.kind AS "deviceKind"
    FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    WHERE a.id=$1 AND a."taskId"=$2 AND r."userId"=$3 AND r."issueId"=$4 ${lock ? 'FOR UPDATE OF a,r' : ''}`,
    [attemptId, task.id, task.userId, task.issueId])
  const definition = run?.agentDefinition, selection = threadRunModel(definition)
  const started = new Date(run?.startedAt ?? '').getTime(), finished = new Date(run?.finishedAt ?? '').getTime()
  if (!task.candidateId || !run || run.kind !== 'acceptance' || !['succeeded', 'failed', 'stopped'].includes(run.status) ||
      !Number.isFinite(started) || !Number.isFinite(finished) || finished < started || !run.sessionId || run.attemptSessionId !== run.sessionId ||
      run.stopRequestedAt || (run.leaseExpiresAt && !(new Date(run.leaseExpiresAt).getTime() <= Date.now())) ||
      run.attemptStage !== stage || run.attemptCandidateId !== task.candidateId ||
      (stage === 'review' && (run.attemptStatus !== 'passed' || run.status !== 'succeeded' || run.stopReason !== 'submitted')) ||
      definition?.readOnly !== true || typeof definition.executionIdentity?.workspaceId !== 'string' ||
      !['claude_code', 'codex'].includes(definition.harness) || definition.definitionDigest !== workerDefinitionDigest(definition) ||
      !selection?.subscriptionBindingId || selection.apiKeyId || !selection.model ||
      definition.subscription?.bindingId !== selection.subscriptionBindingId || definition.subscription?.modelId !== selection.model || definition.apiKey) return null
  try {
    const assignment = await historicalFactoryCheckAssignment(tx, task, attemptId, run.id)
    const source = { taskId: task.id, attemptId, candidateId: task.candidateId, sourceEventId: task.sourceEventId, run,
      check: run.checkOutput.check, selection: { ...selection, policyCeiling: intersectRunPolicy(assignment.policy, selection.policyCeiling) } }
    const entry = frozenEntry(source)
    const binding = await nativeRunBinding(tx, task.userId, run.agentId, entry.harness, definition.executionIdentity.workspaceId, selection.subscriptionBindingId)
    if (!binding || entry.source.kind !== 'subscription' || binding.connectionId !== entry.source.connectionId || binding.modelId !== entry.model) return null
    return source
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'factoryCheckBindingMismatch') return null
    throw error
  }
}

/** Caller supplies current ownership/source/issue fences. GET is read-only;
 * the Owner write repeats every condition under the same task lock. */
export async function candidateRecheckForRecovery(tx: Query, task: FactoryTask, lock = false): Promise<CandidateRecheck | null> {
  if (factoryFlowVersion(task) !== 1 || !task.candidateId ||
      !(task.stage === 'verify' && ['waiting', 'blocked', 'failed'].includes(task.status) || task.stage === 'approval' && task.status === 'pending')) return null
  const { rows: [current] } = await tx.query('SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2', [task.attemptId, task.id])
  if (!current || current.stage !== task.stage || current.status !== task.status || current.candidateId !== task.candidateId || current.output?.requestEpoch !== task.sourceEventId) return null
  const { rows: [unsafe] } = await tx.query(`SELECT
    EXISTS(SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a."taskId"=$1
      AND (r.status NOT IN ('succeeded','completed','failed','stopped','cancelled') OR r."leaseExpiresAt">clock_timestamp())) AS active,
    EXISTS(SELECT 1 FROM factory_approvals WHERE "taskId"=$1 AND "candidateId"=$2) OR
    EXISTS(SELECT 1 FROM factory_publications WHERE "taskId"=$1 AND "candidateId"=$2) OR
    EXISTS(SELECT 1 FROM factory_merges WHERE "taskId"=$1 AND "candidateId"=$2 AND status IN ('merging','merged')) OR
    EXISTS(SELECT 1 FROM factory_deliverable_acceptances WHERE "taskId"=$1 AND "candidateId"=$2) AS accepted`, [task.id, task.candidateId])
  if (unsafe.active || unsafe.accepted) return null
  const { rows: attempts } = await tx.query(`SELECT DISTINCT ON (stage) id,stage,status,position FROM factory_attempts
    WHERE "taskId"=$1 AND "candidateId"=$2 AND output->>'requestEpoch'=$3 AND stage IN ('review','verify') AND position<=$4
    ORDER BY stage,position DESC`, [task.id, task.candidateId, task.sourceEventId, current.position])
  const reviewAttempt = attempts.find(a => a.stage === 'review'), verifyAttempt = attempts.find(a => a.stage === 'verify')
  if (!reviewAttempt || !verifyAttempt || reviewAttempt.status !== 'passed' || reviewAttempt.position >= verifyAttempt.position ||
      (task.stage === 'verify' ? verifyAttempt.id !== task.attemptId : verifyAttempt.status !== 'passed')) return null
  const review = await frozenCheck(tx, task, reviewAttempt.id, 'review', lock)
  const verify = await frozenCheck(tx, task, verifyAttempt.id, 'verify', lock)
  if (!review || !verify || review.run.id === verify.run.id || review.run.sessionId === verify.run.sessionId ||
      review.run.agentDefinition.executionIdentity.workspaceId !== verify.run.agentDefinition.executionIdentity.workspaceId ||
      (task.stage === 'verify' && ['blocked', 'failed'].includes(task.status) && verify.run.questionContinuation) ||
      (task.stage === 'approval' && (verify.run.status !== 'succeeded' || verify.run.stopReason !== 'submitted'))) return null
  const { rows: questions } = await tx.query(`SELECT *, ("expiresAt" IS NOT NULL AND "expiresAt"<=clock_timestamp()) AS "deadlineElapsed"
    FROM factory_questions WHERE "taskId"=$1
    AND (status NOT IN ('resolved','cancelled','expired','superseded') OR
      ($4::boolean AND status='expired' AND "attemptId"=$2 AND "originRunId"=$3))
    ORDER BY "createdAt" LIMIT 2 ${lock ? 'FOR UPDATE' : ''}`,
    [task.id, task.attemptId, verify.run.id, task.stage === 'verify' && task.status === 'waiting'])
  if (questions.length > 1) return null
  const question = questions[0]
  const expiresAt = question?.expiresAt == null ? null : new Date(question.expiresAt).getTime()
  const expired = question?.deadlineElapsed === true
  if (question && (task.stage !== 'verify' || task.status !== 'waiting' || !['open', 'waiting_user', 'expired'].includes(question.status) ||
      question.userId !== task.userId || question.issueId !== task.issueId || question.attemptId !== task.attemptId ||
      question.candidateId !== task.candidateId || question.stage !== 'verify' || question.originRunId !== verify.run.id ||
      question.originSessionId !== verify.run.sessionId ||
      ['answerId', 'answerSource', 'answerSourceEventId', 'answerFingerprint', 'answeredAt', 'answer', 'result', 'continuationRunId'].some(key => question[key] != null) ||
      (expiresAt !== null && !Number.isFinite(expiresAt)) || (question.status === 'expired' && !expired) ||
      !isDeepStrictEqual(question.waitingBinding, { taskId: task.id, issueId: task.issueId, attemptId: task.attemptId, revision: task.revision, candidateId: task.candidateId }) ||
      verify.run.status !== 'stopped' || verify.run.stopReason !== 'asked_human' || verify.run.questionContinuation)) return null
  if (task.status === 'waiting' && !question) return null
  return { review, verify, question: question ? { id: question.id, revision: question.revision, status: question.status,
    disposition: expired ? 'expired' : 'superseded' } : null }
}

/** Official usage refresh is outside Owner write locks. The exact source is
 * re-admitted inside the real transaction; a stale/failed probe grants nothing. */
export async function refreshRecheckSource(pool: Pool, source: FrozenFactoryCheck) {
  const scope = { ownerId: source.run.userId as string, workspaceId: source.run.agentDefinition.executionIdentity.workspaceId as string }
  const entry = frozenEntry(source)
  const binding = await nativeRunBinding(pool, scope.ownerId, source.run.agentId, entry.harness, scope.workspaceId, source.selection.subscriptionBindingId)
  if (!binding || binding.connectionId !== (entry.source as { connectionId: string }).connectionId || binding.modelId !== entry.model) return mismatch()
  await credentialStates(pool, scope, [entry], await orderCandidates(pool, scope))
}

export async function admitRecheckSource(tx: PoolClient, source: FrozenFactoryCheck) {
  const scope = { ownerId: source.run.userId as string, workspaceId: source.run.agentDefinition.executionIdentity.workspaceId as string }
  const entry = frozenEntry(source)
  await (await import('./agent-profile')).assertFrozenModelTarget(tx, scope, entry)
  const { registerFactoryProfile } = await import('./transaction')
  registerFactoryProfile(tx, scope, source.selection.agentProfile)
}

/** The marker only locates a host receipt; it is never authority by itself.
 * All later attempts in this check round retain the exact two source IDs,
 * including a normal question continuation. No latest-preference fallback. */
export async function candidateRecheckRound(tx: Query, task: FactoryTask) {
  if (!task.candidateId || !['review', 'verify'].includes(task.stage)) return null
  const { rows: [anchor] } = await tx.query(`SELECT a.* FROM factory_attempts a JOIN factory_attempts current ON current.id=$2 AND current."taskId"=a."taskId"
    WHERE a."taskId"=$1 AND a."candidateId"=$3 AND a.output->>'requestEpoch'=$4 AND a.position<=current.position
      AND (a.output ? 'ownerRecheckEventId' OR EXISTS(SELECT 1 FROM factory_events e WHERE e."taskId"=a."taskId"
        AND e.request->>'kind'='owner_candidate_recheck' AND e.request->>'reviewAttemptId'=a.id::text))
      ORDER BY a.position DESC LIMIT 1`, [task.id, task.attemptId, task.candidateId, task.sourceEventId])
  if (!anchor) return null
  const eventId = anchor.output.ownerRecheckEventId
  if (factoryFlowVersion(task) !== 1 || !z.uuid().safeParse(eventId).success) return mismatch()
  const { rows: [receipt] } = await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])
  const req = receipt?.request, result = receipt?.result
  const recorded = result?.attempts?.find((a: { id: string }) => a.id === anchor.id)
  if (req?.kind !== 'owner_candidate_recheck' || req.sourceEventId !== task.sourceEventId || req.candidateId !== task.candidateId ||
      req.reviewAttemptId !== anchor.id || req.reviewRunId !== anchor.runId || anchor.stage !== 'review' || req.input?.change?.action !== 'recheck' ||
      req.input?.binding?.taskId !== task.id || !Number.isSafeInteger(req.input?.binding?.revision) || req.input.binding.revision < 1 ||
      result?.task?.id !== task.id || result.task.userId !== task.userId || result.task.issueId !== task.issueId ||
      result.task.sourceEventId !== task.sourceEventId || result.task.candidateId !== task.candidateId || result.task.attemptId !== anchor.id ||
      result.task.stage !== 'review' || result.task.status !== 'running' || result.task.revision !== req.input?.binding?.revision + 2 ||
      recorded?.runId !== anchor.runId || recorded.stage !== 'review' || recorded.candidateId !== task.candidateId ||
      recorded.output?.ownerRecheckEventId !== eventId || !z.uuid().safeParse(req.sources?.review?.attemptId).success ||
      !z.uuid().safeParse(req.sources?.verify?.attemptId).success || !z.uuid().safeParse(req.sources?.review?.runId).success ||
      !z.uuid().safeParse(req.sources?.verify?.runId).success || req.sources.review.attemptId === req.sources.verify.attemptId ||
      req.sources.review.runId === req.sources.verify.runId) return mismatch()
  return { position: anchor.position as number, sources: req.sources as Record<'review' | 'verify', { attemptId: string; runId: string }> }
}

export async function candidateRecheckDispatchSource(tx: Query, task: FactoryTask, round: NonNullable<Awaited<ReturnType<typeof candidateRecheckRound>>>) {
  if (task.stage !== 'review' && task.stage !== 'verify') return mismatch()
  const original = round.sources[task.stage]
  const source = await frozenCheck(tx, task, original.attemptId, task.stage)
  if (!source || source.run.id !== original.runId || source.run.attemptPosition >= round.position) return mismatch()
  return source
}

/** Provider recovery and launch use the same host receipt as stage dispatch.
 * An older source check is not part of the new round, and a JSON marker alone
 * cannot pin a run or authorize a different credential. */
export async function candidateRecheckPinsRun(tx: Query, userId: string, runId: string): Promise<boolean> {
  const { rows } = await tx.query<FactoryTask & { sourceAttemptPosition: number }>(`SELECT t.*,a.position AS "sourceAttemptPosition"
    FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id
    WHERE t."userId"=$1 AND a."runId"=$2 AND a.stage IN ('review','verify')
      AND a."candidateId"=t."candidateId" AND a.output->>'requestEpoch'=t."sourceEventId"::text`, [userId, runId])
  for (const task of rows) {
    const round = await candidateRecheckRound(tx, task)
    if (round && task.sourceAttemptPosition >= round.position) return true
  }
  return false
}
