import { withFactoryBackgroundWorkspace } from './background-workspace'
import 'server-only'
import { wakeCoordinatorAfterCommit } from '../coordinator/wake-after-commit'
import { createHash, randomUUID } from 'node:crypto'
import { escapeLiteral, type Pool, type QueryResult } from 'pg'
import { FactoryError } from './contract'
import { checkFactoryRepairBudget } from './check-recovery-evidence'
import { factoryBinding, createFactoryDispatch, type FactoryQueue } from './dispatch'
import { factoryEventId } from './event-id'
import { factoryLifecycleEnabled, factoryRuntimeForBot } from './runtime'
import { notifyQueuedLocalRun } from '../device-gateway-notify'
import { advanceFactoryRequest, factoryContinuationSource } from './request-epoch'

function isLockResult(value: unknown): value is Pick<QueryResult, 'command' | 'rows'> {
  if (!value || typeof value !== 'object') return false
  const result = value as Partial<QueryResult>
  return result.command === 'SELECT' && Array.isArray(result.rows) && result.rows.length === 1
    && result.rows[0] !== null && typeof result.rows[0] === 'object' && !Array.isArray(result.rows[0])
}

/** The initial Profile follows the existing route. The queue rechecks it under lock. */
export async function factoryTaskNeedsSpec(pool: Pool, userId: string, input: {
  issueId: string; botId: string | null; needsSpec?: boolean
}) {
  if (input.needsSpec) return true
  const { rows: [task] } = await pool.query<{ stage: string; status: string }>(`SELECT stage,status FROM factory_tasks
    WHERE "userId"=$1 AND "issueId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid
    ORDER BY "createdAt" DESC,id DESC LIMIT 1`, [userId, input.issueId, input.botId])
  return task?.stage === 'spec' && !['cancelled','revoked'].includes(task.status)
}

