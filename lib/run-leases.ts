import { runChanged } from './live/panels'
import 'server-only'
import { rebindExecutionDevice, revalidateExecutionIdentity, ExecutionIdentityError } from './execution-identity'
import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { retryWorkerDefinition } from '@/lib/agent-kit/worker'
import { after } from 'next/server'
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import { DEVICE_ONLINE_WINDOW_MS, RUN_LEASE_MS, type RunCheckpoint } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { agentRuns, agents, deviceRepos, devices, issues } from '@/lib/db/schema'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent, runRetriedEvent } from '@/lib/coordinator-events'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { revokeRunTokens } from '@/lib/mcp/worker'
import { stopRecordingsAfter } from '@/lib/captures/run-end'
import { DEVICE_STAYED_OFFLINE, LEASED_RUN_STATUSES, lostRunOutcome, MAX_RUN_ATTEMPTS, pickTakeover, retryNote, retryPrompt, type TakeoverCandidate } from '@/lib/run-retry'
import { tiptapToText } from '@/lib/tiptap-text'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import { deviceOnlineStates } from '@/lib/device-presence'
import { ownE2BKeySql } from './secrets/e2b-owner-sql'
import { readmitLostLocalRun, type AdmittedTakeover, type CloudRecoverySource } from './run-repository-retry'

const RUN_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Run leases on the server (ADR 0012). The heartbeat renews the lease of each
// run the device reports; a run left out is not renewed, and the daemon stops
// it once its lease runs out. The independent minute sweep runs `reclaimLostRuns`
// for each owner, so recovery does not depend on an open app/device (and no
// app or device poll does it again).

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
  const candidates = validRunIds.length ? await db.select().from(agentRuns).where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, validRunIds), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]))) : []
  const authorized: string[] = []
  for (const run of candidates) {
    try { await revalidateExecutionIdentity(pool, run); authorized.push(run.id) }
    catch (error) {
      if (!(error instanceof ExecutionIdentityError)) throw error
      // The daemon receives revoked on this heartbeat and removes injected credentials.
      const stopped = await db.update(agentRuns).set({ stopRequestedAt: now, leaseExpiresAt: now, updatedAt: now }).where(and(eq(agentRuns.id, run.id), eq(agentRuns.deviceId, deviceId), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]))).returning({ id: agentRuns.id })
      if (stopped.length && !run.stopRequestedAt) await runChanged(db, run.id)
    }
  }
  const renewed = authorized.length ? await db.update(agentRuns)
    .set({ leaseExpiresAt, updatedAt: now })
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, authorized), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), isNull(agentRuns.stopRequestedAt)))
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
  const stranded = await db.select({ run: agentRuns, lastSeenAt: devices.lastSeenAt }).from(agentRuns)
    .innerJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(
      eq(agentRuns.userId, userId), eq(agentRuns.status, 'queued'), isNotNull(agentRuns.retryOf),
      or(isNull(devices.lastSeenAt), lt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))),
    ))
    .limit(20)
  const presence = await deviceOnlineStates(stranded.flatMap(({ run, lastSeenAt }) => run.deviceId ? [{ id: run.deviceId, lastSeenAt }] : []), now.getTime())
  for (const { run } of stranded) {
    if (run.stopRequestedAt) {
      const ended = await endRun(run.id, ['queued'], { status: 'stopped', error: null }, now)
      if (ended) await announceEnd({ ...run, status: 'stopped' })
      continue
    }
    if (run.deviceId && presence.get(run.deviceId)) continue
    // Nothing waits on an offline device (设备离线时 is gone): another device takes it, else the person gets the card.
    const target = await takeoverTarget(run, now)
    if (target && run.agentDefinition?.repositoryAdmission) {
      await recoverAdmittedRun(run, target, now, true)
      continue
    }
    if (target) {
      await db.update(agentRuns).set({ deviceId: target.deviceId, deviceRepoId: target.deviceRepoId, agentDefinition: await rebindExecutionDevice(pool, run, target.deviceId), updatedAt: now })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'queued'), isNull(agentRuns.stopRequestedAt)))
      notifyDeviceWork(target.deviceId)
      continue
    }
    const ended = await endRun(run.id, ['queued'], { status: 'failed', error: DEVICE_STAYED_OFFLINE }, now, false, await noMachineCard())
    if (ended) await announceEnd({ ...run, status: 'failed' })
  }
}

