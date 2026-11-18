import 'server-only'
import { LEASED_RUN_STATUSES } from './run-retry'
import { db, pool } from './db'
import { armDueTimerSoon } from './due-timer'
import { runListChanged } from './live/lists'
import { runChanged } from './live/panels'
import { notifyDeviceWork } from './device-gateway-notify'
import { ActionFailureError } from './action-error'
import { revalidateExecutionIdentity, ExecutionIdentityError } from './execution-identity'
import { withTaskWorkspace } from './task-workspace'
import type { WorkerDefinitionSnapshot } from '@/lib/agent-kit/worker'

/**
 * A run keeps its lease only while its requester may still run it
 * (decision 2026-11-17-2215). Nothing rechecks that on a timer: the change that
 * takes the authority away calls this once it has committed. It checks every
 * leased run in scope as lease renewal used to (workspace membership, the
 * frozen execution identity, a live bound task, a Bot that is not archived),
 * ends the lease of each run that fails, and pushes the stop to its device.
 */
export type RunAuthorityScope = { workspaceId?: string; userId?: string; issueId?: string; botId?: string }

type LeasedRun = { id: string; userId: string; workspaceId: string | null; deviceId: string | null; botId: string | null; agentDefinition: WorkerDefinitionSnapshot | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function stillAuthorized(run: LeasedRun): Promise<boolean> {
  if (!run.workspaceId || (run.agentDefinition?.executionIdentity?.workspaceId
    && run.agentDefinition.executionIdentity.workspaceId !== run.workspaceId)) return false
  try {
    return await withTaskWorkspace(run.userId, run.workspaceId, async () => {
      await revalidateExecutionIdentity(pool, run)
      const { rows: [row] } = await pool.query<{ ok: boolean }>(`SELECT
          (r."issueId" IS NULL OR EXISTS (SELECT 1 FROM issues task WHERE task.id=r."issueId"
            AND task."workspaceId"=r."workspaceId" AND task."ownershipState"='bound'
            AND coalesce(task.content->'attrs'->'mikka',task.content->'attrs'->'orvilo')->>'deletedAt' IS NULL))
          AND (r."botId" IS NULL OR EXISTS (SELECT 1 FROM bots bot WHERE bot.id=r."botId"
            AND bot."workspaceId"=r."workspaceId" AND bot."archivedAt" IS NULL)) AS ok
        FROM agent_runs r WHERE r.id=$1`, [run.id])
      return row?.ok === true
    })
  } catch (error) {
    if (error instanceof ExecutionIdentityError || (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied')) return false
    throw error
  }
}

/** Returns the runs it stopped. Never throws: the change that called it has already committed. */
export async function stopRunsWithoutAuthority(scope: RunAuthorityScope): Promise<string[]> {
  const filters: string[] = [], values: unknown[] = [[...LEASED_RUN_STATUSES]]
  for (const [column, value] of [['workspaceId', scope.workspaceId], ['userId', scope.userId], ['issueId', scope.issueId], ['botId', scope.botId]] as const) {
    if (value === undefined) continue
    if (column !== 'userId' && !UUID.test(value)) return []
    values.push(value)
    filters.push(`"${column}"=$${values.length}`)
  }
  if (!filters.length) return []
  try {
    const { rows } = await pool.query<LeasedRun>(`SELECT id,"userId","workspaceId","deviceId","botId","agentDefinition" FROM agent_runs
      WHERE status=ANY($1::text[]) AND "leaseExpiresAt">clock_timestamp() AND ${filters.join(' AND ')} LIMIT 500`, values)
    const stopped: string[] = []
    for (const run of rows) {
      if (await stillAuthorized(run)) continue
      const ended = await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",clock_timestamp()),
          "leaseExpiresAt"=clock_timestamp(), "updatedAt"=clock_timestamp()
        WHERE id=$1 AND status=ANY($2::text[]) AND "leaseExpiresAt">clock_timestamp()`, [run.id, [...LEASED_RUN_STATUSES]])
      if (!ended.rowCount) continue
      stopped.push(run.id)
      // The daemon reads the stop on its next commands read, which this push starts.
      notifyDeviceWork(run.deviceId)
      await runListChanged(db, run.id); await runChanged(db, run.id)
    }
    if (stopped.length) armDueTimerSoon('run-recovery')
    return stopped
  } catch (error) {
    console.error(JSON.stringify({ msg: 'run_authority_stop_failed', error: error instanceof Error ? error.name : 'unknown' }))
    return []
  }
}