/** Placement is already decided. Route, attempt, queue and receipt share one commit. */
export async function queueFactoryTask(pool: Pool, userId: string, input: {
  issueId: string; botId: string | null; agentId: string; deviceRepoId: string; note?: string
  key?: string; sourceEventId?: string; previousRunId?: string; needsSpec?: boolean
  selection?: unknown
  queue: FactoryQueue
}) {
  if (!factoryLifecycleEnabled()) throw new FactoryError('factoryLifecycleUnavailable')
  if (input.needsSpec && input.previousRunId) throw new FactoryError('factoryTransition')
  return withFactoryBackgroundWorkspace(pool, userId, { kind: 'issue', id: input.issueId, botId: input.botId }, async () => {
  const runtime = factoryRuntimeForBot(input.botId)
  const tx = await pool.connect()
  const key = input.key ?? randomUUID()
  const receiptId = factoryEventId('host-dispatch', `${userId}:${key}`)
  const digest = createHash('sha256').update(JSON.stringify([input.agentId, input.deviceRepoId, input.note ?? null, input.previousRunId ?? null, input.sourceEventId ?? null, input.selection ?? null, ...(input.needsSpec ? [{ needsSpec: true }] : [])])).digest('hex')
  try {
    await tx.query('BEGIN')
    // Native simple-query keeps two statements and the original lock order.
    // BEGIN stays separate; no policy snapshot moves ahead of a waiting lock.
    const locks: unknown = await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended(${escapeLiteral(JSON.stringify(['factory-host-dispatch', userId, input.issueId]))},0));
      SELECT pg_advisory_xact_lock(hashtextextended(${escapeLiteral(JSON.stringify([userId, input.issueId]))},0))`)
    if (!Array.isArray(locks) || locks.length !== 2 || !locks.every(isLockResult)) throw new TypeError('Invalid Factory dispatch locks')
    const { rows: [receipt] } = await tx.query(`SELECT e.result,e.request->>'digest'=$5 AS same,t.status,t.id AS "taskId" FROM factory_events e JOIN factory_tasks t ON t.id=e."taskId" WHERE t."userId"=$1 AND t."issueId"=$2 AND t."botId" IS NOT DISTINCT FROM $3::uuid AND e."eventId"=$4`, [userId, input.issueId, input.botId, receiptId, digest])
    if (receipt) {
      if (!receipt.same) throw new FactoryError('factoryReplayMismatch')
      if (['cancelled','revoked'].includes(receipt.status)) throw new FactoryError('factoryStopped')
      await runtime.store.lockTask(tx, userId, receipt.taskId)
      await tx.query('COMMIT'); return receipt.result as { runId: string }
    }
    const { rows } = await tx.query<import('./store').FactoryTask>(`SELECT * FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid ORDER BY "createdAt" DESC,id DESC LIMIT 1 FOR UPDATE`, [userId, input.issueId, input.botId])
    let task: import('./store').FactoryTask | undefined = rows[0]
    const pendingSpec = task?.stage === 'spec' && task.status === 'pending' && !input.previousRunId
    if (input.needsSpec && task && task.stage !== 'spec' && !['cancelled','revoked'].includes(task.status)) throw new FactoryError('factoryStale')
    if (task?.stage === 'spec' && !['cancelled','revoked'].includes(task.status)) {
      // A generic dispatch cannot replace a plan or act as its human approval.
      if (!pendingSpec) throw new FactoryError('factoryRunStillActive')
      if (input.sourceEventId && input.sourceEventId !== task.sourceEventId) throw new FactoryError('factorySourceMismatch')
      if (!input.needsSpec) throw new FactoryError('factoryStale')
    }
    let sourceEventId = input.sourceEventId ?? (pendingSpec ? task?.sourceEventId : undefined)
    if (!sourceEventId) {
      sourceEventId = factoryEventId('dispatch-source', `${userId}:${key}`)
      await tx.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,$4,'user_message',$5,$6) ON CONFLICT DO NOTHING`, [sourceEventId, userId, input.botId, input.issueId, `factory-dispatch:${key}`, JSON.stringify({ text: input.note?.trim() || 'Run this task.', source: 'host_dispatch' })])
      wakeCoordinatorAfterCommit(tx, userId)
    }
    // A direct owner follow-up is a new request epoch. Automatic repairs
    // reuse the task/source and must never replace their acceptance target.
    if (input.previousRunId && input.sourceEventId && task?.sourceEventId !== input.sourceEventId) {
      sourceEventId = await factoryContinuationSource(tx, { userId, issueId: input.issueId, botId: input.botId }, input.sourceEventId, input.previousRunId)
      const { rows: [source] } = await tx.query(`SELECT e."userId",e."botId",e."issueId",e.kind,e.payload,
        EXISTS(SELECT 1 FROM agent_runs r WHERE r.id::text=$2 AND r."userId"=$3 AND r."issueId"=$4) AS "parentOwned"
        FROM coordinator_events e WHERE e.id=$1`, [sourceEventId, input.previousRunId, userId, input.issueId])
      if (source?.payload?.source === 'thread_continuation') {
        if (source.userId !== userId || source.botId !== input.botId || source.issueId !== input.issueId || source.kind !== 'user_message' ||
          source.payload.previousRunId !== input.previousRunId || !source.parentOwned) throw new FactoryError('factorySourceMismatch')
        if (task && task.sourceEventId !== sourceEventId) {
          task = await runtime.store.lockTask(tx, userId, task.id)
          task = await advanceFactoryRequest(tx, task, sourceEventId)
        }
      }
    }
    if (task && !input.previousRunId && !pendingSpec && !['cancelled','revoked'].includes(task.status)) {
      await runtime.store.apply(userId, factoryBinding(task), factoryEventId('replace-thread', key), { action: 'cancel', reason: 'The person requested a new thread.' }, tx)
      task = undefined
    }
    if (task && input.previousRunId && !['cancelled','revoked'].includes(task.status)) {
      if (task.stage === 'execute' && task.status === 'running') {
        const { rows: [prior] } = await tx.query(`SELECT r.status FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId" WHERE a.id=$1`, [task.attemptId])
        if (prior && ['succeeded','completed','failed','stopped','cancelled'].includes(prior.status)) {
          task = (await runtime.store.apply(userId, factoryBinding(task), factoryEventId('continue-ended', key), { action: 'finish', status: 'blocked', reason: 'The person supplied more work after this execution ended.', evidence: [], output: {} }, tx)).task
        }
      }
      if (task.stage === 'execute' && ['failed','blocked','waiting'].includes(task.status))
        task = (await runtime.store.apply(userId, factoryBinding(task), factoryEventId('continue-retry', key), { action: 'retry', reason: input.note?.slice(0, 4000) || 'Continue the task.' }, tx)).task
      else if (['review','verify','monitor','approval'].includes(task.stage) && ['failed','blocked','waiting','pending'].includes(task.status)) {
        // Generic thread dispatch shares the host lifecycle's repair budget.
        // An authenticated new owner epoch already advanced to execute above.
        task = await runtime.store.lockTask(tx, userId, task.id)
        await checkFactoryRepairBudget(tx, task)
        task = (await runtime.store.apply(userId, factoryBinding(task), factoryEventId('continue-repair', key), { action: 'repair', reason: input.note?.slice(0, 4000) || 'Revise the candidate.' }, tx)).task
      } else if (task.status === 'passed') task = undefined
      if (task && (task.stage !== 'execute' || task.status !== 'pending')) throw new FactoryError('factoryRunStillActive')
    } else if (!pendingSpec) task = undefined
    if (!task) task = (await runtime.store.route(userId, { issueId: input.issueId, eventId: factoryEventId('host-route', key), sourceEventId, needsSpec: Boolean(input.needsSpec), rationale: 'Authenticated task dispatch; placement and model selected by the host.' }, tx)).task
    const dispatch = createFactoryDispatch(pool, runtime.store, input.queue)
    const result = await dispatch(userId, { binding: factoryBinding(task), agentId: input.agentId, deviceRepoId: input.deviceRepoId, ...(input.note ? { note: input.note } : {}) }, tx)
    if (input.previousRunId) await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1 AND "userId"=$3', [result.runId, input.previousRunId, userId])
    await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4)', [task.id, receiptId, JSON.stringify({ key, digest }), JSON.stringify({ runId: result.runId })])
    await tx.query('COMMIT')
    await notifyQueuedLocalRun(tx, userId, result.runId)
    return { runId: result.runId }
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  })
}
