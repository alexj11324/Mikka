import { sql } from 'drizzle-orm'
import { DEVICE_ONLINE_WINDOW_MS } from '@mikka/protocol/device'
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
    or exists (select 1 from local_computer_reviews v where v."runId"=${run.id} and v."userId"=${run.userId} and v.decision is null and v."expiresAt">now() and v."seenAt">now()-interval '10 seconds')))`
export const runDeviceOffline = sql<boolean>`${run.status}='queued' and exists (select 1 from devices d where d.id=${run.deviceId} and d."ownerId"=${run.userId} and d.kind='local'
  and (d.enabled=false or d."lastSeenAt" is null or d."lastSeenAt">now() or d."lastSeenAt"<now()-(${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond')))`

export const runOfflineDevice = sql<{ id: string; lastSeenAt: string | null } | null>`(select jsonb_build_object('id',d.id,'lastSeenAt',d."lastSeenAt") from devices d
  where d.id=${run.deviceId} and d."ownerId"=${run.userId} and d.kind='local' and d.enabled=true and ${run.status}='queued')`

/** The same bounded facts back mobile, detail and canonical batch state. */
export const taskStateRunColumns = {
  runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome,
  pauseReason: agentRuns.pauseReason, stopReason: agentRuns.stopReason, threadReplacedBy: agentRuns.threadReplacedBy,
  failureDetails: runFailureBrief.as('failureDetails'), awaitingApproval: runAwaitingApproval.as('awaitingApproval'),
  deviceOffline: runDeviceOffline.as('deviceOffline'), offlineDevice: runOfflineDevice.as('offlineDevice'),
}
