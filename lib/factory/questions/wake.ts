import { withFactoryBackgroundWorkspace } from '../background-workspace'
import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { FactoryError } from '../contract'
import { factoryEventId } from '../event-id'
import { factoryChanged } from '../../live/factory'
import { questionExecutionContinuation } from './execution-continuation'
import type { FactoryTask, createFactoryStore } from '../store'

type Actor = { userId: string; workspaceId: string }
export type QuestionWake = { eventId: string; generation: string }
type Receipt = QuestionWake & { tries: number; state: 'pending' | 'started' | 'blocked'; nextAt: string; workflowRunId?: string; submittedWorkflowId?: string; previousGeneration?: string }
export const QUESTION_WAKE_MAX_TRIES = 3
const WAKE_WINDOW = 2 * 60_000
const FAILURE = 'Original session could not start'

/** The existing Factory event log holds only this child's launch receipt. It
 * is not a second run queue and never changes the answer, run or attempt. */
export const questionWakeRuntime = {
  store: async (botId: string | null): Promise<ReturnType<typeof createFactoryStore>> => (await import('../runtime')).factoryRuntimeForBot(botId).store,
  enqueue: async (actor: Actor, runId: string, wake: QuestionWake) => {
    const [{ start }, { factoryCloudStageHandoff }] = await Promise.all([import('workflow/api'), import('@/workflows/factory-stage/workflow')])
    return (await start(factoryCloudStageHandoff, [actor, null, runId, false, wake])).runId
  },
  status: async (workflowRunId: string): Promise<string> => (await import('workflow/api')).getRun(workflowRunId).status,
}

async function identity(pool: Pool, userId: string, runId: string) {
  return (await pool.query(`SELECT q."taskId",t."botId" FROM factory_questions q
    JOIN factory_tasks t ON t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId"
    WHERE q."continuationRunId"=$1 AND q."userId"=$2 AND q.stage='execute'`, [runId, userId])).rows[0]
}

async function scope(tx: PoolClient, task: FactoryTask, runId: string, unclaimed = true, lockRows = true) {
  const { rows: [row] } = await tx.query(`SELECT q.id AS "questionId",q."answerId",q."originSessionId",b."workspaceId",
      r.status,r."questionContinuation"->>'requiredSandboxId' AS "sandboxId",r."agentDefinition"->>'definitionDigest' AS digest,
      (m."workerLeaseUntil" IS NULL OR m."workerLeaseUntil"<=clock_timestamp()) AS idle
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a.stage=t.stage
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN factory_questions q ON q."taskId"=t.id AND q."continuationRunId"=r.id AND q."userId"=t."userId" AND q."issueId"=t."issueId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId"
      AND m."issueId"=r."issueId" AND m."deviceId"=r."deviceId" AND m."repoId"=r."deviceRepoId"
    JOIN issues i ON i.id=r."issueId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."sourceEventId"=$3 AND t."attemptId"=$4 AND r.id=$5
      AND t.status='running' AND a.status='running' AND t.stage='execute' AND t."candidateId" IS NULL AND q."candidateId" IS NULL
      AND q.status='resuming' AND q."answerId" IS NOT NULL AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp())
      AND r."stopRequestedAt" IS NULL AND r."questionContinuation"->>'requireSessionResume'='true'
      AND r."questionContinuation"->>'questionId'=q.id::text AND r."questionContinuation"->>'originSessionId'=q."originSessionId"
      AND m."sandboxId"=r."questionContinuation"->>'requiredSandboxId' AND m.state IN ('paused','running','starting','error')
      AND i.status NOT IN ('done','canceled','duplicate') AND i.content->'attrs'->'mikka'->>'deletedAt' IS NULL
      AND (($6::boolean AND r.status='queued' AND r."startedAt" IS NULL AND r."sessionId" IS NULL
        AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=clock_timestamp()))
        OR (NOT $6::boolean AND r.status IN ('queued','preparing','running','waiting_input')))
    ${lockRows ? 'FOR UPDATE OF q,r' : ''}`, [task.id, task.userId, task.sourceEventId, task.attemptId, runId, unclaimed])
  if (!row || !await questionExecutionContinuation(tx, task, task.attemptId)) return null
  return row as { questionId: string; answerId: string; originSessionId: string; workspaceId: string; sandboxId: string; digest: string; idle: boolean; status: string }
}

