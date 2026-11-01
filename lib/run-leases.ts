import 'server-only'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { retryWorkerDefinition } from '@/lib/agent-kit/worker'
import { after } from 'next/server'
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { DEVICE_ONLINE_WINDOW_MS, RUN_LEASE_MS, type RunCheckpoint } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, agents, deviceRepos, devices, issues } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent, runRetriedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { revokeRunTokens } from '@/lib/mcp/worker'
import { stopRecordingsAfter } from '@/lib/captures/run-end'
import { DEVICE_STAYED_OFFLINE, LEASED_RUN_STATUSES, lostRunOutcome, MAX_RUN_ATTEMPTS, pickTakeover, retryNote, retryPrompt, type TakeoverCandidate } from '@/lib/run-retry'
import { autoScheduleOn } from '@/lib/device-auto-schedule'
import { tiptapToText } from '@/lib/tiptap-text'
import { afterRunEnded } from '@/lib/run-completion-effects'

const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Run leases on the server (ADR 0012). The heartbeat renews the lease of each
// run the device reports; a run left out is not renewed, and the daemon stops
// it once its lease runs out. Owner requests and the independent minute sweep
// share `reclaimLostRuns`, so recovery does not depend on an open app/device.

/** A bounded cron pass over persisted work, without relying on owner polling. */
export async function sweepExpiredRunLeases(now = new Date()): Promise<{ owners: number; failed: number }> {
  const owners = await db.selectDistinct({ userId: agentRuns.userId }).from(agentRuns)
    .leftJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(or(
      and(inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now)),
      and(eq(agentRuns.status, 'queued'), isNotNull(agentRuns.retryOf),
        or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS)))),
    ))
    .orderBy(agentRuns.userId).limit(100)
  let failed = 0
  for (const owner of owners) {
    try { await reclaimLostRuns(owner.userId, now) }
    catch { failed++ }
  }
  return { owners: owners.length, failed }
}

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
 * Ends the owner's runs whose lease ran out, and hands each one to another
 * online machine with the same repository (or queues it again on its own
 * device when none fits) unless its retries are used up. Retries that waited too long
 * for an offline device end too. Safe to call concurrently: each run ends
 * once.
 */
export async function reclaimLostRuns(userId: string, now = new Date()): Promise<void> {
  const lost = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.userId, userId), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now)))
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
    if (run.stopRequestedAt) {
      const ended = await endRun(run.id, ['queued'], { status: 'stopped', error: null }, now)
      if (ended) await announceEnd({ ...run, status: 'stopped' })
      continue
    }
    // Nothing waits on an offline device (设备离线时 is gone): another device takes it, else the person gets the card.
    const target = await takeoverTarget(run, now)
    if (target) {
      await db.update(agentRuns).set({ deviceId: target.deviceId, deviceRepoId: target.deviceRepoId, updatedAt: now })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'queued'), isNull(agentRuns.stopRequestedAt)))
      continue
    }
    const ended = await endRun(run.id, ['queued'], { status: 'failed', error: DEVICE_STAYED_OFFLINE }, now, false, await noMachineCard(run.userId))
    if (ended) await announceEnd({ ...run, status: 'failed' })
  }
}

/**
 * Another online machine of the owner with the execution harness and
 * 允许自动调度 on. The target clones the same remote; the original agentId
 * stays as provenance.
 */
