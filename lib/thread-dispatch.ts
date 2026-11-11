import 'server-only'
import { runListChanged } from './live/lists'
import type { PoolClient } from 'pg'
import { ActionFailureError } from '@/lib/action-error'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { db, pool } from '@/lib/db'
import { readRunChain } from '@/lib/run-chain'
import { sendOwnedRunMessage } from '@/lib/run-control'
import { continuationNote } from '@/lib/thread-continuation'
export { continuationNote } from '@/lib/thread-continuation'

// One task, one thread (decision 2026-11-01-1330-one-thread-per-task, R-81).
// Every dispatch entry (the Coordinator's and any bot's dispatch tools, the
// Bot computer API, MCP) goes through `dispatchToTask`: a task that already
// has a thread of this person's gets the dispatch as more work for that
// thread, never a second thread.
//   - The thread is still working: the note goes in as a message (the agent
//     reads it on its next poll).
//   - The thread ended (done, failed, stopped): it runs again as the next run
//     of the same thread ("continuesRunId"). On the same device in the same
//     worktree the agent's session is resumed with only the note; elsewhere
//     the new session gets the full brief with the thread's earlier outcome.
//   - Only when the person explicitly asked for a new thread, in their own
//     words as judged by the Decision API, does a new thread start; the old
//     one is stopped and marked replaced ("threadReplacedBy" on its root).
// Factory attempts and the server's own recovery runs (lost machine, used-up
// quota) are continuations already and do not come through here.

/** What a dispatch did to the task's thread. */
export type ThreadDispatch<R extends { runId: string }> =
  | (R & { thread: 'new'; threadId: string; replacedThreadId?: string })
  | { thread: 'existing'; runId: string; threadId: string }
  | { thread: 'message'; runId: string; threadId: string; status: 'messageSent' | 'alreadyWorking' }
  | (R & { thread: 'continued'; threadId: string; continuesRunId: string })

/** The latest run of the person's thread on the task, with where it ran. */
export type TaskThreadRun = {
  id: string; status: string; stopRequestedAt: Date | null; agentId: string; deviceRepoId: string | null
  botId: string | null; remoteUrl: string | null; harness: string | null; readOnly: boolean
  allowLocalRecovery?: boolean
  cloud: { workspaceId: string; botId: string } | null
  stopReason: string | null; error: string | null; summary: string | null; lastReply: string | null
}

type Query = Pick<PoolClient, 'query'>

/** The newest run this person started on the task (a group chat's run is not a task thread). */
export async function latestTaskRun(query: Query, userId: string, issueId: string): Promise<TaskThreadRun | null> {
  const { rows: [run] } = await query.query(`SELECT r.id,r.status,r."stopRequestedAt",r."agentId",r."deviceRepoId",r."botId",r."stopReason",r.error,
      r.report->>'summary' AS summary,r."lastReply",d."remoteUrl",
      coalesce(r."agentDefinition"->>'harness',a.harness) AS harness,coalesce((r."agentDefinition"->>'readOnly')::boolean,false) AS "readOnly",
      (r."agentDefinition"->>'allowLocalRecovery')='true' AS "allowLocalRecovery",
      b."workspaceId" AS "cloudWorkspaceId",b."botId" AS "cloudBotId"
    FROM agent_runs r JOIN agents a ON a.id=r."agentId"
    LEFT JOIN device_repos d ON d.id=r."deviceRepoId"
    LEFT JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE r."userId"=$1 AND r."issueId"=$2 AND r.kind<>'group_chat'
      AND NOT EXISTS (SELECT 1 FROM factory_attempts fa WHERE fa."runId"=r.id AND fa.stage IN ('review','verify','monitor'))
    ORDER BY r."createdAt" DESC,r.id DESC LIMIT 1`, [userId, issueId])
  if (!run) return null
  const { cloudWorkspaceId, cloudBotId, ...rest } = run
  return { ...rest, cloud: cloudWorkspaceId && cloudBotId ? { workspaceId: cloudWorkspaceId, botId: cloudBotId } : null } as TaskThreadRun
}

/** Serializes dispatches to one person's task, so two at once cannot both start a thread. */
async function withTaskLock<T>(userId: string, issueId: string, work: () => Promise<T>): Promise<T> {
  const client = await pool.connect()
  const key = JSON.stringify(['task-thread', userId, issueId])
  let discard = false
  try {
    // PgBouncer transaction pooling cannot preserve session advisory locks.
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key])
    const result = await work()
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { discard = true }
    throw error
  } finally { client.release(discard) }
}

/**
 * Whether the person asked, in their own words, for a new session or thread
 * instead of the task's existing one (a different agent, starting over).
 * Judged by the Decision API from their message; anything else, an
 * unavailable judgment included, keeps the existing thread.
 */
export async function explicitNewThread(userId: string, botId: string | null, sourceEventId: string | undefined): Promise<boolean> {
  if (!sourceEventId) return false
  const { rows: [event] } = await pool.query(`SELECT payload->>'text' AS text FROM coordinator_events WHERE id=$1 AND "userId"=$2 AND kind='user_message' AND "botId" IS NOT DISTINCT FROM $3::uuid`, [sourceEventId, userId, botId])
  const text = typeof event?.text === 'string' ? event.text.trim() : ''
  if (!text) return false
  const [{ hostedBillingScope }, { executionWorkspace }, { invokeDecision }, { decideNewThread }] = await Promise.all([
    import('@/lib/abuse/context'), import('@/lib/execution-settings'), import('@/lib/coordinator/decide'), import('@/lib/thread-switch')])
  const workspaceId = await executionWorkspace(userId, botId).catch(() => null)
  if (!workspaceId) return false
  return hostedBillingScope.run({ workspaceId, ownerId: userId }, () => decideNewThread(text, invokeDecision))
}

