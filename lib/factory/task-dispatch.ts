import 'server-only'
import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { FactoryError } from './contract'
import { factoryBinding, type FactoryDispatchOptions } from './dispatch'
import { maskFactoryNote } from './note-mask'
import { factoryEventId } from './event-id'
import type { FactoryTask } from './store'
import type { FactoryRunSelection } from '@/lib/agent-runs'

type Request = {
  issueId: string; agentId: string; deviceRepoId: string; note?: string; requestKey?: string
  sourceEventId?: string; threadRunId?: string
}

/** Host entry for ordinary dispatches. Route/recovery, queue, frozen assignment,
 * attempt binding and request receipt share one commit. Placement is already decided. */
export async function dispatchFactoryTaskRun(userId: string, botId: string | null, input: Request, options: FactoryDispatchOptions = {}) {
  const { factoryRuntimeForBot } = await import('./runtime')
  const requestedRuntime = factoryRuntimeForBot(botId)
  let runtime = requestedRuntime
  input = { ...input, ...(input.note !== undefined ? { note: maskFactoryNote(input.note) } : {}) }
  const tx = await pool.connect()
  const key = input.requestKey ?? randomUUID()
  const eventId = factoryEventId('task-dispatch', JSON.stringify([userId, input.issueId, botId, key]))
  const request = { ...input, requestKey: key, options }
  try {
    await tx.query('BEGIN')
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([userId, input.issueId])])
    const receipt = (await tx.query(`SELECT e.result,e.request=$2::jsonb AS same,t.id,t."botId" FROM factory_events e
      JOIN factory_tasks t ON t.id=e."taskId" WHERE e."eventId"=$1 AND t."userId"=$3 AND t."issueId"=$4`,
    [eventId, JSON.stringify(request), userId, input.issueId])).rows[0]
    if (receipt) {
      runtime = factoryRuntimeForBot(receipt.botId)
      const current = await runtime.store.lockTask(tx, userId, receipt.id)
      if (['cancelled','revoked'].includes(current.status)) throw new FactoryError('factoryStopped')
      if (!receipt.same) throw new FactoryError('factoryReplayMismatch')
      await tx.query('COMMIT')
      return { ...receipt.result, replayed: true } as { runId: string; status: 'queued'; replayed: boolean }
    }
    const latest = (await tx.query<FactoryTask>(`SELECT * FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2
      ORDER BY EXISTS (SELECT 1 FROM factory_attempts a WHERE a."taskId"=factory_tasks.id AND a."runId"=$3::uuid) DESC,"createdAt" DESC,id DESC LIMIT 1`, [userId, input.issueId, input.threadRunId ?? null])).rows[0]
    if (latest) runtime = factoryRuntimeForBot(latest.botId)
    let task = latest ? await runtime.store.lockTask(tx, userId, latest.id) : null
    if (task && task.status === 'passed' && ['approval','publish','monitor'].includes(task.stage)) task = null
    if (task && !['cancelled', 'revoked'].includes(task.status)) {
      const attempt = (await tx.query('SELECT "runId" FROM factory_attempts WHERE id=$1', [task.attemptId])).rows[0]
      // An explicit new thread/repository replaces the old task. A routed,
      // unbound intake can be used by its first ordinary dispatch.
      if (!input.threadRunId && attempt?.runId) {
        await runtime.store.apply(userId, factoryBinding(task), factoryEventId('replace-task', eventId), { action: 'cancel', reason: 'The person started a new thread' }, tx)
        task = null
      } else if (input.threadRunId) {
        if (task.status === 'running' && attempt?.runId === input.threadRunId) {
          const run = (await tx.query('SELECT status FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE',[input.threadRunId,userId])).rows[0];
          if (run && !['queued','preparing','running','waiting_input','finishing','paused'].includes(run.status)) {
            task = (await runtime.store.apply(userId,factoryBinding(task),factoryEventId('dispatch-ended',eventId),{action:'finish',status:'blocked',reason:'The previous run ended; the person supplied follow-up work',evidence:[],output:{runId:input.threadRunId}},tx)).task;
          }
        }
        if (task.stage === 'execute' && ['failed', 'blocked', 'waiting'].includes(task.status)) {
          task = (await runtime.store.apply(userId, factoryBinding(task), factoryEventId('dispatch-retry', eventId), { action: 'retry', reason: 'Continue the task with the new request' }, tx)).task
        } else if (['review', 'verify', 'monitor', 'approval'].includes(task.stage) && !(task.stage === 'publish' || (task.stage === 'monitor' && task.status === 'passed'))) {
          // Checks already running must stop before the replacement execute run.
          if (['pending', 'running'].includes(task.status) && task.stage !== 'approval') {
            await stopCurrentCheck(tx, task)
            task = (await runtime.store.apply(userId, factoryBinding(task), factoryEventId('dispatch-interrupt', eventId), { action: 'finish', status: 'blocked', reason: 'New work invalidates the previous candidate', evidence: [], output: {} }, tx)).task
          }
          task = (await runtime.store.apply(userId, factoryBinding(task), factoryEventId('dispatch-repair', eventId), { action: 'repair', reason: 'New work requires a fresh candidate and independent checks' }, tx)).task
        } else if (['publish', 'monitor'].includes(task.stage) || task.status === 'passed') task = null
      }
    } else task = null
    if (!task) {
      runtime = requestedRuntime
      const sourceEventId = await dispatchSource(tx, userId, botId, input, eventId)
      task = (await runtime.store.route(userId, { issueId: input.issueId, eventId: factoryEventId('dispatch-route', eventId), sourceEventId, rationale: 'Authorized task dispatch through Factory', missingInformation: [], missingPermissions: [], needsSpec: false }, tx)).task
    }
    const result = await runtime.dispatch(userId, { binding: factoryBinding(task), agentId: input.agentId, deviceRepoId: input.deviceRepoId, ...(input.note ? { note: input.note } : {}) }, tx, options)
    if (input.threadRunId) await tx.query('UPDATE agent_runs SET "continuesRunId"=$2 WHERE id=$1 AND "userId"=$3 AND id<>$2', [result.runId, input.threadRunId, userId])
    const queued = { runId: result.runId, status: 'queued' as const, replayed: result.replayed }
    await tx.query('INSERT INTO factory_events ("taskId","eventId",request,result) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [task.id, eventId, JSON.stringify(request), JSON.stringify(queued)])
    await tx.query('COMMIT')
    return queued
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
}

