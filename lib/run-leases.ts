import { runChanged } from './live/panels'
import 'server-only'
import { runListChanged } from './live/lists'
import { rebindExecutionDevice, revalidateExecutionIdentity, ExecutionIdentityError } from './execution-identity'
import { cloudComputerRunsEnabled } from '@/lib/cloud-computer-flag'
import { ensureDeviceRepository } from '@/lib/device-repositories'
import { daemonTestMode, repositoryBindingMatches } from '@mikka/protocol/repository'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { retryWorkerDefinition } from '@/lib/agent-kit/worker'
import { afterJob } from '@/lib/background'
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
import { tiptapToText } from '@/lib/tiptap-text'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { notifyDeviceWork } from '@/lib/device-gateway-notify'
import { deviceOnlineStates } from '@/lib/device-presence'
import { ownE2BKeySql } from './secrets/e2b-owner-sql'
import { readmitLostLocalRun, type AdmittedTakeover, type CloudRecoverySource } from './run-repository-retry'
import { CodedError, logCodedError } from '@mikka/protocol/coded-error'
import { serverRunFailure } from './run-failure-details'
import { subscriptionPreflightSchema } from '@mikka/protocol/harness'
import type { RunReport } from '@mikka/protocol/run'
import messages from '@/messages/zh-CN.json'
import { armDueTimerSoon } from '@/lib/due-timer'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { ActionFailureError } from '@/lib/action-error'
import { resolveRunOrigin } from '@/lib/run-origin'

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
        or(isNull(devices.lastSeenAt), gt(devices.lastSeenAt, now), lt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS)))),
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
  const renewed: string[] = []
  for (const run of candidates) {
    try {
      // Historical runs may lack a frozen resource identity. That never
      // exempts their persisted tenant from current membership checks.
      if (!run.workspaceId || (run.agentDefinition?.executionIdentity?.workspaceId
        && run.agentDefinition.executionIdentity.workspaceId !== run.workspaceId)) throw new ExecutionIdentityError()
      const held = await withTaskWorkspace(run.userId, run.workspaceId, async () => {
        await revalidateExecutionIdentity(pool, run)
        // Membership stays pinned until this atomic application write finishes.
        // Recheck mutable task deletion and Bot provenance in that same write.
        return db.update(agentRuns).set({ leaseExpiresAt, updatedAt: now }).where(and(
          eq(agentRuns.id, run.id), eq(agentRuns.deviceId, deviceId),
          eq(agentRuns.workspaceId, run.workspaceId!), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), isNull(agentRuns.stopRequestedAt),
          sql`(${agentRuns.issueId} IS NULL OR EXISTS (SELECT 1 FROM issues task WHERE task.id=${agentRuns.issueId}
            AND task."workspaceId"=${agentRuns.workspaceId} AND task."ownershipState"='bound'
            AND coalesce(task.content->'attrs'->'mikka',task.content->'attrs'->'orvilo')->>'deletedAt' IS NULL))`,
          sql`(${agentRuns.botId} IS NULL OR EXISTS (SELECT 1 FROM bots bot WHERE bot.id=${agentRuns.botId}
            AND bot."workspaceId"=${agentRuns.workspaceId} AND bot."archivedAt" IS NULL))`,
        )).returning({ id: agentRuns.id })
      })
      renewed.push(...held.map(row => row.id))
    }
    catch (error) {
      if (!(error instanceof ExecutionIdentityError) && !(error instanceof ActionFailureError && error.code === 'workspaceAccessDenied')) throw error
    }
  }
  const held = new Set(renewed)
  const rejected = candidates.filter(run => !held.has(run.id)).map(run => run.id)
  // The heartbeat tells the daemon to remove credentials and ends any live
  // lease, including a legacy run whose membership was removed.
  const stopped = rejected.length ? await db.update(agentRuns).set({ stopRequestedAt: now, leaseExpiresAt: now, updatedAt: now })
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(agentRuns.id, rejected), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), isNull(agentRuns.stopRequestedAt)))
    .returning({ id: agentRuns.id }) : []
  for (const run of stopped) { await runListChanged(db, run.id); await runChanged(db, run.id) }
  if (stopped.length) armDueTimerSoon('run-recovery')
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
      or(isNull(devices.lastSeenAt), gt(devices.lastSeenAt, now), lt(devices.lastSeenAt, new Date(now.getTime() - DEVICE_ONLINE_WINDOW_MS))),
    ))
    .limit(20)
  // Lease decisions retain the sweep snapshot, but presence is observed after
  // the query: a heartbeat committed while it waited is not a future heartbeat.
  const presence = await deviceOnlineStates(stranded.flatMap(({ run, lastSeenAt }) => run.deviceId ? [{ id: run.deviceId, lastSeenAt }] : []))
  for (const { run } of stranded) {
    if (run.stopRequestedAt) {
      const ended = await endRun(run.id, ['queued'], { status: 'stopped', error: null }, now)
      if (ended) await announceEnd({ ...run, status: 'stopped' })
      continue
    }
    if (run.deviceId && presence.get(run.deviceId)) continue
    // Nothing waits on an offline device (设备离线时 is gone): another device takes it, else the person gets the card.
    const target = await takeoverTarget(run)
    if (target && run.agentDefinition?.repositoryAdmission) {
      await recoverAdmittedRun(run, target, now, true)
      continue
    }
    if (target) {
      const moved = await db.update(agentRuns).set({ deviceId: target.deviceId, deviceRepoId: target.deviceRepoId, agentDefinition: await rebindExecutionDevice(pool, run, target.deviceId), updatedAt: now })
        .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, 'queued'), isNull(agentRuns.stopRequestedAt))).returning({ id: agentRuns.id })
      if (moved.length) { await runListChanged(db, run.id); await runChanged(db, run.id) }
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
async function takeoverTarget(run: { id: string; userId: string; agentId: string; deviceId: string | null; deviceRepoId: string | null; agentDefinition?: Run['agentDefinition'] }): Promise<(TakeoverCandidate & { deviceRepoId: string; agentId: string }) | null> {
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
  const presence = await deviceOnlineStates(available.map(device => ({ id: device.deviceId, lastSeenAt: device.lastSeenAt })))
  let candidates = available.filter(device => presence.get(device.deviceId)).sort((a, b) => Number(b.deviceType === 'server') - Number(a.deviceType === 'server'))
  const harness = run.agentDefinition?.harness ?? agent.harness
  // A fresh local admission needs B's real registered Agent; the old Agent
  // remains provenance through retryOf, not a forged Agent/device pairing.
  const registered = run.agentDefinition?.repositoryAdmission && candidates.length
    ? await db.select({ id: agents.id, deviceId: agents.deviceId }).from(agents).where(and(eq(agents.userId, run.userId), eq(agents.harness, agent.harness), inArray(agents.deviceId, candidates.map(candidate => candidate.deviceId)))).orderBy(agents.id)
    : []
  if (run.agentDefinition?.repositoryAdmission) candidates = candidates.filter(candidate => registered.some(agent => agent.deviceId === candidate.deviceId))
  const target = pickTakeover(run.agentDefinition?.subscription ? candidates.filter(candidate => candidate.harnesses.some(info => info.harness === harness && info.subscriptionBroker && !info.subscriptionPreflight)) : candidates, { remoteUrl: repo.remoteUrl, harness, lostDeviceId: run.deviceId })
  if (!target) return null
  const targetRepo = await ensureDeviceRepository(run.userId, target.deviceId, repo.remoteUrl)
  return { ...target, deviceRepoId: targetRepo.id, agentId: registered.find(agent => agent.deviceId === target.deviceId)?.id ?? run.agentId }
}

