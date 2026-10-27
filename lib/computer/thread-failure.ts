import 'server-only'
import type { Pool } from 'pg'
import { db } from '@/lib/db'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { finishSuggestionRun } from '@/lib/suggestions/execution'
import { ThreadMachines } from './thread-machine'
import { threadMachineProvider } from './e2b-provider'

/** A provisioning failure is a real failed run, never an invented queued
 * success. Only an unclaimed run can be ended by this path. */
export async function failThreadProvision(pool: Pool, actor: { userId: string; workspaceId: string }, runId: string) {
  const result = await pool.query(`UPDATE agent_runs r SET status='failed',"stopReason"='error',error='Cloud thread could not start',"finishedAt"=now(),"updatedAt"=now()
    FROM computer_run_bindings b WHERE b."runId"=r.id AND b."workspaceId"=$2 AND b."ownerId"=$3
      AND r.id=$1 AND r."userId"=$3 AND r.status='queued' AND r."deviceId" IS NULL
    RETURNING r.id,r."userId",r."botId",r."issueId",r.kind`, [runId, actor.workspaceId, actor.userId])
  const run = result.rows[0]
  if (!run) return
  await finishSuggestionRun(pool, actor.userId, runId, 'failed')
  await recordCoordinatorEvent(db, runFinishedEvent({ ...run, status: 'failed', stopReason: 'error', report: null }))
  await wakeCoordinator(actor.userId)
  // No worker claimed this run, so no worktree can contain user changes.
  await new ThreadMachines(pool, threadMachineProvider).end(actor, runId).catch(() => undefined)
}