async function takeoverTarget(run: { id: string; userId: string; agentId: string; deviceId: string | null; deviceRepoId: string | null; agentDefinition?: Run['agentDefinition'] }, now: Date): Promise<(TakeoverCandidate & { deviceRepoId: string }) | null> {
  if (run.agentDefinition?.repositoryAdmission) return null
  if (!run.deviceRepoId) return null
  const [repo] = await db.select({ remoteUrl: deviceRepos.remoteUrl, repoPath: deviceRepos.repoPath }).from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
  const [agent] = await db.select({ harness: agents.harness }).from(agents).where(eq(agents.id, run.agentId)).limit(1)
  if (!repo?.remoteUrl || !agent || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) return null
  const bound = await db.execute(sql`select 1 from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId}`)
  if (bound.rows.length) return null
  const online = await db.select({ deviceId: devices.id, harnesses: devices.harnesses, deviceType: devices.deviceType, autoSchedule: devices.autoSchedule })
    .from(devices)
    .where(and(eq(devices.ownerId, run.userId), eq(devices.enabled, true), eq(devices.kind, 'local'), sql`${devices.protocolVersion} >= ${DAEMON_PROTOCOL_VERSION}`, gt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))))
    .orderBy(desc(devices.lastSeenAt))
  // Only devices Mikka may pick on its own; servers first (orchestration.md § 4).
  const candidates = online.filter(autoScheduleOn).sort((a, b) => Number(b.deviceType === 'server') - Number(a.deviceType === 'server'))
  const target = pickTakeover(run.agentDefinition?.subscription ? candidates.filter(candidate => candidate.harnesses.some(info => info.harness === run.agentDefinition?.harness && info.subscriptionBroker)) : candidates, { remoteUrl: repo.remoteUrl, harness: run.agentDefinition?.harness ?? agent.harness, lostDeviceId: run.deviceId })
  if (!target) return null
  const targetRepo = await ensureDeviceRepository(run.userId, target.deviceId, repo.remoteUrl)
  return { ...target, deviceRepoId: targetRepo.id }
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
  const { rows: [checkpoint] } = await pool.query<{ baseCommit: string; patch: Buffer; files: number; takenAt: Date; unavailableReason: string | null }>(
    'SELECT "baseCommit",patch,files,"updatedAt" AS "takenAt","unavailableReason" FROM run_checkpoints WHERE "runId"=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],"runId") LIMIT 1', [chain])
  if (!checkpoint) return null
  return { baseCommit: checkpoint.baseCommit, patch: checkpoint.patch.toString('base64'), files: checkpoint.files, takenAt: checkpoint.takenAt.toISOString(),
    ...(checkpoint.unavailableReason ? { unavailableReason: 'too_large' as const } : {}) }
}

type Run = typeof agentRuns.$inferSelect

/**
 * A run whose machine is gone continues elsewhere (decision
 * 2026-10-31-2200-run-machine-fallback, orchestration.md § 4): a cloud thread
 * on a new sandbox; any other run on the person's own E2B cloud, else another
 * of their devices with 允许自动调度 on, else it ends with the card of what
 * the person can do. The move is the `run_retried` event's `movedTo`.
 */
