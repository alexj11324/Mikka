import { sql } from 'drizzle-orm'
import { deviceSessionOpenSql } from './device-presence'
import { agentRuns } from './db/schema'
import { correlatedColumn } from './db/correlated-column'
import { runFailureBrief } from './run-failure-projection'

/** The 30-day run list is a rolling duration, including across daylight-saving changes. */
export const runHistoryWindow = sql`interval '720 hours'`

const run = {
  id: correlatedColumn(agentRuns.id), userId: correlatedColumn(agentRuns.userId),
  status: correlatedColumn(agentRuns.status), stopRequestedAt: correlatedColumn(agentRuns.stopRequestedAt),
  deviceId: correlatedColumn(agentRuns.deviceId),
}

/** Bounded facts, joined into existing batch/history reads. No provider text or per-task reads. */
export const runAwaitingApproval = sql<boolean>`exists (select 1 from run_publications p where p."runId"=${run.id} and p."userId"=${run.userId} and p.status='awaiting_approval')
  or (${run.status} in ('preparing','running','waiting_input','finishing') and ${run.stopRequestedAt} is null and (
    exists (select 1 from agent_tool_approvals a where a."runId"=${run.id} and a."userId"=${run.userId} and a.status='pending' and a."expiresAt">now())
))`
/** Queued for a local device that is off or has no open session (lib/device-session.ts). */
export const runDeviceOffline = sql<boolean>`${run.status}='queued' and exists (select 1 from devices d where d.id=${run.deviceId} and d."ownerId"=${run.userId} and d.kind='local'
  and (d.enabled=false or not ${sql.raw(deviceSessionOpenSql('d'))}))`

/** Retired: presence is the session columns, read by runDeviceOffline itself. */
export const runOfflineDevice = sql<{ id: string; lastSeenAt: string | null } | null>`null::jsonb`

/** The same bounded facts back mobile, detail and canonical batch state. */
export const taskStateRunColumns = {
  runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome,
  pauseReason: agentRuns.pauseReason, stopReason: agentRuns.stopReason, threadReplacedBy: agentRuns.threadReplacedBy,
  failureDetails: runFailureBrief.as('failureDetails'), awaitingApproval: runAwaitingApproval.as('awaitingApproval'),
  deviceOffline: runDeviceOffline.as('deviceOffline'), offlineDevice: runOfflineDevice.as('offlineDevice'),
}