/**
 * Another online machine of the owner with the execution harness and
 * 参与调度 on. The target clones the same remote. Admitted local tasks
 * use the target Agent and retain original provenance through retryOf.
 */
async function takeoverTarget(run: { id: string; userId: string; agentId: string; deviceId: string | null; deviceRepoId: string | null; agentDefinition?: Run['agentDefinition'] }, now: Date): Promise<(TakeoverCandidate & { deviceRepoId: string; agentId: string }) | null> {
  if (!run.deviceRepoId) return null
  const [repo] = await db.select({ remoteUrl: deviceRepos.remoteUrl, repoPath: deviceRepos.repoPath }).from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
  const [agent] = await db.select({ harness: agents.harness }).from(agents).where(eq(agents.id, run.agentId)).limit(1)
  if (!repo?.remoteUrl || !agent || !repositoryBindingMatches(repo.repoPath, repo.remoteUrl, { allowFile: daemonTestMode(process.env) })) return null
  const bound = await db.execute(sql`select 1 from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId}`)
  // A repository-only cloud task can use normal local admission after its
  // exact old sandbox is parked. Desktop work still needs a cloud runtime.
  if (bound.rows.length) {
    if (!run.agentDefinition?.repositoryAdmission || run.agentDefinition.allowLocalRecovery !== true) return null
    const factory = await db.execute(sql`select 1 from factory_attempts a join factory_tasks t on t.id=a."taskId"
      where a."runId"=${run.id} and t."userId"=${run.userId} limit 1`)
    if (!factory.rows.length) return null
  }
  const available = await db.select({ deviceId: devices.id, harnesses: devices.harnesses, deviceType: devices.deviceType, lastSeenAt: devices.lastSeenAt })
    .from(devices)
    .where(and(eq(devices.ownerId, run.userId), eq(devices.enabled, true), eq(devices.kind, 'local'), isNull(devices.removedAt), sql`${devices.protocolVersion} >= ${DAEMON_PROTOCOL_VERSION}`))
    .orderBy(desc(devices.lastSeenAt))
  // Only devices with 参与调度 on (enabled, decision 2026-11-02-1400); servers first.
  const presence = await deviceOnlineStates(available.map(device => ({ id: device.deviceId, lastSeenAt: device.lastSeenAt })), now.getTime())
  let candidates = available.filter(device => presence.get(device.deviceId)).sort((a, b) => Number(b.deviceType === 'server') - Number(a.deviceType === 'server'))
  const harness = run.agentDefinition?.harness ?? agent.harness
  // A fresh local admission needs B's real registered Agent; the old Agent
  // remains provenance through retryOf, not a forged Agent/device pairing.
  const registered = run.agentDefinition?.repositoryAdmission && candidates.length
    ? await db.select({ id: agents.id, deviceId: agents.deviceId }).from(agents).where(and(eq(agents.userId, run.userId), eq(agents.harness, agent.harness), inArray(agents.deviceId, candidates.map(candidate => candidate.deviceId)))).orderBy(agents.id)
    : []
  if (run.agentDefinition?.repositoryAdmission) candidates = candidates.filter(candidate => registered.some(agent => agent.deviceId === candidate.deviceId))
  const target = pickTakeover(run.agentDefinition?.subscription ? candidates.filter(candidate => candidate.harnesses.some(info => info.harness === harness && info.subscriptionBroker)) : candidates, { remoteUrl: repo.remoteUrl, harness, lostDeviceId: run.deviceId })
  if (!target) return null
  const targetRepo = await ensureDeviceRepository(run.userId, target.deviceId, repo.remoteUrl)
  return { ...target, deviceRepoId: targetRepo.id, agentId: registered.find(agent => agent.deviceId === target.deviceId)?.id ?? run.agentId }
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
 * on an authorized local device after confirmed parking when it has a
 * repository receipt, otherwise on a new sandbox; any other run on the person's own E2B cloud, else another
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
  const bound = (await db.execute(sql`select b."workspaceId",m."sandboxId",m."operationId",m."deviceId",m."repoId" from computer_run_bindings b
    left join thread_machines m on m."runId"=b."runId" and m."ownerId"=b."ownerId" and m."workspaceId"=b."workspaceId"
    where b."runId"=${run.id} and b."ownerId"=${run.userId}`)).rows[0] as CloudRecoverySource | undefined
  const cloud = bound ? null : await cloudTarget(run)
  const target = cloud ? null : await takeoverTarget(run, now)
  if (!bound && !cloud && !target) {
    const ended = await endRun(run.id, LEASED_RUN_STATUSES, { status: 'failed', error: DEVICE_STAYED_OFFLINE }, now, true, await noMachineCard())
    if (ended) await announceEnd({ ...run, status: 'failed' })
    return
  }
  if (target && run.agentDefinition?.repositoryAdmission) {
    await recoverAdmittedRun(run, target, now, false, bound)
    return
  }
  const retryId = crypto.randomUUID()
  const where = bound || cloud ? 'moved to the cloud' : 'handed to another device'
  const recovery = await (await import('@/lib/factory/handoff')).factoryRecoveryHandoff(pool, run, retryPrompt(run.prompt, outcome.attempt))
  if (recovery.blocked) {
    const ended = await endRun(run.id, LEASED_RUN_STATUSES, { status: 'failed', error: recovery.blocked }, now, true)
    if (ended) await announceEnd({ ...run, status: 'failed' })
    return
  }
  const retried = await db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: 'failed', stopReason: 'device_lost', error: `The machine went offline; ${where} as attempt ${outcome.attempt} of ${MAX_RUN_ATTEMPTS}.`, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now), isNull(agentRuns.stopRequestedAt)))
      .returning({ id: agentRuns.id })
    if (!ended) return false
    await runChanged(tx, run.id)
    if (cloud) return true
    await tx.insert(agentRuns).values({
      id: retryId, userId: run.userId, issueId: run.issueId, agentId: run.agentId, botId: run.botId, source: run.source,
      agentDefinition: retryWorkerDefinition(target ? await rebindExecutionDevice(pool, run, target.deviceId) : run.agentDefinition, recovery.prompt),
      deviceId: target?.deviceId ?? run.deviceId, deviceRepoId: target?.deviceRepoId ?? run.deviceRepoId, status: 'queued', kind: run.kind, baseBranch: run.baseBranch,
      prompt: recovery.prompt, attempt: outcome.attempt, retryOf: run.id,
    })
    if (bound) {
      // Same thread, new sandbox: the retry gets its own thread machine, built from the workspace snapshot.
      await tx.execute(sql`insert into computer_run_bindings ("runId","botId","workspaceId","ownerId") select ${retryId},"botId","workspaceId","ownerId" from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId}`)
      await tx.execute(sql`insert into thread_machines ("runId","workspaceId","ownerId","botId","snapshotId","operationId",state) select ${retryId},"workspaceId","ownerId","botId",'pending',${crypto.randomUUID()},'starting' from computer_run_bindings where "runId"=${run.id} and "ownerId"=${run.userId} on conflict do nothing`)
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
    if (cloud) await moveToCloud(run, cloud, outcome.attempt, now, recovery.briefing)
    else notifyDeviceWork(target?.deviceId ?? run.deviceId)
  }
}