const eventIdFor = (task: FactoryTask, runId: string) => factoryEventId('question-wake', `${task.sourceEventId}:${task.attemptId}:${runId}`)
function requestMatches(request: Record<string, unknown>, task: FactoryTask, runId: string, row: NonNullable<Awaited<ReturnType<typeof scope>>>) {
  return request.kind === 'question_wake' && request.userId === task.userId && request.runId === runId &&
    request.questionId === row.questionId && request.answerId === row.answerId && request.requestEpoch === task.sourceEventId &&
    request.attemptId === task.attemptId && request.workspaceId === row.workspaceId && request.originSessionId === row.originSessionId &&
    request.requiredSandboxId === row.sandboxId && request.definitionDigest === row.digest
}
async function receipt(tx: Pick<Pool, 'query'> | PoolClient, task: FactoryTask, runId: string) {
  return (await tx.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventIdFor(task, runId)])).rows[0] as { request: Record<string, unknown>; result: Receipt } | undefined
}
async function transaction<T>(pool: Pool, userId: string, target: { taskId: string; botId: string | null }, work: (tx: PoolClient) => Promise<T>) {
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'task', id: target.taskId, botId: target.botId }, async () => {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const value = await work(tx); await tx.query('COMMIT'); return value }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  })
}

/** At most three unattended generations. A lost enqueue acknowledgement may
 * leave duplicate workflow records, but only one workflow can win a generation
 * before any provider call, and an older generation can never regain custody. */
export async function wakeQueuedQuestionContinuation(pool: Pool, userId: string, runId: string, now = new Date(), manual?: { sessionId: string; generation: string }) {
  const found = await identity(pool, userId, runId)
  if (!found) return { handled: false, launched: false, recognized: false }
  const store = await questionWakeRuntime.store(found.botId)
  let observedTask: FactoryTask
  try { observedTask = await transaction(pool, userId, found, tx => store.readTask(tx, userId, found.taskId)) }
  catch (error) {
    if (error instanceof FactoryError) return { handled: false, launched: false, recognized: true }
    throw error
  }
  const observed = await receipt(pool, observedTask, runId)
  const workflowId = observed?.result.workflowRunId ?? observed?.result.submittedWorkflowId
  // Never replace an active workflow. Failure to read its status is not proof
  // that it ended; retain this generation and retry the observation later.
  let terminal = !workflowId
  if (workflowId) {
    try { terminal = ['completed', 'failed', 'cancelled'].includes(await questionWakeRuntime.status(workflowId)) }
    catch { terminal = false }
  }
  const launch = await transaction(pool, userId, found, async tx => {
    const task = await store.lockTask(tx, userId, found.taskId)
    const row = await scope(tx, task, runId)
    if (!row) return false
    if (manual && !(await tx.query('SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE', [manual.sessionId, userId])).rowCount)
      throw new FactoryError('factoryHumanRequired')
    const saved = await receipt(tx, task, runId), previous = saved?.result
    if (previous?.generation !== observed?.result.generation || previous?.workflowRunId !== observed?.result.workflowRunId || previous?.submittedWorkflowId !== observed?.result.submittedWorkflowId) return null
    if (!row.idle || !terminal) return null
    if (manual) {
      if (!previous || previous.state !== 'blocked' || previous.generation !== manual.generation) return null
    } else {
      if (previous && Date.parse(previous.nextAt) > now.getTime()) return null
      if ((previous?.tries ?? 0) >= QUESTION_WAKE_MAX_TRIES) {
        if (previous?.state !== 'blocked') {
          await tx.query(`UPDATE factory_events SET result=result || '{"state":"blocked"}'::jsonb WHERE "taskId"=$1 AND "eventId"=$2`, [task.id, eventIdFor(task, runId)])
          await factoryChanged(tx, task)
        }
        return null
      }
    }
    const wake: Receipt = { eventId: eventIdFor(task, runId), generation: randomUUID(), tries: (previous?.tries ?? 0) + 1,
      state: 'pending', nextAt: new Date(now.getTime() + WAKE_WINDOW).toISOString(), ...(previous ? { previousGeneration: previous.generation } : {}) }
    const request = { kind: 'question_wake', userId, runId, questionId: row.questionId, answerId: row.answerId,
      requestEpoch: task.sourceEventId, attemptId: task.attemptId, workspaceId: row.workspaceId,
      originSessionId: row.originSessionId, requiredSandboxId: row.sandboxId, definitionDigest: row.digest }
    await tx.query(`INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)
      ON CONFLICT("taskId","eventId") DO UPDATE SET result=EXCLUDED.result WHERE factory_events.request=EXCLUDED.request`,
    [task.id, wake.eventId, JSON.stringify(request), JSON.stringify(wake)])
    const confirmed = await receipt(tx, task, runId)
    if (confirmed?.result.generation !== wake.generation) return null
    await factoryChanged(tx, task)
    return { taskId: task.id, actor: { userId, workspaceId: row.workspaceId }, wake }
  })
  if (!launch) return { handled: launch !== false, launched: false, recognized: true }
  try {
    const submittedWorkflowId = await questionWakeRuntime.enqueue(launch.actor, runId, launch.wake)
    await pool.query(`UPDATE factory_events SET result=result || jsonb_build_object('submittedWorkflowId',$4::text)
      WHERE "taskId"=$1 AND "eventId"=$2 AND result->>'generation'=$3`, [launch.taskId, launch.wake.eventId, launch.wake.generation, submittedWorkflowId])
  } catch {
    // Unknown enqueue outcome: keep the generation until its deadline. A late
    // callback may still win; the next generation fences it before provider I/O.
  }
  return { handled: true, launched: true, recognized: true }
}

