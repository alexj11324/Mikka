import 'server-only'
import { after } from 'next/server'
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { DEVICE_ONLINE_WINDOW_MS, RUN_LEASE_MS } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, devices } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent, runRetriedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { revokeRunTokens } from '@/lib/mcp/worker'
import { DEVICE_STAYED_OFFLINE, LEASED_RUN_STATUSES, lostRunOutcome, MAX_RUN_ATTEMPTS, RETRY_QUEUE_WAIT_MS, retryPrompt } from '@/lib/run-retry'

const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Run leases on the server (ADR 0012). The heartbeat renews the lease of each
// run the device reports; a run left out is not renewed, and the daemon stops
// it once its lease runs out. `reclaimLostRuns` handles runs whose device
// stopped renewing: it is called where the owner's devices or app check in,
// since there is no frequent cron on this plan.

/**
 * Renews the leases of the device's claimed runs it still reports. Reported
 * runs it no longer holds come back as `revoked`, so the daemon stops them
 * before a retry of the same run starts.
 */
export async function renewRunLeases(deviceId: string, runIds: readonly string[], now = new Date()): Promise<{ leases: Record<string, string>; revoked?: string[] }> {
  if (!runIds.length) return { leases: {} }
  // Protocol IDs can be short strings, but agent_runs.id is a UUID. Such an ID
  // cannot be held here; revoke it without making PostgreSQL reject the whole beat.
  const validRunIds = runIds.filter(id => RUN_UUID.test(id))
  const leaseExpiresAt = new Date(now.getTime() + RUN_LEASE_MS)
  const renewed = validRunIds.length ? await db.update(agentRuns)
    .set({ leaseExpiresAt, updatedAt: now })
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, validRunIds), inArray(agentRuns.status, [...LEASED_RUN_STATUSES])))
    .returning({ id: agentRuns.id }) : []
  const held = new Set(renewed.map(run => run.id))
  const revoked = runIds.filter(id => !held.has(id))
  return { leases: Object.fromEntries([...held].map(id => [id, leaseExpiresAt.toISOString()])), ...(revoked.length ? { revoked } : {}) }
}

/**
 * Ends the owner's runs whose lease ran out, and queues each one again on the
 * same device unless its retries are used up. Retries that waited too long
 * for an offline device end too. Safe to call concurrently: each run ends
 * once.
 */
export async function reclaimLostRuns(userId: string, now = new Date()): Promise<void> {
  const lost = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now)))
    .limit(20)
  for (const run of lost) await reclaimLostRun(run, now)

  const stranded = await db.select({ run: agentRuns }).from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(
      eq(agentRuns.userId, userId), eq(agentRuns.status, 'queued'), isNotNull(agentRuns.retryOf),
      lt(agentRuns.createdAt, new Date(now.getTime() - RETRY_QUEUE_WAIT_MS)),
      or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))),
    ))
    .limit(20)
  for (const { run } of stranded) {
    const ended = await endRun(run.id, ['queued'], { status: 'failed', error: DEVICE_STAYED_OFFLINE }, now)
    if (ended) await announceEnd({ ...run, status: 'failed' })
  }
}

type Run = typeof agentRuns.$inferSelect

async function reclaimLostRun(run: Run, now: Date) {
  const outcome = lostRunOutcome(run)
  if (outcome.kind !== 'retry') {
    const status = outcome.kind === 'stopped' ? 'stopped' : 'failed'
    const ended = await endRun(run.id, LEASED_RUN_STATUSES, { status, error: outcome.kind === 'failed' ? outcome.error : null }, now)
    if (ended) await announceEnd({ ...run, status })
    return
  }
  const retryId = crypto.randomUUID()
  const retried = await db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: 'failed', stopReason: 'device_lost', error: `The device went offline; queued again as attempt ${outcome.attempt} of ${MAX_RUN_ATTEMPTS}.`, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now)))
      .returning({ id: agentRuns.id })
    if (!ended) return false
    await tx.insert(agentRuns).values({
      id: retryId, userId: run.userId, issueId: run.issueId, agentId: run.agentId, deviceId: run.deviceId,
      deviceRepoId: run.deviceRepoId, status: 'queued', kind: run.kind, baseBranch: run.baseBranch,
      prompt: retryPrompt(run.prompt, outcome.attempt), attempt: outcome.attempt, retryOf: run.id,
    })
    await recordCoordinatorEvent(tx, runRetriedEvent(run, { runId: retryId, attempt: outcome.attempt, maxAttempts: MAX_RUN_ATTEMPTS }))
    return true
  })
  if (retried) await revokeRunTokens(run.id)
}

/** Ends a run that is still in one of `from`; false when something else ended it first. */
async function endRun(runId: string, from: readonly Run['status'][], end: { status: 'failed' | 'stopped'; error: string | null }, now: Date): Promise<boolean> {
  const ended = await db.update(agentRuns)
    .set({ status: end.status, stopReason: 'device_lost', error: end.error, finishedAt: now, updatedAt: now })
    .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...from])))
    .returning({ id: agentRuns.id })
  return ended.length > 0
}

/** Same as a completion from the daemon: tokens off, and the Coordinator hears it. A failure lands in 等你. */
async function announceEnd(run: Run & { status: 'failed' | 'stopped' }) {
  await revokeRunTokens(run.id)
  await recordCoordinatorEvent(db, runFinishedEvent({ ...run, stopReason: 'device_lost', report: null }))
  after(() => wakeCoordinator(run.userId))
}