/**
 * The one way a dispatch reaches a task. `start` queues a run the usual way
 * (a new thread, or the thread's next run when `previous` is set); its result
 * must carry the new run's id.
 */
export async function dispatchToTask<R extends { runId: string }, E extends { error: string } = never>(userId: string, issueId: string, input: {
  note?: string
  /** Host-bound raw owner turn, never a model-generated dispatch note. */
  sourceEventId?: string
  /** A host receipt bound this exact Task to the explicit creation command. */
  creation?: { eventId: string; botId: string; workspaceId: string }
  /** A browser submission already bound its original target before taking the task lock. */
  expectedRunId?: string
  /** The caller asked for a new thread; it is granted only when `explicit()` says the person asked for it. */
  newThread?: boolean
  /** The dispatch names another place than where the thread ran: moving a thread is a new thread, granted the same way. */
  moves?: (previous: TaskThreadRun) => Promise<boolean>
  explicit?: () => Promise<boolean>
  /** `replaces`: the thread a new thread replaces, so it can keep that thread's repository when none is named. */
  start: (previous: TaskThreadRun | null, note: string | undefined, replaces?: TaskThreadRun) => Promise<R | E>
}): Promise<ThreadDispatch<R> | E> {
  // An error the caller can act on (no machine, say) queued nothing; it goes back as it is.
  const queued = (result: R | E): result is R => 'runId' in result && typeof result.runId === 'string'
  return withTaskLock(userId, issueId, async () => {
    if (input.creation) {
      const { eventId, botId, workspaceId } = input.creation
      // The Factory event and its physical Run commit together. Replaying the
      // human turn after completion must not start a continuation or send a note.
      const prior = await pool.query<{ id: string }>(`SELECT r.id FROM factory_tasks t
        JOIN factory_events e ON e."taskId"=t.id AND e.request->>'sourceEventId'=$4
        JOIN agent_runs r ON r.id::text=e.result->>'runId' AND r."userId"=t."userId"
          AND r."issueId"=t."issueId" AND r."workspaceId"=$5
        WHERE t."userId"=$1 AND t."issueId"=$2 AND t."botId"=$3
        ORDER BY r."createdAt",r.id LIMIT 1`, [userId, issueId, botId, eventId, workspaceId])
      if (prior.rows[0]) {
        const runId = prior.rows[0].id
        const chain = await readRunChain(pool, userId, runId)
        return { thread: 'existing' as const, runId, threadId: chain?.rootRunId ?? runId }
      }
    }
    const previous = await latestTaskRun(pool, userId, issueId)
    if (input.expectedRunId && previous?.id !== input.expectedRunId) throw new ActionFailureError('threadReplaced')
    if (!previous) {
      const result = await input.start(null, input.note)
      return queued(result) ? { ...result, thread: 'new' as const, threadId: result.runId } : result
    }
    const chain = await readRunChain(pool, userId, previous.id)
    const threadId = chain?.rootRunId ?? previous.id
    const working = UNFINISHED_RUN_STATUSES.some(status => status === previous.status)
    // A move is judged even when the caller asked for a new thread: the person naming the other place is what grants it.
    const moves = await input.moves?.(previous) ?? false
    const wantsNew = input.newThread || moves
    if (wantsNew && await (input.explicit?.() ?? Promise.resolve(false))) {
      // The old thread stops; one thread works on a task at a time.
      if (working) {
        // A previous epoch may already have requested this stop. Queued runs
        // still need the canonical stop to finish; a flag alone is not an ack.
        try { await (await import('@/lib/agent-runs')).requestRunStop(userId, previous.id) }
        catch (error) { if (!(error instanceof ActionFailureError && error.code === 'runChainEnded')) throw error }
      }
      const result = await input.start(null, input.note, previous)
      if (!queued(result)) return result
      const replaced = await db.execute((await import('drizzle-orm')).sql`UPDATE agent_runs SET "threadReplacedBy"=${result.runId}::uuid,"updatedAt"=now() WHERE id=${threadId}::uuid AND "userId"=${userId} RETURNING id`)
      if (replaced.rowCount) { await runListChanged(db, threadId); await runChanged(db, threadId) }
      return { ...result, thread: 'new' as const, threadId: result.runId, replacedThreadId: threadId }
    }
    if (working) {
      // Stopping: its next run would race it for the worktree. The person can send again once it has stopped.
      if (previous.stopRequestedAt) throw new ActionFailureError('threadStopping')
      if (!input.note?.trim()) return { thread: 'message' as const, runId: previous.id, threadId, status: 'alreadyWorking' as const }
      await sendOwnedRunMessage(db, userId, { runId: previous.id, text: input.note.trim() })
      if (input.sourceEventId) await (await import('@/lib/factory/request-epoch')).continueActiveFactoryRequest(pool, userId, previous.id, input.note.trim(), input.sourceEventId)
      return { thread: 'message' as const, runId: previous.id, threadId, status: 'messageSent' as const }
    }
    const result = await input.start(previous, continuationNote(input.note, previous))
    if (!queued(result)) return result
    const continued = await db.execute((await import('drizzle-orm')).sql`UPDATE agent_runs SET "continuesRunId"=${previous.id}::uuid,"updatedAt"=now() WHERE id=${result.runId}::uuid AND "userId"=${userId} AND id<>${previous.id}::uuid RETURNING id`)
    if (continued.rowCount) { await runListChanged(db, result.runId); await runChanged(db, result.runId) }
    return { ...result, thread: 'continued' as const, threadId, continuesRunId: previous.id }
  })
}

import { runChanged } from './live/panels'