/**
 * The newest checkpoint of the attempts a retry takes over from, for a
 * machine that does not have their worktree.
 */
export async function latestCheckpoint(retryOf: string): Promise<RunCheckpoint | null> {
  // Changing providers does not spend an infrastructure retry. Bound its
  // history separately, while retaining the existing three-attempt limit.
  const maxProviderAttempts = 128, visited = new Set<string>()
  type SnapshotSource = Pick<Run, 'id' | 'retryOf' | 'userId' | 'workspaceId' | 'issueId' | 'botId' | 'deviceRepoId' | 'stopReason' | 'report'> & {
    repoOwner: string | null; repoPath: string | null; remoteUrl: string | null
    baseCommit: string | null; patch: Buffer | null; files: number | null; takenAt: Date | null; unavailableReason: string | null
  }
  let source: SnapshotSource | undefined, current: string | null = retryOf
  let providerAttempts = 0, infrastructureAttempts = 0
  while (current && !visited.has(current)) {
    visited.add(current)
    const { rows }: { rows: SnapshotSource[] } = await pool.query<SnapshotSource>(`SELECT r.id,r."retryOf",r."userId",r."workspaceId",r."issueId",r."botId",r."deviceRepoId",r."stopReason",r.report,
      repo."userId" AS "repoOwner",repo."repoPath",repo."remoteUrl",c."baseCommit",c.patch,c.files,c."updatedAt" AS "takenAt",c."unavailableReason"
      FROM agent_runs r LEFT JOIN device_repos repo ON repo.id=r."deviceRepoId"
      LEFT JOIN run_checkpoints c ON c."runId"=r.id AND c."userId"=r."userId" WHERE r.id=$1`, [current])
    const row: SnapshotSource | undefined = rows[0]
    if (!row?.workspaceId || (row.deviceRepoId && row.repoOwner !== row.userId)) break
    const origin: SnapshotSource = source ?? row
    source = origin
    if (row.userId !== origin.userId || row.workspaceId !== origin.workspaceId || row.issueId !== origin.issueId || row.botId !== origin.botId) break
    if (row.deviceRepoId !== origin.deviceRepoId && !(row.repoPath && origin.repoPath && row.repoPath === origin.repoPath &&
      repositoryBindingMatches(row.repoPath, row.remoteUrl, { allowFile: daemonTestMode(process.env) }) &&
      repositoryBindingMatches(origin.repoPath, origin.remoteUrl, { allowFile: daemonTestMode(process.env) }))) break
    if (row.stopReason === 'provider_failure') {
      if (++providerAttempts > maxProviderAttempts) break
      // A failed final upload invalidates any older tree, even when reached
      // through a later infrastructure retry which has no checkpoint yet.
      if (row.report?.providerCheckpoint === 'unavailable') break
    } else if (++infrastructureAttempts > MAX_RUN_ATTEMPTS) break
    if (row.baseCommit && row.patch && row.files !== null && row.takenAt) {
      return { baseCommit: row.baseCommit, patch: row.patch.toString('base64'), files: row.files, takenAt: row.takenAt.toISOString(),
        ...(row.unavailableReason ? { unavailableReason: 'too_large' as const } : {}) }
    }
    current = row.retryOf
  }
  return null
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
  const target = cloud ? null : await takeoverTarget(run)
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
  const recovery = await (await import('@/lib/factory/handoff')).factoryRecoveryHandoff(pool, run, retryPrompt(run, outcome.attempt))
  if (recovery.blocked) {
    const ended = await endRun(run.id, LEASED_RUN_STATUSES, { status: 'failed', error: recovery.blocked }, now, true)
    if (ended) await announceEnd({ ...run, status: 'failed' })
    return
  }
  const retried = await db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: 'failed', stopReason: 'device_lost', failureDetails: serverRunFailure(run.id, now), error: `The machine went offline; ${where} as attempt ${outcome.attempt} of ${MAX_RUN_ATTEMPTS}.`, finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, [...LEASED_RUN_STATUSES]), lt(agentRuns.leaseExpiresAt, now), isNull(agentRuns.stopRequestedAt)))
      .returning({ id: agentRuns.id })
    if (!ended) return false
    await runListChanged(tx, run.id)
    await runChanged(tx, run.id)
    if (cloud) return true
    await tx.insert(agentRuns).values({
      id: retryId, userId: run.userId, issueId: run.issueId, agentId: run.agentId, botId: run.botId, source: run.source,
      // A device retry continues the same entry; a legacy source keeps the
      // host's automatic recovery as its origin rather than guessing 'web'.
      ...resolveRunOrigin({ sourceRun: run, defaultOrigin: 'automation' }),
      agentDefinition: retryWorkerDefinition(target ? await rebindExecutionDevice(pool, run, target.deviceId) : run.agentDefinition, recovery.prompt),
      deviceId: target?.deviceId ?? run.deviceId, deviceRepoId: target?.deviceRepoId ?? run.deviceRepoId, status: 'queued', kind: run.kind, baseBranch: run.baseBranch,
      prompt: recovery.prompt, promptTaskStart: recovery.promptTaskStart, promptTaskLength: recovery.promptTaskLength, attempt: outcome.attempt, retryOf: run.id,
    })
    await runListChanged(tx, retryId)
    await runChanged(tx, retryId)
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
  if (run.agentDefinition?.harness === cloud.harness && run.agentDefinition?.model) return { model: run.agentDefinition.model,
    ...(run.agentDefinition.modelDispatch ? { modelDispatch: structuredClone(run.agentDefinition.modelDispatch) } : {}),
    ...(run.agentDefinition.policyCeiling ? { policyCeiling: structuredClone(run.agentDefinition.policyCeiling) } : {}) }
  const chosen = await chooseCloudRunModel(pool, { ownerId: run.userId, workspaceId: cloud.workspaceId, botId: run.botId }, cloud.agentId, cloud.harness)
  if ('error' in chosen) throw new Error('No cloud model')
  return { ...chosen, ...(run.agentDefinition?.policyCeiling ? { policyCeiling: structuredClone(run.agentDefinition.policyCeiling) } : {}) }
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
      // Moving the lost run to the cloud keeps its entry; a legacy run keeps
      // the host's automatic recovery as its origin rather than guessing 'web'.
      ...resolveRunOrigin({ sourceRun: run, defaultOrigin: 'automation' }),
      executionNote: retryNote(attempt) + handoff, withoutBot: run.botId === null, idempotencyKey: `retry:${run.id}`, threadRunId: run.id, ...await cloudRetryModel(run, cloud) })
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
    // A concurrent durable handoff owns this run's provisioning lease. Its
    // first VM is not a failed attempt, and only that lease may finish/clean it.
    const { ComputerError } = await import('@/lib/computer/store')
    if (error instanceof ComputerError && error.status === 409 && error.message === 'Thread provisioning in progress')
      return { state: 'unavailable' as const, reason: 'provisioning' as const }
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
    await failUnclaimedCloudStart(actor, runId, error)
  }
}