async function stopCurrentCheck(tx: PoolClient, task: FactoryTask) {
  // A new execute attempt cannot race a still-live check. Keep its immutable
  // completion history and use the same stop fence checked by workers.
  await tx.query(`UPDATE agent_runs SET "stopRequestedAt"=coalesce("stopRequestedAt",now()),status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    "finishedAt"=CASE WHEN status='queued' THEN now() ELSE "finishedAt" END WHERE id=(SELECT "runId" FROM factory_attempts WHERE id=$1) AND status IN ('queued','preparing','running','waiting_input','finishing')`, [task.attemptId])
}

async function dispatchSource(tx: PoolClient, userId: string, botId: string | null, input: Request, eventId: string) {
  let text = input.note ?? `Dispatch issue ${input.issueId}`
  if (input.sourceEventId) {
    const source = (await tx.query(`SELECT payload FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND "botId" IS NOT DISTINCT FROM $3::uuid AND kind='user_message' AND ("issueId" IS NULL OR "issueId"=$4)`, [input.sourceEventId, userId, botId, input.issueId])).rows[0]
    if (!source) throw new FactoryError('factorySourceMismatch')
    if (!(await tx.query('SELECT 1 FROM factory_tasks WHERE "userId"=$1 AND "issueId"=$2 AND "sourceEventId"=$3', [userId, input.issueId, input.sourceEventId])).rowCount) return input.sourceEventId
    text = source.payload?.text ?? text
  }
  const id = factoryEventId('dispatch-source', eventId)
  await tx.query(`INSERT INTO coordinator_events (id,"userId","botId","issueId",kind,"dedupeKey",payload) VALUES ($1,$2,$3,$4,'user_message',$5,$6) ON CONFLICT DO NOTHING`, [id, userId, botId, input.issueId, `factory-dispatch:${eventId}`, JSON.stringify({ text: maskFactoryNote(text), source: 'host_dispatch', ...(input.sourceEventId ? { sourceEventId: input.sourceEventId } : {}) })])
  return id
}

/** Local placement adapter used after the existing model/device rules. */
export async function queueFactoryTask(userId: string, input: { issueId: string; agentId: string; repo: string; note?: string; requestKey?: string; threadRunId?: string } & FactoryRunSelection, botId: string | null, execution?: FactoryRunSelection['execution'], sourceEventId?: string) {
  const { factoryLifecycleEnabled } = await import('./runtime')
  if (!factoryLifecycleEnabled()) throw new FactoryError('factoryLifecycleUnavailable')
  const agent = (await pool.query('SELECT "deviceId" FROM agents WHERE id=$1 AND "userId"=$2', [input.agentId, userId])).rows[0]
  if (!agent?.deviceId) throw new FactoryError('factoryRunMismatch')
  const repo = await ensureDeviceRepository(userId, agent.deviceId, input.repo)
  const { model, subscriptionBindingId, apiKeyId, pinnedDeviceId, readOnly } = input
  return dispatchFactoryTaskRun(userId, botId, { issueId: input.issueId, agentId: input.agentId, deviceRepoId: repo.id, note: input.note, requestKey: input.requestKey, threadRunId: input.threadRunId, sourceEventId }, { selection: { model, subscriptionBindingId, apiKeyId, pinnedDeviceId, readOnly, execution } })
}

/** Ordinary cloud entry, after selecting the Bot runtime/model. Starts its
 * machine only after the Factory transaction has committed. */
export async function queueFactoryCloudTask(userId: string, botId: string | null, input: Request, cloud: NonNullable<FactoryDispatchOptions['cloud']>, selection: FactoryRunSelection) {
  const queued = await dispatchFactoryTaskRun(userId,botId,input,{cloud,selection})
  const task = (await pool.query('SELECT "taskId" FROM factory_attempts WHERE "runId"=$1',[queued.runId])).rows[0]
  if (task) await (await import('./next-dispatch')).startFactoryCloudRuns(pool,userId,task.taskId)
  return queued
}
