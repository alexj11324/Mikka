import { withFactoryBackgroundWorkspace } from './background-workspace'
import { randomUUID } from 'node:crypto'
import { factoryChanged } from '../live/factory'
import { runControlChanged } from '../device-gateway-notify'
import type { Pool, PoolClient } from 'pg'
import { ActionFailureError } from '../action-error'
import { FactoryError, factoryFlowVersion } from './contract'
import { factoryEventId } from './event-id'
import type { FactoryTask } from './store'

/** Derive a continuation only from the raw authenticated owner event. A model's
 * dispatch note is never promoted to target authority. */
export async function factoryContinuationSource(tx: Pick<PoolClient, 'query'>, task: Pick<FactoryTask, 'userId' | 'issueId' | 'botId'>, sourceEventId: string, previousRunId: string) {
  const { rows: [source] } = await tx.query(`SELECT e.payload FROM coordinator_events e WHERE e.id=$1
    AND e."userId"=$2 AND e."botId" IS NOT DISTINCT FROM $3::uuid AND (e."issueId" IS NULL OR e."issueId"=$4)
    AND e.kind='user_message' AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=$5 AND r."userId"=$2 AND r."issueId"=$4)`,
  [sourceEventId, task.userId, task.botId, task.issueId, previousRunId])
  if (!source || typeof source.payload?.text !== 'string' || !source.payload.text.trim() || source.payload.text.length > 10000)
    throw new FactoryError('factorySourceMismatch')
  if (source.payload.source === 'thread_continuation') {
    if (source.payload.previousRunId !== previousRunId) throw new FactoryError('factorySourceMismatch')
    return sourceEventId
  }
  const id = factoryEventId('thread-source', `${sourceEventId}:${previousRunId}`)
  await tx.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt","createdAt")
    SELECT $1,$2,$3,$4,'user_message',$5,$6,'background',now(),"createdAt" FROM coordinator_events WHERE id=$7
    ON CONFLICT DO NOTHING`, [id, task.userId, task.botId, task.issueId, `thread-source:${id}`,
    JSON.stringify({ text: source.payload.text, source: 'thread_continuation', previousRunId, originEventId: sourceEventId, postedToChat: true }), sourceEventId])
  return id
}

/** For a direct owner HTTP action. This must never be called with an agent's
 * generated note; Coordinator callers instead pass their original event. */
export async function recordOwnerFactoryContinuation(pool: Pool, userId: string, runId: string, text: string) {
  const { rows: [source] } = await pool.query(`SELECT t."botId",t."issueId" FROM factory_attempts a JOIN factory_tasks t ON t.id=a."taskId"
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    WHERE r.id=$1 AND t."userId"=$2`, [runId, userId])
  if (!source) return undefined
  const id = randomUUID()
  await pool.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
    VALUES($1,$2,$3,$4,'user_message',$5,$6,'background',now()) ON CONFLICT DO NOTHING`, [id, userId, source.botId, source.issueId,
    `thread-continuation:${id}`, JSON.stringify({ text, source: 'thread_continuation', previousRunId: runId, postedToChat: true })])
  return id
}

/** An epoch is the immutable, authenticated owner event UUID, not the stage revision.
 * Call with the authorized task locked. History, candidates and external receipts
 * remain immutable; replacing the attempt fences callbacks from the old target. */
