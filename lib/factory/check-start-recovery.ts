import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { threadRunModel } from '../computer/run-model'
import { workerDefinitionDigest } from '../agent-kit/worker-digest'
import { intersectRunPolicy } from '../run-assignment-policy'
import { factoryBlockedCheckAssignment } from './checks'
import { FactoryError, factoryFlowVersion } from './contract'
import type { FactoryTask } from './store'

// The host claim route writes this complete refusal before starting a worker.
// Text alone is never authority: the persisted assignment and absence of any
// claim/session/continuation or execution evidence are checked below.
const profileRefusal = 'The selected Agent Profile changed or is no longer available. Select an available Profile for a new run.'
const refusalReport = { summary: profileRefusal, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null }

export type FactoryCheckStartRecovery = {
  taskId: string; attemptId: string; candidateId: string; sourceEventId: string
  run: Record<string, any>
  check: Record<string, any>
  selection: NonNullable<ReturnType<typeof threadRunModel>>
}

/** Only an unclaimed host Profile refusal can start this same check afresh.
 * The caller owns the task/access fence; writes repeat this under the task lock.
 * This is not a native continuation or permission to retry a completed review. */
export async function unstartedCheckForRecovery(tx: Pick<PoolClient, 'query'>, task: FactoryTask, lock = false): Promise<FactoryCheckStartRecovery | null> {
  if (task.status !== 'blocked' || !['review', 'verify'].includes(task.stage) || !task.candidateId) return null
  const { rows: [run] } = await tx.query(`SELECT r.*,a.output AS "checkOutput",a."sessionId" AS "attemptSessionId",
      a.stage AS "attemptStage",a.status AS "attemptStatus",a."candidateId" AS "attemptCandidateId",d.kind AS "deviceKind"
    FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    WHERE a.id=$1 AND a."taskId"=$2 AND r."userId"=$3 AND r."issueId"=$4
    ${lock ? 'FOR UPDATE OF a,r' : ''}`, [task.attemptId, task.id, task.userId, task.issueId])
  const definition = run?.agentDefinition, selection = threadRunModel(definition)
  if (!run || run.kind !== 'acceptance' || run.status !== 'failed' || run.stopReason !== 'blocked' ||
      run.error !== profileRefusal || !isDeepStrictEqual(run.report, refusalReport) || !run.finishedAt ||
      ['startedAt', 'sessionId', 'leaseExpiresAt', 'stopRequestedAt', 'retryOf', 'continuesRunId', 'questionContinuation', 'attemptSessionId'].some(key => run[key] !== null) ||
      run.lastReply || run.lastReplyPart || run.lastReplyAt || definition?.profileOriginRunId ||
      run.attemptStage !== task.stage || run.attemptStatus !== 'blocked' || run.attemptCandidateId !== task.candidateId ||
      run.checkOutput?.requestEpoch !== task.sourceEventId || run.checkOutput?.check?.requestEpoch !== task.sourceEventId ||
      definition?.readOnly !== true || !definition.agentProfile || typeof definition.executionIdentity?.workspaceId !== 'string' || !selection ||
      definition.definitionDigest !== workerDefinitionDigest(definition) ||
      (!selection.subscriptionBindingId && !selection.apiKeyId)) return null
  const { rows: [evidence] } = await tx.query(`SELECT
    EXISTS(SELECT 1 FROM run_chunks WHERE "runId"=$1) OR
    EXISTS(SELECT 1 FROM run_checkpoints WHERE "runId"=$1) OR
    EXISTS(SELECT 1 FROM artifacts WHERE "runId"=$1) OR
    EXISTS(SELECT 1 FROM run_captures WHERE "runId"=$1) AS executed,
    EXISTS(SELECT 1 FROM factory_questions WHERE "taskId"=$2
      AND status NOT IN ('resolved','cancelled','expired','superseded')) AS question,
    EXISTS(SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
      WHERE a."taskId"=$2 AND r.status NOT IN ('succeeded','completed','failed','stopped','cancelled')) AS active`, [run.id, task.id])
  if (evidence.executed || evidence.question || evidence.active) return null
  // Every other ended v2 review still consumes the one-review budget. Only a
  // prior host-qualified retry receipt proves that another attempt never began.
  if (factoryFlowVersion(task) === 2 && task.stage === 'review') {
    const previous = await tx.query(`SELECT 1 FROM factory_attempts a WHERE a."taskId"=$1 AND a.id<>$2
      AND a.stage='review' AND a."runId" IS NOT NULL AND a.status IN ('passed','failed','blocked','waiting')
      AND NOT EXISTS(SELECT 1 FROM factory_events e WHERE e."taskId"=a."taskId"
        AND e.request->>'kind'='owner_check_start_recovery' AND e.request->>'attemptId'=a.id::text
        AND e.request->>'runId'=a."runId"::text) LIMIT 1`, [task.id, task.attemptId])
    if (previous.rowCount) return null
  }
  try {
    const assignment = await factoryBlockedCheckAssignment(tx, task.userId, run.id)
    return { taskId: task.id, attemptId: task.attemptId, candidateId: task.candidateId, sourceEventId: task.sourceEventId,
      run, check: run.checkOutput.check, selection: { ...selection,
        policyCeiling: intersectRunPolicy(assignment.policy, selection.policyCeiling) } }
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'factoryCheckBindingMismatch') return null
    throw error
  }
}

/** Configuration may move to a fresh worker, but cannot change this candidate,
 * request, command, source or role. A mismatch aborts the entire Owner action. */
export function assertRecoveredCheck(source: FactoryCheckStartRecovery, run: Record<string, any>, check: Record<string, any>) {
  const before = source.run.agentDefinition, after = run.agentDefinition
  if (run.kind !== 'acceptance' || run.status !== 'queued' || run.baseBranch !== source.run.baseBranch ||
      run.agentId !== source.run.agentId || run.userId !== source.run.userId || run.issueId !== source.run.issueId || run.botId !== source.run.botId ||
      ['startedAt', 'sessionId', 'leaseExpiresAt', 'stopRequestedAt', 'retryOf', 'continuesRunId', 'questionContinuation'].some(key => run[key] !== null) ||
      after?.profileOriginRunId || after?.readOnly !== true || after?.harness !== before.harness || after?.model !== before.model ||
      !isDeepStrictEqual(after?.subscription, before.subscription) || !isDeepStrictEqual(after?.apiKey, before.apiKey) ||
      !isDeepStrictEqual(after?.agentProfile, before.agentProfile) || !isDeepStrictEqual(after?.modelDispatch, before.modelDispatch) ||
      !isDeepStrictEqual(after?.policyCeiling, source.selection.policyCeiling) ||
      ['stage', 'candidateId', 'sha', 'repository', 'candidateEnvironment', 'requestEpoch', 'command', 'inferCommand', 'reportOnly'].some(key => !isDeepStrictEqual(check?.[key], source.check[key])))
    throw new FactoryError('factoryCheckBindingMismatch')
}