/** Both an expired execution and a queued retry that lost B need a new
 * device-bound receipt. Never mutate an admitted queued run's placement. */
async function recoverAdmittedRun(run: Run, target: AdmittedTakeover, now: Date, queued = false, cloudSource?: CloudRecoverySource) {
  const result = await readmitLostLocalRun(run, target, now, queued, cloudSource)
  if (result.retried) {
    stopRecordingsAfter([run.id])
    await afterRunEnded(run.userId, run.id)
    notifyDeviceWork(target.deviceId)
  } else if (result.blocked) {
    const ended = await endRun(run.id, queued ? ['queued'] : LEASED_RUN_STATUSES, { status: 'failed', error: result.blocked }, now, !queued, await noMachineCard())
    if (ended) await announceEnd({ ...run, status: 'failed' })
  }
}

type CloudTarget = { botId: string; workspaceId: string; harness: 'codex' | 'claude_code'; agentId: string; repoId: string; deviceId: string; remoteUrl: string }

/** The person's own E2B cloud for a lost run: their own E2B key and the run's own bot's cloud runtime (never another bot's). */
async function cloudTarget(run: Run): Promise<CloudTarget | null> {
  if (!cloudComputerRunsEnabled()) return null
  if (run.agentDefinition?.repositoryAdmission || !run.deviceRepoId || !run.botId) return null
  const [repo] = await db.select({ remoteUrl: deviceRepos.remoteUrl }).from(deviceRepos).where(eq(deviceRepos.id, run.deviceRepoId)).limit(1)
  if (!repo?.remoteUrl) return null
  const harness = run.agentDefinition?.harness ?? null
  const { rows: [row] } = await pool.query(`SELECT r."botId",r."workspaceId",r.harness,r."agentId",r."repoId",a."deviceId" FROM bot_cloud_runtimes r
      JOIN agents a ON a.id=r."agentId" AND a."userId"=r."ownerId"
      WHERE r."ownerId"=$1 AND r."botId"=$2 AND a."deviceId" IS NOT NULL AND ${ownE2BKeySql('r."ownerId"')}
      ORDER BY (r.harness=$3) DESC NULLS LAST LIMIT 1`, [run.userId, run.botId, harness])
  return row ? { ...row, remoteUrl: repo.remoteUrl } : null
}

