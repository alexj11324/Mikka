import { and, gt, like } from 'drizzle-orm'
import { db } from '@/lib/db'
import { coordinatorSessions } from '@/lib/db/schema'
import { releaseLease, retryFailedTurn } from './store'

/** A Workflow run's state as `getRun(id).status` reports it. */
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | (string & {})

export interface InterruptedTurnDeps {
  /** Chats whose lease a Workflow run holds now. */
  leased: () => Promise<{ userId: string; botId: string; holder: string }[]>
  status: (runId: string) => Promise<RunStatus>
  release: (userId: string, holder: string, botId: string) => Promise<unknown>
  retry: (userId: string, botId: string) => Promise<boolean>
}

const ENDED = new Set<RunStatus>(['failed', 'cancelled', 'completed'])

/**
 * A run that ended without letting go of its chat lease, for example because
 * a deploy changed its steps and its replay failed, would hold the chat as
 * 正在处理 until the 10-minute lease ran out, and the message it had taken would
 * wait for a click on 重试. Each wake sweep finds such a lease, lets it go and
 * queues the same retry 重试 does, so the next turn answers the message that
 * was already in the chat (shown once, no failure mark) and nothing is lost.
 * A run whose state cannot be read is left alone; the lease expiry still
 * frees it.
 */
export async function recoverInterruptedTurns(deps: InterruptedTurnDeps = defaultDeps()) {
  const counts = { checked: 0, recovered: 0, retried: 0 }
  for (const chat of await deps.leased()) {
    counts.checked++
    let status: RunStatus
    try { status = await deps.status(chat.holder) } catch { continue }
    if (!ENDED.has(status)) continue
    await deps.release(chat.userId, chat.holder, chat.botId)
    counts.recovered++
    // The retry is a new inbox event: the wake sweep that called this starts its turn (lib/coordinator/wake.ts).
    const retried = await deps.retry(chat.userId, chat.botId)
    if (retried) counts.retried++
    console.warn(JSON.stringify({ msg: 'coordinator_turn_interrupted', workflowRunId: chat.holder, status, retried }))
  }
  return counts
}

function defaultDeps(): InterruptedTurnDeps {
  return {
    leased: async () => (await db.select({ userId: coordinatorSessions.userId, botId: coordinatorSessions.botId, holder: coordinatorSessions.leaseHolder }).from(coordinatorSessions)
      .where(and(like(coordinatorSessions.leaseHolder, 'wrun_%'), gt(coordinatorSessions.leaseUntil, new Date()))))
      .flatMap(row => row.botId && row.holder ? [{ userId: row.userId, botId: row.botId, holder: row.holder }] : []),
    status: async runId => (await import('workflow/api')).getRun(runId).status,
    release: releaseLease,
    retry: retryFailedTurn,
  }
}