/** Workflow entry revalidates the immutable answer and current authority, then
 * elects one workflow. A duplicate record exits before touching the machine. */
export async function claimQuestionWake(pool: Pool, actor: Actor, runId: string, wake: QuestionWake, workflowRunId: string) {
  const found = await identity(pool, actor.userId, runId)
  if (!found) return false
  const store = await questionWakeRuntime.store(found.botId)
  return transaction(pool, actor.userId, found, async tx => {
    const task = await store.lockTask(tx, actor.userId, found.taskId)
    const row = await scope(tx, task, runId, false)
    if (!row || row.workspaceId !== actor.workspaceId || wake.eventId !== eventIdFor(task, runId)) return false
    const saved = await receipt(tx, task, runId)
    if (!saved || !requestMatches(saved.request, task, runId, row) || saved.result.generation !== wake.generation || saved.result.state === 'blocked' ||
      (saved.result.workflowRunId && saved.result.workflowRunId !== workflowRunId)) return false
    await tx.query(`UPDATE factory_events SET result=result || jsonb_build_object('workflowRunId',$4::text)
      WHERE "taskId"=$1 AND "eventId"=$2 AND result->>'generation'=$3`, [task.id, wake.eventId, wake.generation, workflowRunId])
    return true
  })
}

/** A lost handoff response can replay after claim or even completion. The
 * already elected workflow may maintain its own run, never start it again. */
export async function questionWakeClaimed(pool: Pool, actor: Actor, runId: string, wake: QuestionWake, workflowRunId: string) {
  return Boolean((await pool.query(`SELECT 1 FROM factory_events e JOIN agent_runs r ON r.id::text=e.request->>'runId'
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE e."eventId"=$1 AND e.request->>'kind'='question_wake' AND e.request->>'userId'=$2 AND e.request->>'workspaceId'=$3::text
      AND r.id=$4 AND r."userId"=$2 AND b."workspaceId"=$3::uuid AND r."startedAt" IS NOT NULL
      AND e.result->>'generation'=$5 AND e.result->>'workflowRunId'=$6 AND e.result->>'state'<>'blocked'`,
  [wake.eventId, actor.userId, actor.workspaceId, runId, wake.generation, workflowRunId])).rowCount)
}

/** The workflow's catch runs after its existing four bounded handoff attempts.
 * Only launch state changes: queued remains queued and no SID is invented. */