/** The lost run's own model when the cloud runs its Agent; else 优先使用的模型's first cloud entry for that harness. */
async function cloudRetryModel(run: Run, cloud: CloudTarget) {
  const { chooseCloudRunModel } = await import('@/lib/computer/run-model')
  if (run.agentDefinition?.harness === cloud.harness && run.agentDefinition?.model) return { model: run.agentDefinition.model }
  const chosen = await chooseCloudRunModel(pool, { ownerId: run.userId, workspaceId: cloud.workspaceId, botId: run.botId }, cloud.agentId, cloud.harness)
  if ('error' in chosen) throw new Error('No cloud model')
  return chosen
}

/**
 * Queues the lost run again on the person's own E2B cloud through the normal
 * cloud queue, then starts its thread machine. When the cloud refuses, the
 * run's retry ends with the card instead.
 */
async function moveToCloud(run: Run, cloud: CloudTarget, attempt: number, now: Date, handoff = '') {
  const actor = { userId: run.userId, workspaceId: cloud.workspaceId }
  try {
    const [issue] = run.issueId ? await db.select({ title: issues.title, content: issues.content }).from(issues).where(eq(issues.id, run.issueId)).limit(1) : []
    if (!issue || !run.issueId) throw new Error('Issue unavailable')
    const { queueCloudRun } = await import('@/lib/computer/queue-run')
    const repo = await ensureDeviceRepository(run.userId, cloud.deviceId, cloud.remoteUrl)
    const { runId } = await queueCloudRun(pool, actor, { botId: cloud.botId, issueId: run.issueId, agentId: cloud.agentId, deviceRepoId: repo.id, title: issue.title, body: tiptapToText(issue.content),
      note: retryNote(attempt) + handoff, withoutBot: run.botId === null, idempotencyKey: `retry:${run.id}`, threadRunId: run.id, ...await cloudRetryModel(run, cloud) })
    await db.update(agentRuns).set({ retryOf: run.id, attempt, updatedAt: now }).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, run.userId)))
    await recordCoordinatorEvent(db, runRetriedEvent(run, { runId, attempt, maxAttempts: MAX_RUN_ATTEMPTS, movedTo: { kind: 'cloud' } }))
    await startThreadMachine(actor, runId)
  } catch {
    // The cloud refused before a retry existed: the lost run already ended, so tell the person what they can do.
    await recordCoordinatorEvent(db, { ...runFinishedEvent({ ...run, status: 'failed', stopReason: 'device_lost', report: null }), payload: { status: 'failed', stopReason: 'device_lost', runKind: run.kind, summary: null, noMachine: await noMachineCard() } })
    await wakeCoordinator(run.userId).catch(() => undefined)
  }
}