/** A startup error is an infrastructure failure, never an Owner stop. Commit
 * that distinction before machine cleanup invokes the Factory end hook. */
export async function failUnclaimedCloudStart(actor: { userId: string; workspaceId: string }, runId: string, error: unknown): Promise<boolean> {
  const { RetainedTaskMachineUnavailable, threadMachineAction, threadMachineStartFailure } = await import('@/lib/cloud-computer/thread-machines')
  const { ComputerError } = await import('@/lib/computer/store')
  if (error instanceof RetainedTaskMachineUnavailable ||
    (error instanceof ComputerError && error.status === 409 && error.message === 'Thread provisioning in progress')) return false
  const provisionFailure = threadMachineStartFailure(error)
  if (provisionFailure && (provisionFailure.userId !== actor.userId || provisionFailure.workspaceId !== actor.workspaceId || provisionFailure.runId !== runId)) return false
  const noMachine = await noMachineCard()
  const failed = await db.transaction(async tx => {
    const [run] = await tx.select().from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, actor.userId),
      sql`EXISTS(SELECT 1 FROM computer_run_bindings b WHERE b."runId"=${agentRuns.id} AND b."ownerId"=${actor.userId} AND b."workspaceId"=${actor.workspaceId})`)).for('update')
    // A worker claim or an explicit stop owns its outcome. A failed lifecycle
    // enqueue must not turn either one into a new failure or clean its VM.
    const now = new Date()
    if (!run || run.status !== 'queued' || run.startedAt || run.sessionId || run.stopRequestedAt ||
      (run.leaseExpiresAt && run.leaseExpiresAt > now) || run.questionContinuation?.requireSessionResume) return null
    const { rows: [machine] } = await tx.execute(sql`SELECT "ownerId","workspaceId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=${runId} FOR UPDATE`)
    // An error from our own committed provision may settle that lease, but a
    // newer lease or a completed provision wins even after its lease cleared.
    // Keep the old lease until end() records unknown-create cleanup custody.
    if (provisionFailure && machine?.workerLeaseId !== provisionFailure.leaseId) return null
    if (machine && (machine.ownerId !== actor.userId || machine.workspaceId !== actor.workspaceId ||
      (!provisionFailure && machine.workerLeaseUntil && new Date(String(machine.workerLeaseUntil)) > now))) return null
    // The same retention fence also covers the synchronous Coordinator path
    // and a lifecycle enqueue failure after an old task VM was adopted.
    const retained = await tx.execute(sql`SELECT 1 FROM thread_machines m
      WHERE m."runId"=${runId} AND m."ownerId"=${actor.userId} AND m."workspaceId"=${actor.workspaceId}
        AND m."issueId"=${run.issueId} AND m.state<>'ended' AND m."sandboxId" IS NOT NULL
        AND EXISTS(SELECT 1 FROM thread_machines old JOIN agent_runs previous ON previous.id=old."runId" AND previous."userId"=old."ownerId"
          WHERE old."runId"<>m."runId" AND old."ownerId"=m."ownerId" AND old."workspaceId"=m."workspaceId" AND old."issueId"=m."issueId"
            AND old."deviceId"=m."deviceId" AND old."repoId"=m."repoId" AND old.state='ended' AND old."sandboxId" IS NULL
            AND previous.status IN ('succeeded','failed','stopped','cancelled'))`)
    if (retained.rowCount) return null
    const [ended] = await tx.update(agentRuns).set({ status: 'failed', pauseReason: null, resumeStatus: null,
      stopReason: 'device_lost', failureDetails: serverRunFailure(runId, now), error: run.error ?? DEVICE_STAYED_OFFLINE, finishedAt: now, updatedAt: now })
      .where(eq(agentRuns.id, runId)).returning()
    const event = runFinishedEvent({ ...ended, stopReason: 'device_lost', report: null })
    await recordCoordinatorEvent(tx, { ...event, payload: { ...event.payload, noMachine } })
    // The terminal row changed even when its durable completion event already exists.
    await runListChanged(tx, ended.id)
    await runChanged(tx, ended.id)
    return ended
  })
  if (!failed) return false
  // end() cannot overwrite this already-terminal failure. It still fences
  // provisioning and revokes/cleans only the machine that this run owns.
  await threadMachineAction(pool, actor, runId, 'end').catch(() => undefined)
  // Admission may have failed before any machine row existed, so do not rely
  // on cleanup to reconcile the committed failure. This hook is idempotent.
  await afterRunEnded(actor.userId, runId)
  await wakeCoordinator(actor.userId).catch(() => undefined)
  return true
}

