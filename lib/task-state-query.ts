import { sql } from 'drizzle-orm'
import { DEVICE_ONLINE_WINDOW_MS } from '@mikka/protocol/device'
import { agentRuns } from './db/schema'

/** Bounded facts, joined into existing batch/history reads. No provider text or per-task reads. */
export const runAwaitingApproval = sql<boolean>`exists (select 1 from run_publications p where p."runId"=${agentRuns.id} and p."userId"=${agentRuns.userId} and p.status='awaiting_approval')
  or exists (select 1 from agent_tool_approvals a where a."runId"=${agentRuns.id} and a."userId"=${agentRuns.userId} and a.status='pending' and a."expiresAt">now())`
export const runDeviceOffline = sql<boolean>`${agentRuns.status}='queued' and exists (select 1 from devices d where d.id=${agentRuns.deviceId} and d."ownerId"=${agentRuns.userId} and d.kind='local'
  and (d.enabled=false or d."lastSeenAt" is null or d."lastSeenAt">now() or d."lastSeenAt"<now()-(${DEVICE_ONLINE_WINDOW_MS} * interval '1 millisecond')))`

export const runOfflineDevice = sql<{ id: string; lastSeenAt: string | null } | null>`(select jsonb_build_object('id',d.id,'lastSeenAt',d."lastSeenAt") from devices d
  where d.id=${agentRuns.deviceId} and d."ownerId"=${agentRuns.userId} and d.kind='local' and d.enabled=true and ${agentRuns.status}='queued')`