async function reclaimLostRun(run: Run, now: Date) {
  const outcome = lostRunOutcome(run)
  if (outcome.kind !== 'retry') {
    const status = outcome.kind === 'stopped' ? 'stopped' : 'failed'
    const ended = await endRun(run.id, LEASED_RUN_STATUSES, { status, error: outcome.kind === 'failed' ? outcome.error : null }, now, true)
    if (ended) await announceEnd({ ...run, status })
    return
  }
  const bound = (await db.execute(sql`select "workspaceId" from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId}`)).rows[0] as { workspaceId: string } | undefined
  const cloud = bound ? null : await cloudTarget(run)
  const target = bound || cloud ? null : await takeoverTarget(run, now)
  if (!bound && !cloud && !target) {
    const ended = await endRun(run.id, LEASED_RUN_STATUSES, { status: 'failed', error: DEVICE_STAYED_OFFLINE }, now, true, await noMachineCard(run.userId))
    if (ended) await announceEnd({ ...run, status: 'failed' })
    return
  }
  const retryId = crypto.randomUUID()
  const where = bound || cloud ? 'moved to the cloud' : 'handed to another device'
  const retried = await db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: 'failed', stopReason: 'device_lost', error: `The machine went offline; ${where} as attempt ${outcome.attempt} of ${MAX_RUN_ATTEMPTS}.`, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now), isNull(agentRuns.stopRequestedAt)))
      .returning({ id: agentRuns.id })
    if (!ended) return false
    if (cloud) return true
    await tx.insert(agentRuns).values({
      id: retryId, userId: run.userId, issueId: run.issueId, agentId: run.agentId, botId: run.botId, source: run.source,
      agentDefinition: retryWorkerDefinition(run.agentDefinition, retryPrompt(run.prompt, outcome.attempt)),
      deviceId: target?.deviceId ?? run.deviceId, deviceRepoId: target?.deviceRepoId ?? run.deviceRepoId, status: 'queued', kind: run.kind, baseBranch: run.baseBranch,
      prompt: retryPrompt(run.prompt, outcome.attempt), attempt: outcome.attempt, retryOf: run.id,
    })
    if (bound) {
      // Same thread, new sandbox: the retry gets its own thread machine, built from the workspace snapshot.
      await tx.execute(sql`insert into computer_run_bindings ("runId","botId","workspaceId","ownerId") select ${retryId},"botId","workspaceId","ownerId" from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId}`)
      if (process.env.MIKKA_CLOUD_THREAD_MACHINES === '1') await tx.execute(sql`insert into thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state) select ${retryId},"workspaceId","ownerId","botId",'pending',${crypto.randomUUID()},'starting' from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId} on conflict do nothing`)
    }
    await recordCoordinatorEvent(tx, runRetriedEvent(run, { runId: retryId, attempt: outcome.attempt, maxAttempts: MAX_RUN_ATTEMPTS,
      movedToDeviceId: target?.deviceId ?? null, movedTo: bound ? { kind: 'cloud' } : target ? { kind: 'device', deviceId: target.deviceId } : null }))
    return true
  })
  if (retried) {
    await revokeRunTokens(run.id)
    stopRecordingsAfter([run.id])
    await afterRunEnded(run.userId, run.id)
    if (bound) await startThreadMachine({ userId: run.userId, workspaceId: bound.workspaceId }, retryId)
    if (cloud) await moveToCloud(run, cloud, outcome.attempt, now)
  }
}

type CloudTarget = { botId: string; workspaceId: string; harness: 'codex' | 'claude_code'; agentId: string; repoId: string; deviceId: string; remoteUrl: string }

/** The person's own E2B cloud for a lost run: an E2B key and a bot cloud runtime, the run's bot first. */
async function cloudTarget(run: Run): Promise<CloudTarget | null> {
  if (process.env.MIKKA_CLOUD_COMPUTER_TASKS !== '1' || process.env.MIKKA_BYOS_ENABLED !== '1') return null
  if (run.agentDefinition?.repositoryAdmission || !run.deviceRepoId) return null
  const [repo] = await db.select({ remoteUrl: deviceRepos.remoteUrl }).from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
  if (!repo?.remoteUrl) return null
  const harness = run.agentDefinition?.harness ?? null
  const { rows: [row] } = await pool.query(`SELECT r."botId",r."workspaceId",r.harness,r."agentId",r."repoId",a."deviceId" FROM bot_cloud_runtimes r
      JOIN workspace_e2b_keys k ON k."workspaceId"=r."workspaceId" JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId"
      WHERE r."ownerId"=$1 AND a."deviceId" IS NOT NULL
      ORDER BY (r."botId"=$2::uuid) DESC NULLS LAST,(r.harness=$3) DESC NULLS LAST,r."botId" LIMIT 1`, [run.userId, run.botId, harness])
  return row ? { ...row, remoteUrl: repo.remoteUrl } : null
}

/**
 * Queues the lost run again on the person's own E2B cloud through the normal
 * cloud queue, then starts its thread machine. When the cloud refuses, the
 * run's retry ends with the card instead.
 */