/** The card of what the person can do when no machine can continue a run. */
async function noMachineCard() {
  return (await import('@/lib/rule-dispatch')).machineUnavailableCard()
}

/** Ends a run that is still in one of `from`; false when something else ended it first. */
async function endRun(runId: string, from: readonly Run['status'][], end: { status: 'failed' | 'stopped'; error: string | null }, now: Date, expiredLease = false, noMachine?: unknown): Promise<boolean> {
  return db.transaction(async tx => {
    const [ended] = await tx.update(agentRuns)
      .set({ status: end.status, pauseReason: null, resumeStatus: null, stopReason: 'device_lost', failureDetails: end.status === 'failed' ? serverRunFailure(runId, now) : null, error: end.error, finishedAt: now, updatedAt: now })
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
      .set({ status: 'failed', pauseReason: null, resumeStatus: null, stopReason: 'error', failureDetails: serverRunFailure(runId, now), error: DAEMON_UPGRADE_REQUIRED, finishedAt: now, updatedAt: now })
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

/** A queued subscription must not wait forever after its device loses the
 * broker. Read the current report under lock: a stale claim snapshot cannot
 * fail a device that already recovered. A claim, stop or newer assignment wins. */
export async function failQueuedSubscriptionRuntime(runId: string, deviceId: string, userId: string,
  expected: { harness: 'codex' | 'claude_code'; bindingId: string }, now = new Date()): Promise<boolean> {
  const ended = await db.transaction(async tx => {
    const [device] = await tx.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.ownerId, userId), eq(devices.kind, 'local'), eq(devices.enabled, true), isNull(devices.removedAt))).for('update')
    if (!device) return null
    const info = device.harnesses.find(item => item.harness === expected.harness)
    if (info?.installed && info.toolApproval && info.subscriptionBroker && !info.subscriptionPreflight) return null
    const detail = subscriptionPreflightSchema.safeParse(info?.subscriptionPreflight).data ?? (!info?.installed ? 'cli_missing' : 'adapter_start_failed')
    const error = new CodedError('subscription_local_runtime_unavailable', { detail })
    const summary = messages.RunErrors.subscription_local_runtime_unavailable[detail ?? 'default']
    const report: RunReport = { summary, filesChanged: [], verify: { status: 'not_run' }, openQuestions: [], nextStep: null }
    const [run] = await tx.update(agentRuns).set({ status: 'failed', pauseReason: null, resumeStatus: null, stopReason: 'error', error: error.message,
      report, failureDetails: serverRunFailure(runId, now, error), finishedAt: now, updatedAt: now })
      .where(and(eq(agentRuns.id, runId), eq(agentRuns.deviceId, deviceId), eq(agentRuns.userId, userId), eq(agentRuns.status, 'queued'),
        isNull(agentRuns.startedAt), isNull(agentRuns.sessionId), isNull(agentRuns.stopRequestedAt), or(isNull(agentRuns.leaseExpiresAt), lt(agentRuns.leaseExpiresAt, now)),
        sql`EXISTS (SELECT 1 FROM agents a WHERE a.id=${agentRuns.agentId} AND a."userId"=${userId}
          AND coalesce(${agentRuns.agentDefinition}->>'harness',a.harness)=${expected.harness})`,
        // Current snapshots pin their subscription; legacy snapshots are null
        // and the authenticated claim supplied their resolved binding above.
        sql`(${agentRuns.agentDefinition} IS NULL OR (${agentRuns.agentDefinition}->'apiKey' IS NULL
          AND ${agentRuns.agentDefinition}->'subscription'->>'bindingId'=${expected.bindingId}))`))
      .returning()
    if (!run) return null
    await recordCoordinatorEvent(tx, runFinishedEvent({ ...run, stopReason: 'error', report }))
    await runListChanged(tx, run.id)
    await runChanged(tx, run.id)
    return { run, error }
  })
  if (!ended) return false
  logCodedError(ended.error, { runId, harness: expected.harness })
  await announceEnd({ ...ended.run, status: 'failed' })
  return true
}

/** The run error a too-old daemon leaves (lib/coordinator/context.ts tells the person to update). */
export const DAEMON_UPGRADE_REQUIRED = 'Mikka on this device needs an update.'

/** Same as a completion from the daemon: tokens off, and the Coordinator hears it. A failure lands in 等你. */
async function announceEnd(run: Run & { status: 'failed' | 'stopped' }) {
  await revokeRunTokens(run.id)
  stopRecordingsAfter([run.id])
  await afterRunEnded(run.userId, run.id)
  afterJob('after:coordinator-wake', () => wakeCoordinator(run.userId))
}
