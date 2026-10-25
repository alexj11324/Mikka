import 'server-only'
import { after } from 'next/server'
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { DEVICE_ONLINE_WINDOW_MS, RUN_LEASE_MS, type RunCheckpoint } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { agentRuns, agents, deviceRepos, devices, runCheckpoints } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent, runRetriedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { revokeRunTokens } from '@/lib/mcp/worker'
import { DEVICE_STAYED_OFFLINE, LEASED_RUN_STATUSES, lostRunOutcome, MAX_RUN_ATTEMPTS, pickTakeover, RETRY_QUEUE_WAIT_MS, retryPrompt, type TakeoverCandidate } from '@/lib/run-retry'

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
  const leaseExpiresAt = new Date(now.getTime() + RUN_LEASE_MS)
  const renewed = await db.update(agentRuns)
    .set({ leaseExpiresAt, updatedAt: now })
    // Group claims belong to the dedicated epoch-bound worker protocol. A
    // generic device heartbeat must neither extend those claims nor resurrect
    // an ordinary attempt whose lease expired while waiting for this row lock.
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, [...runIds]),
      inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), ne(agentRuns.kind, 'group_review'),
      isNull(agentRuns.stopRequestedAt), gt(agentRuns.leaseExpiresAt, sql`clock_timestamp()`)))
    .returning({ id: agentRuns.id })
  const held = new Set(renewed.map(run => run.id))
  const revoked = runIds.filter(id => !held.has(id))
  return { leases: Object.fromEntries([...held].map(id => [id, leaseExpiresAt.toISOString()])), ...(revoked.length ? { revoked } : {}) }
}

/**
 * Ends the owner's runs whose lease ran out, and hands each one to another
 * online machine with the same repository (or queues it again on its own
 * device when none fits) unless its retries are used up. Retries that waited too long
 * for an offline device end too. Safe to call concurrently: each run ends
 * once.
 */
export async function reclaimLostRuns(userId: string, now = new Date()): Promise<void> {
  const lost = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), ne(agentRuns.kind, 'group_review'), lt(agentRuns.leaseExpiresAt, now)))
    .limit(20)
  for (const run of lost) await reclaimLostRun(run, now)

  // Retries still waiting for a device that is offline go to another
  // machine as soon as one can take them; after a while, to the person.
  const stranded = await db.select({ run: agentRuns }).from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(
      eq(agentRuns.userId, userId), eq(agentRuns.status, 'queued'), isNotNull(agentRuns.retryOf),
      or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))),
    ))
    .limit(20)
  for (const { run } of stranded) {
    const target = await takeoverTarget(run, now)
    if (target) {
      await db.update(agentRuns).set({ deviceId: target.deviceId, deviceRepoId: target.deviceRepoId, updatedAt: now })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'queued')))
      continue
    }
    if (run.createdAt.getTime() > now.getTime() - RETRY_QUEUE_WAIT_MS) continue
    const ended = await endRun(run.id, ['queued'], { status: 'failed', error: DEVICE_STAYED_OFFLINE }, now)
    if (ended) await announceEnd({ ...run, status: 'failed' })
  }
}

/**
 * Another online machine of the owner with the run's repository and its
 * agent's harness, or null when only the run's own device fits.
 */
async function takeoverTarget(run: { userId: string; agentId: string; deviceId: string | null; deviceRepoId: string | null }, now: Date): Promise<TakeoverCandidate | null> {
  if (!run.deviceRepoId) return null
  const [repo] = await db.select({ remoteUrl: deviceRepos.remoteUrl }).from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
  const [agent] = await db.select({ harness: agents.harness }).from(agents).where(eq(agents.id, run.agentId)).limit(1)
  if (!repo?.remoteUrl || !agent) return null
  const candidates = await db.select({ deviceId: devices.id, deviceRepoId: deviceRepos.id, remoteUrl: deviceRepos.remoteUrl, harnesses: devices.harnesses })
    .from(deviceRepos).innerJoin(devices, eq(devices.id, deviceRepos.deviceId))
    .where(and(eq(devices.ownerId, run.userId), eq(devices.enabled, true), gt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))))
    .orderBy(desc(devices.lastSeenAt))
  return pickTakeover(candidates, { remoteUrl: repo.remoteUrl, harness: agent.harness, lostDeviceId: run.deviceId })
}

/**
 * The newest checkpoint of the attempts a retry takes over from, for a
 * machine that does not have their worktree.
 */
export async function latestCheckpoint(retryOf: string): Promise<RunCheckpoint | null> {
  const chain = [retryOf]
  while (chain.length < MAX_RUN_ATTEMPTS) {
    const [row] = await db.select({ retryOf: agentRuns.retryOf }).from(agentRuns).where(eq(agentRuns.id, chain.at(-1)!)).limit(1)
    if (!row?.retryOf) break
    chain.push(row.retryOf)
  }
  const [checkpoint] = await db.select().from(runCheckpoints).where(inArray(runCheckpoints.runId, chain)).orderBy(desc(runCheckpoints.takenAt)).limit(1)
  if (!checkpoint) return null
  return { baseCommit: checkpoint.baseCommit, patch: checkpoint.patch.toString('base64'), files: checkpoint.files, takenAt: checkpoint.takenAt.toISOString() }
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
  // Straight to another machine when one can take it; else the same device.
  const target = await takeoverTarget(run, now)
  const retried = await db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: 'failed', stopReason: 'device_lost', error: `The device went offline; ${target ? 'handed to another device' : 'queued again'} as attempt ${outcome.attempt} of ${MAX_RUN_ATTEMPTS}.`, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), ne(agentRuns.kind, 'group_review'), lt(agentRuns.leaseExpiresAt, now)))
      .returning({ id: agentRuns.id })
    if (!ended) return false
    await tx.insert(agentRuns).values({
      id: retryId, userId: run.userId, issueId: run.issueId, agentId: run.agentId,
      deviceId: target?.deviceId ?? run.deviceId, deviceRepoId: target?.deviceRepoId ?? run.deviceRepoId, status: 'queued', kind: run.kind, baseBranch: run.baseBranch,
      accountActionRefs: run.accountActionRefs,
      prompt: retryPrompt(run.prompt, outcome.attempt), attempt: outcome.attempt, retryOf: run.id,
    })
    await recordCoordinatorEvent(tx, runRetriedEvent(run, { runId: retryId, attempt: outcome.attempt, maxAttempts: MAX_RUN_ATTEMPTS, movedToDeviceId: target?.deviceId ?? null }))
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
