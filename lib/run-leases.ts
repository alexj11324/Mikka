import { and, eq, inArray } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { RUN_LEASE_MS } from '@mikka/protocol/device'
import { agentRuns, devices } from '@/lib/db/schema'
import type * as schema from '@/lib/db/schema'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Database = Pick<NodePgDatabase<typeof schema>, 'update' | 'transaction'>

/**
 * A device heartbeat: marks the device online and renews, to now + RUN_LEASE_MS
 * (ADR 0012), the lease of each run the daemon reported in this heartbeat that
 * is on this device and not finished. A run the daemon no longer reports is
 * left to expire. Queued runs are renewed on purpose (Tech Lead, QA round 3): a run the
 * daemon already holds but has not started must not expire while it waits. Returns the renewed expiries per run id, which the daemon
 * feeds to `supervisor.renewLeases`.
 */
export async function recordDeviceHeartbeat(database: Database, deviceId: string, harnesses: (typeof devices.$inferInsert)['harnesses'], reportedRunIds: readonly string[], now = new Date()) {
  const leaseExpiresAt = new Date(now.getTime() + RUN_LEASE_MS)
  // The protocol allows any short id; agent_runs.id is a uuid, so anything else cannot match.
  const runIds = reportedRunIds.filter(id => UUID.test(id))
  return database.transaction(async tx => {
    await tx.update(devices).set({ harnesses, lastSeenAt: now, updatedAt: now }).where(eq(devices.id, deviceId))
    if (runIds.length === 0) return {} as Record<string, string>
    const renewed = await tx.update(agentRuns).set({ leaseExpiresAt, updatedAt: now })
      .where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, runIds), inArray(agentRuns.status, [...UNFINISHED_RUN_STATUSES])))
      .returning({ id: agentRuns.id, leaseExpiresAt: agentRuns.leaseExpiresAt })
    return Object.fromEntries(renewed.map(run => [run.id, run.leaseExpiresAt!.toISOString()])) as Record<string, string>
  })
}