async function moveToCloud(run: Run, cloud: CloudTarget, attempt: number, now: Date) {
  const actor = { userId: run.userId, workspaceId: cloud.workspaceId }
  try {
    const [issue] = run.issueId ? await db.select({ title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, run.issueId)).limit(1) : []
    if (!issue || !run.issueId) throw new Error('Issue unavailable')
    const { queueCloudRun } = await import('@/lib/computer/queue-run')
    const repo = await ensureDeviceRepository(run.userId, cloud.deviceId, cloud.remoteUrl)
    const { runId } = await queueCloudRun(pool, actor, { botId: cloud.botId, issueId: run.issueId, agentId: cloud.agentId, deviceRepoId: repo.id, title: issue.title, body: tiptapToText(issue.content),
      note: retryNote(attempt), reportToCoordinator: run.botId === null, idempotencyKey: `retry:${run.id}`,
      ...(run.agentDefinition?.harness === cloud.harness && run.agentDefinition?.model ? { model: run.agentDefinition.model } : {}) })
    await db.update(agentRuns).set({ retryOf: run.id, attempt, updatedAt: now }).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, run.userId)))
    await recordCoordinatorEvent(db, runRetriedEvent(run, { runId, attempt, maxAttempts: MAX_RUN_ATTEMPTS, movedTo: { kind: 'cloud' } }))
    await startThreadMachine(actor, runId)
  } catch {
    // The cloud refused before a retry existed: the lost run already ended, so tell the person what they can do.
    await recordCoordinatorEvent(db, { ...runFinishedEvent({ ...run, status: 'failed', stopReason: 'device_lost', report: null }), payload: { status: 'failed', stopReason: 'device_lost', runKind: run.kind, summary: null, noMachine: await noMachineCard(run.userId) } })
    await wakeCoordinator(run.userId).catch(() => undefined)
  }
}

/** Provisions a queued cloud run's thread machine; a refusal ends that run with the card. */
async function startThreadMachine(actor: { userId: string; workspaceId: string }, runId: string) {
  if (process.env.MIKKA_CLOUD_THREAD_MACHINES !== '1') return
  try {
    await (await import('@/lib/cloud-computer/thread-machines')).ensureThreadMachine(pool, actor, runId)
    const { start } = await import('workflow/api')
    const { threadMachineLifecycle } = await import('@/workflows/thread-machine/workflow')
    await start(threadMachineLifecycle, [actor, runId])
  } catch {
    await (await import('@/lib/cloud-computer/thread-machines')).threadMachineAction(pool, actor, runId, 'end').catch(() => undefined)
    const [run] = await db.update(agentRuns).set({ status: 'failed', stopReason: 'device_lost', error: DEVICE_STAYED_OFFLINE, updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, actor.userId), inArray(agentRuns.status, ['queued', 'stopped']))).returning()
    if (run) {
      await recordCoordinatorEvent(db, { ...runFinishedEvent({ ...run, stopReason: 'device_lost', report: null }), payload: { status: 'failed', stopReason: 'device_lost', runKind: run.kind, summary: null, noMachine: await noMachineCard(actor.userId) } })
      await wakeCoordinator(actor.userId).catch(() => undefined)
    }
  }
}

/** The card of what the person can do when no machine can continue a run. */
async function noMachineCard(userId: string) {
  return (await import('@/lib/rule-dispatch')).machineUnavailableCardFor(userId)
}

/** Ends a run that is still in one of `from`; false when something else ended it first. */
async function endRun(runId: string, from: readonly Run['status'][], end: { status: 'failed' | 'stopped'; error: string | null }, now: Date, expiredLease = false, noMachine?: unknown): Promise<boolean> {
  return db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: end.status, pauseReason: null, resumeStatus: null, stopReason: 'device_lost', error: end.error, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, runId), inArray(agentRuns.status, [...from]),
        end.status === 'failed' ? isNull(agentRuns.stopRequestedAt) : undefined,
        expiredLease ? lt(agentRuns.leaseExpiresAt, now) : undefined))
      .returning()
    if (!ended) return false
    // A worker ending after this commit cannot lose the failure notification.
    const event = runFinishedEvent({ ...ended, stopReason: 'device_lost', report: null })
    await recordCoordinatorEvent(tx, noMachine ? { ...event, payload: { ...event.payload, noMachine } } : event)
    return true
  })
}

/** Same as a completion from the daemon: tokens off, and the Coordinator hears it. A failure lands in 等你. */
async function announceEnd(run: Run & { status: 'failed' | 'stopped' }) {
  await revokeRunTokens(run.id)
  stopRecordingsAfter([run.id])
  await afterRunEnded(run.userId, run.id)
  after(() => wakeCoordinator(run.userId))
}