export async function advanceFactoryRequest(tx: PoolClient, task: FactoryTask, sourceEventId: string, supersededRunIds?: string[]) {
  const eventId = factoryEventId('request-epoch', sourceEventId)
  if (task.sourceEventId === sourceEventId) {
    if (supersededRunIds) {
      const { rows: [receipt] } = await tx.query('SELECT request FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])
      if (Array.isArray(receipt?.request?.supersededRunIds)) supersededRunIds.push(...receipt.request.supersededRunIds)
      else {
        // Compatibility for epochs admitted before the cleanup receipt existed.
        // The current epoch's new executor is never part of this stop set.
        const { rows } = await tx.query(`SELECT r.id FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
          WHERE a."taskId"=$1 AND a.id<>$2 AND a.output->>'requestEpoch' IS DISTINCT FROM $3
            AND r."userId"=$4 AND r."stopRequestedAt" IS NOT NULL`, [task.id, task.attemptId, sourceEventId, task.userId])
        supersededRunIds.push(...rows.map(row => row.id as string))
      }
    }
    return task
  }
  if (['cancelled', 'revoked'].includes(task.status)) throw new FactoryError('factoryStopped')
  if (factoryFlowVersion(task) === 2 && task.stage === 'spec') throw new FactoryError('factoryTransition')
  const { rows: [used] } = await tx.query('SELECT 1 FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2', [task.id, eventId])
  if (used) throw new FactoryError('factoryStale')
  const { rows: [source] } = await tx.query(`SELECT e.payload FROM coordinator_events e
    JOIN coordinator_events previous ON previous.id=$5
    WHERE e.id=$1 AND e."userId"=$2 AND e."issueId"=$3 AND e."botId" IS NOT DISTINCT FROM $4::uuid
      AND e.kind='user_message' AND e.payload->>'source'='thread_continuation'
      AND e."createdAt">=previous."createdAt"
      AND EXISTS (SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
        WHERE a."taskId"=$6 AND r.id::text=e.payload->>'previousRunId' AND r."userId"=$2 AND r."issueId"=$3)`,
  [sourceEventId, task.userId, task.issueId, task.botId, task.sourceEventId, task.id])
  if (typeof source?.payload?.text !== 'string' || !source.payload.text.trim() || source.payload.text.length > 10000)
    throw new FactoryError('factorySourceMismatch')
  const previousEpoch = task.sourceEventId
  await tx.query(`UPDATE factory_attempts SET output=output || $2::jsonb WHERE "taskId"=$1 AND NOT(output ? 'requestEpoch')`, [task.id, JSON.stringify({ requestEpoch: previousEpoch })])
  // The old worker cannot publish or submit for the new request. A still-running
  // executor is stopped before the existing dispatcher may start the next one.
  const { rows: fencedRuns } = await tx.query<{ id: string }>(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",now()),"updatedAt"=now()
    WHERE id IN (SELECT "runId" FROM factory_attempts WHERE "taskId"=$1)
      AND "userId"=$2 AND "issueId"=$3 AND status IN ('queued','preparing','running','paused','waiting_input','finishing') RETURNING id`, [task.id, task.userId, task.issueId])
  const stoppedRunIds = fencedRuns.map(run => run.id)
  runControlChanged(tx, { runIds: stoppedRunIds })
  supersededRunIds?.push(...stoppedRunIds)
  await tx.query(`UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",now())
    WHERE "userId"=$2 AND "runId" IN (SELECT "runId" FROM factory_attempts WHERE "taskId"=$1)`, [task.id, task.userId])
  await tx.query(`UPDATE factory_attempts SET status='cancelled',"finishedAt"=COALESCE("finishedAt",now()),
    reason='Superseded by an authenticated owner request',output=output || $3::jsonb
    WHERE id=$1 AND "taskId"=$2 AND status IN ('pending','running','waiting')`,
  [task.attemptId, task.id, JSON.stringify({ supersededBy: sourceEventId, requestEpoch: previousEpoch })])
  const attemptId = randomUUID()
  await tx.query(`UPDATE factory_questions SET status='superseded',reason='The owner supplied a new request epoch',revision=revision+1,"updatedAt"=now()
    WHERE "taskId"=$1 AND "userId"=$2 AND status IN ('open','waiting_user','answered','resuming')`, [task.id, task.userId])
  await tx.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,reason,output)
    SELECT $1,$2,'execute',COALESCE(max(ordinal) FILTER(WHERE stage='execute'),0)+1,COALESCE(max(position),0)+1,
      'pending','Continue the current owner request',$3 FROM factory_attempts WHERE "taskId"=$2`,
  [attemptId, task.id, JSON.stringify({ requestEpoch: sourceEventId, previousRequestEpoch: previousEpoch })])
  const { rows: [next] } = await tx.query<FactoryTask>(`UPDATE factory_tasks SET "sourceEventId"=$2,"attemptId"=$3,
    "candidateId"=NULL,stage='execute',status='pending',revision=revision+1,
    reason='Owner continued this task with a new request',"updatedAt"=now() WHERE id=$1 RETURNING *`, [task.id, sourceEventId, attemptId])
  await tx.query('INSERT INTO factory_events("taskId","eventId",request,result) VALUES($1,$2,$3,$4)',
    [task.id, eventId, JSON.stringify({ kind: 'request_epoch', sourceEventId, previousEpoch, previousRunId: source.payload.previousRunId, supersededRunIds: stoppedRunIds }),
      JSON.stringify({ task: next, requestEpoch: sourceEventId })])
  await factoryChanged(tx, next)
  return next
}

/** Owner messages to an active thread use the same epoch path as terminal
 * continuations. Peer/model messages never call this entry point. */
export async function continueActiveFactoryRequest(pool: Pool, userId: string, runId: string, text: string, sourceEventId?: string, submission?: { recordOwnerMessage: true; interrupt?: boolean }) {
  const { rows: [identity] } = await pool.query(`SELECT t.id,t."botId",t."issueId" FROM factory_attempts a
    JOIN factory_tasks t ON t.id=a."taskId" WHERE a."runId"=$1 AND t."userId"=$2`, [runId, userId])
  if (!identity) return false
  const { factoryRuntimeForBot } = await import('./runtime')
  const store = factoryRuntimeForBot(identity.botId).store
  const supersededRunIds: string[] = []
  const changed = await withFactoryBackgroundWorkspace(pool, userId, { kind: 'task', id: identity.id, botId: identity.botId }, async () => {
  const tx = await pool.connect()
  try {
    await tx.query('BEGIN')
    const task = await store.lockTask(tx, userId, identity.id)
    // The caller uses ordinary owner-message delivery for a planner. A plan
    // clarification must neither acknowledge an unread message nor approve it.
    if (factoryFlowVersion(task) === 2 && task.stage === 'spec') { await tx.query('COMMIT'); return false }
    // Coordinator handoff can forward the dispatch's already accepted owner
    // event. It adds no new request and must not stop its current executor.
    if (sourceEventId === task.sourceEventId && !['cancelled', 'revoked'].includes(task.status)) {
      await tx.query('COMMIT'); return 'replayed' as const
    }
    // A second window may still show the previous turn while its device
    // acknowledges a stop. Only this exact active attempt can be interrupted.
    if (submission?.interrupt) {
      const current = await tx.query(`SELECT 1 FROM factory_attempts a JOIN agent_runs r ON r.id=a."runId"
        WHERE a.id=$1 AND a."taskId"=$2 AND a.status='running' AND r.id=$3
          AND r."userId"=$4 AND r."workspaceId"=$5 AND r."issueId"=$6
          AND r.status IN ('preparing','running','finishing','queued') AND r."stopRequestedAt" IS NULL FOR UPDATE OF r`,
      [task.attemptId, task.id, runId, userId, task.workspaceId, task.issueId])
      if (task.status !== 'running' || !current.rowCount) throw new ActionFailureError('threadDeliveryUnavailable')
    }
    const id = sourceEventId ? await factoryContinuationSource(tx, task, sourceEventId, runId) : randomUUID()
    if (!sourceEventId) await tx.query(`INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt")
      VALUES($1,$2,$3,$4,'user_message',$5,$6,'background',now()) ON CONFLICT DO NOTHING`, [id, userId, task.botId, task.issueId, `thread-continuation:${id}`,
      JSON.stringify({ text, source: 'thread_continuation', previousRunId: runId, postedToChat: true })])
    await advanceFactoryRequest(tx, task, id, supersededRunIds)
    if (!sourceEventId || submission?.recordOwnerMessage) await tx.query(`INSERT INTO run_messages(id,"runId","userId",text,origin,"mailboxWakeDepth","deliveredAt")
      VALUES($1,$2,$3,$4,'owner',-1,now()) ON CONFLICT DO NOTHING`, [id, runId, userId, text])
    await tx.query('COMMIT')
  } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  return true
  })
  if (changed === 'replayed') return true
  if (!changed) return false
  // A fenced queued run can no longer be claimed, so no executor will acknowledge
  // its stop. Use the ordinary exact-run stop after the epoch commits; its end
  // hook can then admit the current epoch through the normal reconciler. Never
  // use the chain-stop helper here: a replay may arrive after that hook already
  // created a new continuation, which must not be stopped by the old request.
  const [{ db }, { stopOwnedRun }, { afterRunEnded }] = await Promise.all([
    import('../db'), import('../run-control'), import('../run-completion-effects'),
  ])
  for (const supersededRunId of new Set(supersededRunIds)) {
    let ended = false
    try { ended = await stopOwnedRun(db, userId, supersededRunId) }
    catch (error) {
      if (!(error instanceof ActionFailureError && error.code === 'runNotFound')) throw error
      ended = true // The exact old run already ended; its hook is safe to replay.
    }
    if (ended) await afterRunEnded(userId, supersededRunId)
  }
  // The observed run may have ended (and completed its old hook) before this
  // transaction acquired the task lock, leaving no newly fenced runs. Re-read
  // the admitted epoch now; the reconciler's active-run guard keeps this safe
  // when an executor is still acknowledging its stop or a new one already ran.
  await afterRunEnded(userId, runId)
  return true
}