export async function finishQuestionWake(pool: Pool, actor: Actor, runId: string, wake: QuestionWake, workflowRunId: string, failed: boolean) {
  if (!failed) {
    // A fast worker may finish and advance the Factory attempt before this
    // step commits. Its winning lifecycle must still retain/park its own VM.
    await pool.query(`UPDATE factory_events e SET result=e.result || '{"state":"started"}'::jsonb
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE e."eventId"=$1 AND e.result->>'generation'=$2 AND e.result->>'workflowRunId'=$3
        AND e.request->>'kind'='question_wake' AND e.request->>'runId'=r.id::text
        AND e.request->>'userId'=$4 AND e.request->>'workspaceId'=$5::text
        AND r."userId"=$4 AND b."workspaceId"=$5::uuid AND r.id=$6 AND e.result->>'state'<>'blocked'`,
    [wake.eventId, wake.generation, workflowRunId, actor.userId, actor.workspaceId, runId])
    return
  }
  await pool.query(`UPDATE factory_events e SET result=e.result || jsonb_build_object('state',$6::text)
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE e."taskId"=t.id AND e."eventId"=$1 AND e.result->>'generation'=$2 AND e.result->>'workflowRunId'=$3
      AND t."userId"=$4 AND b."workspaceId"=$5 AND r.id=$7 AND t.status='running' AND a.status='running'
      AND e.request->>'requestEpoch'=t."sourceEventId"::text AND e.request->>'attemptId'=t."attemptId"::text
      AND r."stopRequestedAt" IS NULL AND (NOT $8::boolean OR (r.status='queued' AND r."startedAt" IS NULL AND r."sessionId" IS NULL))`,
  [wake.eventId, wake.generation, workflowRunId, actor.userId, actor.workspaceId, failed ? 'blocked' : 'started', runId, failed])
}

/** Maintenance belongs to the generation that won startup, even after normal
 * completion advances the Factory task. Never let a superseded wake park it. */
export async function questionWakeOwnsWorkflow(pool: Pool, actor: Actor, runId: string, wake: QuestionWake, workflowRunId: string) {
  return Boolean((await pool.query(`SELECT 1 FROM factory_events WHERE "eventId"=$1 AND request->>'kind'='question_wake'
    AND request->>'userId'=$2 AND request->>'workspaceId'=$3 AND request->>'runId'=$4
    AND result->>'generation'=$5 AND result->>'workflowRunId'=$6 AND result->>'state'='started'`,
  [wake.eventId, actor.userId, actor.workspaceId, runId, wake.generation, workflowRunId])).rowCount)
}

export async function questionWakeFailure(pool: Pool, userId: string, runId: string): Promise<{ generation: string; error: string } | null> {
  const found = await identity(pool, userId, runId)
  if (!found) return null
  const store = await questionWakeRuntime.store(found.botId)
  return transaction(pool, userId, found, async tx => {
    // This projection reads committed state; mutation paths retain their row locks.
    const task = await store.readTask(tx, userId, found.taskId), row = await scope(tx, task, runId, true, false)
    if (!row || !row.idle) return null
    const saved = await receipt(tx, task, runId)
    return saved?.result.state === 'blocked' && requestMatches(saved.request, task, runId, row) ? { generation: saved.result.generation, error: FAILURE } : null
  })
}

export async function retryQueuedQuestionWake(pool: Pool, actor: { userId: string; sessionId: string }, runId: string, expectedGeneration: string): Promise<{ runId: string; continued: false }> {
  if (!z.uuid().safeParse(expectedGeneration).success) throw new FactoryError('factoryInvalid')
  if (!(await pool.query('SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp()', [actor.sessionId, actor.userId])).rowCount)
    throw new FactoryError('factoryHumanRequired')
  const result = await wakeQueuedQuestionContinuation(pool, actor.userId, runId, new Date(), { sessionId: actor.sessionId, generation: expectedGeneration })
  if (!result.launched) {
    const found = await identity(pool, actor.userId, runId)
    if (!found) throw new FactoryError('factoryQuestionContinuationUnavailable')
    const store = await questionWakeRuntime.store(found.botId)
    const task = await transaction(pool, actor.userId, found, tx => store.readTask(tx, actor.userId, found.taskId)), saved = await receipt(pool, task, runId)
    // Concurrent clicks observing one failed generation acknowledge its one
    // already reserved successor; they never reserve a second successor.
    if (saved?.result.previousGeneration !== expectedGeneration || saved.result.state === 'blocked') throw new FactoryError('factoryQuestionContinuationUnavailable')
  }
  return { runId, continued: false }
}