/** Provisions a queued cloud run; exact native continuation failures retain its original VM. */
export async function startThreadMachine(actor: { userId: string; workspaceId: string }, runId: string, startLifecycle = true) {
  try {
    await (await import('@/lib/cloud-computer/thread-machines')).ensureThreadMachine(pool, actor, runId)
    if (startLifecycle) {
      const { start } = await import('workflow/api')
      const { threadMachineLifecycle } = await import('@/workflows/thread-machine/workflow')
      await start(threadMachineLifecycle, [actor, runId])
    }
    return { state: 'running' as const }
  } catch (error) {
    const { RetainedTaskMachineUnavailable } = await import('@/lib/cloud-computer/thread-machines')
    if (error instanceof RetainedTaskMachineUnavailable) return { state: 'unavailable' as const, reason: 'retained_runtime' as const }
    // A question continuation cannot replace its original native session VM.
    // Keep the committed answer/run and placement for the same answer's retry.
    const [continuation] = await db.select({ question: agentRuns.questionContinuation }).from(agentRuns)
      .where(and(eq(agentRuns.id,runId),eq(agentRuns.userId,actor.userId))).limit(1)
    if (continuation?.question?.requireSessionResume) return { state: 'unavailable' as const }
    // A lifecycle enqueue may fail after provisioning succeeded. Re-read the
    // committed adoption, so even that failure cannot end the task's old VM.
    const retained = await pool.query(`SELECT 1 FROM thread_machines m
      JOIN agent_runs current ON current.id=m."runId" AND current."userId"=m."ownerId" AND current."issueId"=m."issueId"
      WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m.state<>'ended' AND m."sandboxId" IS NOT NULL
        AND EXISTS(SELECT 1 FROM thread_machines old JOIN agent_runs previous ON previous.id=old."runId" AND previous."userId"=old."ownerId"
          WHERE old."runId"<>m."runId" AND old."ownerId"=m."ownerId" AND old."workspaceId"=m."workspaceId" AND old."issueId"=m."issueId"
            AND old."deviceId"=m."deviceId" AND old."repoId"=m."repoId" AND old.state='ended' AND old."sandboxId" IS NULL
            AND previous.status IN ('succeeded','failed','stopped','cancelled'))`, [runId,actor.userId,actor.workspaceId])
    if (retained.rowCount) return { state: 'unavailable' as const, reason: 'retained_runtime' as const }
    await (await import('@/lib/cloud-computer/thread-machines')).threadMachineAction(pool, actor, runId, 'end').catch(() => undefined)
    const [run] = await db.update(agentRuns).set({ status: 'failed', stopReason: 'device_lost', error: DEVICE_STAYED_OFFLINE, updatedAt: new Date() })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, actor.userId), inArray(agentRuns.status, ['queued', 'stopped']))).returning()
    if (run) {
      await recordCoordinatorEvent(db, { ...runFinishedEvent({ ...run, stopReason: 'device_lost', report: null }), payload: { status: 'failed', stopReason: 'device_lost', runKind: run.kind, summary: null, noMachine: await noMachineCard() } })
      await wakeCoordinator(actor.userId).catch(() => undefined)
    }
  }
}

/** The card of what the person can do when no machine can continue a run. */
async function noMachineCard() {
  return (await import('@/lib/rule-dispatch')).machineUnavailableCard()
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

/**
 * A queued run whose device's daemon is too old to claim it ends now, so the Bot
 * says the device needs an update instead of the run waiting for a lease that never comes.
 */
export async function failRunForDaemonUpgrade(runId: string, deviceId: string, userId: string, now = new Date()): Promise<boolean> {
  const ended = await db.transaction(async tx => {
    const [run] = await tx.update(agentRuns)
      .set({ status: 'failed', pauseReason: null, resumeStatus: null, stopReason: 'error', error: DAEMON_UPGRADE_REQUIRED, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.userId, userId), eq(agentRuns.status, 'queued'), isNull(agentRuns.stopRequestedAt)))
      .returning()
    if (!run) return null
    const event = runFinishedEvent({ ...run, stopReason: 'error', report: null })
    await recordCoordinatorEvent(tx, { ...event, payload: { ...event.payload, daemonUpgradeRequired: true } })
    return run
  })
  if (!ended) return false
  await announceEnd({ ...ended, status: 'failed' })
  return true
}

/** The run error a too-old daemon leaves (lib/coordinator/context.ts tells the person to update). */
export const DAEMON_UPGRADE_REQUIRED = 'Mikka on this device needs an update.'

/** Same as a completion from the daemon: tokens off, and the Coordinator hears it. A failure lands in 等你. */
async function announceEnd(run: Run & { status: 'failed' | 'stopped' }) {
  await revokeRunTokens(run.id)
  stopRecordingsAfter([run.id])
  await afterRunEnded(run.userId, run.id)
  after(() => wakeCoordinator(run.userId))
}
