import { anonymousCodexStartupHint } from '../computer/codex-startup-hint'
import { anonymousClaudeStartupHint, firstAnonymousClaudeTask } from '../computer/claude-startup-hint'
import { runChanged } from '../live/panels'
import { taskActivityChanged } from '../factory/activity-live'
import { recordCancelledThreadSessionEnd } from './thread-machine-sessions'
import { cloudStartupSpan, cloudStartupPhases, cloudStartupRunAttributes } from '@/lib/computer/startup-tracing'
import { captureTraceContext, withRunSpan } from '@/lib/tracing/context'
import { daemonTraceSettings } from '@/lib/tracing/config'
import 'server-only'
import { runListChanged } from '../live/lists'
import { rebindExecutionDevice, revalidateExecutionIdentity } from '../execution-identity'
import { botWorkspacePath, initializeBotWorkspace } from '@/lib/computer/bot-workspace'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { NotFoundError, Sandbox, SandboxNotFoundError } from 'e2b'
import { z } from 'zod'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { matchesRepositoryAdmission } from '@/lib/repository-admission'
import { ComputerError } from '@/lib/computer/store'
import { computerPermission } from '@/lib/computer/permission'
import { connectComputer, installComputerRuntime, startDesktop, syncDesktopLease } from '@/lib/computer/e2b-provider'
import { CLOUD_WORKER_COMMAND, CLOUD_PRELOADER_WAKE_COMMAND, CLOUD_PRELOADER_WAKE_RECEIPT } from '@/lib/computer/worker-command'
import { cloudTemplateOrigin, threadMachineTemplateKind } from '@/lib/cloud-template-models'
import { computerTemplate, e2bApiKey, taskTemplate, withE2BErrors } from '@/lib/secrets/e2b-runtime'
import { bootstrapOfficialInstance, isOfficialE2BTemplate, stageOfficialWorkerRelease, switchOfficialWorkerRelease, runtimeCommandOptions, runtimeRequestOptions, type RuntimeBudget } from '@/lib/computer/official-runtime'
import type { Actor } from './subagents'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { armDueTimerAfterCommit, armDueTimerSoon } from '@/lib/due-timer'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import { logThreadLifecycle } from './thread-lifecycle-log'
import { secretMaskerFor } from '@/lib/secrets/runtime'
import { credentialScrubCommand } from '../../packages/daemon/src/credential-globs'
import { threadLifecycleProvider, threadSnapshotName, threadSnapshotsEnabled } from './thread-lifecycle-provider'
import { readWorkerTail, saveWorkerTail, workerCommand, logRuntimeRefreshFailure, type RuntimeRefreshPhase } from './thread-worker-logs'
import { registrationCommand, quoteShell, REGISTRATION_WAITING, REGISTRATION_COMPLETE, REGISTRATION_LEGACY } from '@/lib/computer/registration-command'
import { openWorkerBootstrapBroker, type WorkerBootstrapBroker } from '@/lib/computer/bootstrap-broker'
import { finishThreadRegistration, prepareThreadRegistration } from './thread-registration'
import { factoryEventId } from '../factory/event-id'
import { questionFingerprint } from '../factory/questions/contract'
import { unclaimedPlanQuestionContinuation } from '../factory/questions/execution-continuation'
import type { FactoryTask } from '../factory/store'
import type { agentRuns } from '../db/schema'
import { assertRunProjectResources, isProjectExecutionRefusal, withRunProjectResources } from '../project-resources/run-lease'
/** A thread machine runs on its owner's own E2B key (orchestration § 2); this module only acts for that owner. */
async function options(ownerId: string) {
  return { apiKey: await e2bApiKey(ownerId, 'Cloud runtime unavailable'), proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
}
/** Register only while this provisioning lease still owns a non-ended row. */
export async function recordThreadSandbox(pool: Pick<Pool, 'query'>, runId: string, sandboxId: string, leaseId: string) {
  // The history INSERT checks its run FK. Acquire that parent lock before the
  // machine, matching park/ensure even when this is one autocommitted query.
  const recorded = Boolean((await pool.query(`WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 FOR KEY SHARE)
    UPDATE thread_machines m SET "sandboxId"=$2,"runningSince"=COALESCE(m."runningSince",clock_timestamp()),"restoreStartedAt"=NULL
    FROM parent WHERE m."runId"=parent.id AND m."workerLeaseId"=$3 AND m.state<>'ended' RETURNING m."runId"`, [runId, sandboxId, leaseId])).rowCount)
  if (recorded) taskActivityChanged(pool, runId)
  return recorded
}
export async function recordCancelledSandbox(pool: Pick<Pool, 'query'>, runId: string, sandboxId: string, operationId: string) {
  const recorded = Boolean((await pool.query(`WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 FOR KEY SHARE)
    UPDATE thread_machines m SET "sandboxId"=$2,"workerLeaseUntil"=NULL,"lifecycleAt"=now()
    FROM parent WHERE m."runId"=parent.id AND m.state='ended' AND m."operationId"=$3 AND m."sandboxId" IS NULL RETURNING m."runId"`, [runId, sandboxId, operationId])).rowCount)
  if (recorded) taskActivityChanged(pool, runId)
  return recorded
}
/** The provider no longer has this sandbox (deleted, expired or killed outside Mikka). */
export function sandboxGone(error: unknown) {
  if (error instanceof SandboxNotFoundError) return true
  const status = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined
  return error instanceof NotFoundError || status === 404
}

/** A failed wake must not destroy a task's retained filesystem and sessions. */
export class RetainedTaskMachineUnavailable extends ComputerError {
  constructor() { super(503, 'Retained task machine unavailable') }
}

type FailedThreadStart = Readonly<{ userId: string; workspaceId: string; runId: string; leaseId: string }>
export type ThreadMachineFence = Readonly<{ epoch: number; sandboxId: string | null; requireClosedTask?: boolean; requireArchived?: boolean; suspendAfterStop?: boolean }>
// Only this module can attest the lease that actually failed. Keep the proof
// off the original error: callers retain ComputerError semantics, and neither
// public error fields nor serialized/replayed errors can authorize cleanup.
const failedThreadStarts = new WeakMap<object, FailedThreadStart>()
export function threadMachineStartFailure(error: unknown): FailedThreadStart | null {
  return error && typeof error === 'object' ? failedThreadStarts.get(error) ?? null : null
}

/**
 * Forgets a thread's lost sandbox so a new one is created for the same thread
 * (orchestration.md § 4): a new operation ID, the running interval closed.
 * With a lease, only that lease's row is reset.
 */
async function replaceGoneSandbox(query: Pick<Pool, 'query'>, runId: string, template: string, leaseId?: string) {
  const replaced = (await query.query(`UPDATE thread_machines SET "sandboxId"=NULL,"operationId"=$2,"snapshotId"=$4,"templateKind"=$5,state='starting',"restoreStartedAt"=NULL,
      "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL
    WHERE "runId"=$1 AND state<>'ended' AND ($3::uuid IS NULL OR "workerLeaseId"=$3) RETURNING *`, [runId, randomUUID(), leaseId ?? null, template, cloudTemplateOrigin(template)?.kind ?? null])).rows[0]
  if (replaced) taskActivityChanged(query, runId)
  return replaced
}

type ThreadSnapshotRow = {
  sandboxId: string; epoch: number; issueId: string | null
  snapshotState: string; snapshotOperationId: string | null; filesystemSnapshotId: string | null
}

/** An owner-created snapshot can be gone (retention, another key management
 * action) or invalid; only those answers justify falling back to the template.
 * A lost response must reconcile through the persisted operation instead. */
function snapshotUnusable(error: unknown) {
  if (sandboxGone(error)) return true
  const status = error && typeof error === 'object' ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode : undefined
  return status === 400 || status === 422
}

/** Delete snapshots this run superseded. A failure keeps the old reference so
 * account cleanup can retry it; a not-found result is already gone. */
async function releaseSupersededThreadSnapshots(client: Pick<PoolClient, 'query'>, actor: Actor, issueId: string | null,
  runId: string, keepSnapshotId: string) {
  if (!issueId) return
  const rows = (await client.query<{ runId: string; filesystemSnapshotId: string }>(`SELECT "runId","filesystemSnapshotId" FROM thread_machines
    WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "issueId"=$3 AND "runId"<>$4
      AND "filesystemSnapshotId" IS NOT NULL AND "filesystemSnapshotId"<>$5`, [actor.userId, actor.workspaceId, issueId, runId, keepSnapshotId])).rows
  for (const row of rows) {
    try {
      await threadLifecycleProvider.deleteSnapshot(row.filesystemSnapshotId, actor.userId)
      await client.query(`UPDATE thread_machines SET "filesystemSnapshotId"=NULL,"snapshotOperationId"=NULL,"snapshotTakenAt"=NULL,"snapshotState"='none'
        WHERE "runId"=$1 AND "filesystemSnapshotId"=$2`, [row.runId, row.filesystemSnapshotId])
    } catch { /* account cleanup retries a superseded snapshot */ }
  }
}

/** Adopt one exact per-run image and supersede older task images. */
async function adoptThreadSnapshot(client: Pick<PoolClient, 'query'>, actor: Actor, runId: string, machine: ThreadSnapshotRow, snapshotId: string) {
  const updated = await client.query(`UPDATE thread_machines SET "filesystemSnapshotId"=$3,"snapshotTakenAt"=now(),"snapshotState"='ready'
    WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$4 AND "snapshotState" IN ('none','creating') AND state<>'ended'
    RETURNING "runId"`, [runId, machine.epoch, snapshotId, machine.sandboxId])
  if (!updated.rowCount) return false
  await releaseSupersededThreadSnapshots(client, actor, machine.issueId, runId, snapshotId)
  return true
}

async function markThreadSnapshotFailed(client: Pick<PoolClient, 'query'>, runId: string, machine: ThreadSnapshotRow) {
  await client.query(`UPDATE thread_machines SET "snapshotState"='failed'
    WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$3 AND "snapshotState" IN ('none','creating') AND state<>'ended'`,
  [runId, machine.epoch, machine.sandboxId])
}

/** A snapshot whose create response was lost may exist under this run's exact
 * name. One match is adopted, zero or several are a recorded failure; a failed
 * listing leaves `creating` so a later pass reconciles instead of taking a
 * second snapshot. DB state, never provider metadata, remains the source. */
async function reconcileCreatingSnapshot(client: Pick<PoolClient, 'query'>, actor: Actor, runId: string, machine: ThreadSnapshotRow) {
  let found
  try { found = await threadLifecycleProvider.listSnapshots(machine.sandboxId, actor.userId, threadSnapshotName(runId)) }
  catch { return false }
  if (found.length === 1) return adoptThreadSnapshot(client, actor, runId, machine, found[0].snapshotId)
  await markThreadSnapshotFailed(client, runId, machine)
  return true
}

/** Retirement is the end of the task's VM and its snapshots. A snapshot still
 * referenced by another row of the same task is kept for that row; otherwise
 * an acknowledged delete clears this row. A failed delete keeps the reference
 * so account cleanup can retry it. */
async function releaseEndedThreadSnapshot(pool: Pool, actor: Actor, runId: string, snapshotId: string) {
  const shared = await pool.query(`SELECT 1 FROM thread_machines
    WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "filesystemSnapshotId"=$3 AND "runId"<>$4 LIMIT 1`,
  [actor.userId, actor.workspaceId, snapshotId, runId])
  if (!shared.rowCount) {
    try { await threadLifecycleProvider.deleteSnapshot(snapshotId, actor.userId) }
    catch { return }
  }
  await pool.query(`UPDATE thread_machines SET "filesystemSnapshotId"=NULL,"snapshotOperationId"=NULL,"snapshotTakenAt"=NULL,"snapshotState"='none'
    WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "filesystemSnapshotId"=$4`,
  [runId, actor.userId, actor.workspaceId, snapshotId])
}

/** Snapshot the task's filesystem only after its native process exited and the
 * credential paths are removed. A failure never fails the pause: the next run
 * takes a new snapshot. `creating` is persisted before provider I/O so a lost
 * ACK is reconciled, not repeated. */
async function takeThreadSnapshot(client: PoolClient, actor: Actor, runId: string, machine: ThreadSnapshotRow) {
  if (machine.snapshotState === 'creating') { await reconcileCreatingSnapshot(client, actor, runId, machine); return }
  if (machine.snapshotState !== 'none' && machine.snapshotState !== 'failed') return
  // A park transaction can roll back after the provider created the image
  // (a pause failure). The exact per-run name recovers that image instead of
  // taking a second one. A failed listing proceeds; storage cannot block pause.
  if (machine.snapshotState === 'none') {
    const existing = await threadLifecycleProvider.listSnapshots(machine.sandboxId, actor.userId, threadSnapshotName(runId)).catch(() => null)
    if (existing) {
      if (existing.length === 1) { await adoptThreadSnapshot(client, actor, runId, machine, existing[0].snapshotId); return }
      if (existing.length > 1) { await markThreadSnapshotFailed(client, runId, machine); return }
    }
  }
  // Connecting would resume a provider-paused VM. Leave the snapshot to the
  // next run, which resumes it and parks again.
  const observed = await threadLifecycleProvider.info(machine.sandboxId, actor.userId).catch(() => null)
  if (!observed || observed.state !== 'running') return
  try {
    const sandbox = await threadMachineProvider.connect(machine.sandboxId, actor.workspaceId)
    const scrubbed = await sandbox.commands.run(credentialScrubCommand(), { user: 'root', timeoutMs: 20_000 })
    if (scrubbed.exitCode !== 0) throw new Error('Thread credential scrub failed')
  } catch {
    // Never snapshot a filesystem that may still hold a credential.
    await markThreadSnapshotFailed(client, runId, machine)
    return
  }
  const operationId = randomUUID()
  const staleSnapshotId = machine.filesystemSnapshotId
  const intent = await client.query(`UPDATE thread_machines SET "snapshotOperationId"=$3,"snapshotState"='creating'
    WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$4 AND "snapshotState" IN ('none','failed') AND state<>'ended' RETURNING "runId"`,
  [runId, machine.epoch, operationId, machine.sandboxId])
  if (!intent.rowCount) return
  try {
    const created = await threadLifecycleProvider.createSnapshot(machine.sandboxId, actor.userId, threadSnapshotName(runId))
    const updated = await client.query(`UPDATE thread_machines SET "filesystemSnapshotId"=$3,"snapshotTakenAt"=now(),"snapshotState"='ready'
      WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$4 AND "snapshotOperationId"=$5 AND state<>'ended' RETURNING "runId"`,
    [runId, machine.epoch, created.snapshotId, machine.sandboxId, operationId])
    if (updated.rowCount) {
      // A stale image from before a restore is replaced by this newer one.
      if (staleSnapshotId && staleSnapshotId !== created.snapshotId) {
        try { await threadLifecycleProvider.deleteSnapshot(staleSnapshotId, actor.userId) } catch { /* no newer authority remains */ }
      }
      await releaseSupersededThreadSnapshots(client, actor, machine.issueId, runId, created.snapshotId)
    }
  } catch {
    await reconcileCreatingSnapshot(client, actor, runId, machine)
  }
}

/** Record an unusable snapshot and delete it best-effort, then let the caller
 * rebuild from the official template. The row keeps `unavailable` so no later
 * wake retries a snapshot E2B already rejected. */
async function releaseUnusableSnapshot(pool: Pool, actor: Actor, runId: string, epoch: number, operationId: string) {
  const row = (await pool.query<{ filesystemSnapshotId: string | null }>(`UPDATE thread_machines SET "snapshotState"='unavailable',"restoreStartedAt"=NULL
    WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND "operationId"=$5 AND state='restore'
    RETURNING "filesystemSnapshotId"`, [runId, actor.userId, actor.workspaceId, epoch, operationId])).rows[0]
  if (!row?.filesystemSnapshotId) return
  try {
    await threadLifecycleProvider.deleteSnapshot(row.filesystemSnapshotId, actor.userId)
    await pool.query(`UPDATE thread_machines SET "filesystemSnapshotId"=NULL,"snapshotOperationId"=NULL,"snapshotTakenAt"=NULL
      WHERE "runId"=$1 AND "filesystemSnapshotId"=$2`, [runId, row.filesystemSnapshotId])
  } catch { /* account cleanup retries an unusable snapshot */ }
}

/** One transition into `restore`: epoch + operation fence, the same task,
 * owner, workspace, repository and template kind, and a queued unstopped run.
 * Returns null when any guard no longer holds; the caller may then fall back
 * to the official template. A snapshot never crosses tasks. */
export async function restoreThreadMachineFromSnapshot(pool: Pool, actor: Actor, runId: string, leaseId: string,
  expected: { sandboxId: string | null; kind?: string | null }, template: string, provider: Pick<typeof threadMachineProvider, 'create'>) {
  const client = await pool.connect()
  let transition: Record<string, any> | undefined
  try {
    await client.query('BEGIN')
    const run = (await client.query(`SELECT r.*,b."workspaceId",repo."repoPath",repo."remoteUrl"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 FOR UPDATE OF r`, [runId, actor.userId, actor.workspaceId])).rows[0]
    const machine = (await client.query('SELECT * FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE', [runId, actor.userId, actor.workspaceId])).rows[0]
    const machineRepo = machine?.repoId
      ? (await client.query('SELECT "repoPath","remoteUrl" FROM device_repos WHERE id=$1 AND "userId"=$2', [machine.repoId, actor.userId])).rows[0]
      : null
    const kind = expected.kind ?? cloudTemplateOrigin(template)?.kind ?? template
    const eligible = Boolean(run && machine && machine.state !== 'ended' && machine.workerLeaseId === leaseId &&
      machine.snapshotState === 'ready' && typeof machine.filesystemSnapshotId === 'string' && machine.filesystemSnapshotId &&
      threadSnapshotsEnabled() && run.status === 'queued' && !run.stopRequestedAt &&
      (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= Date.now()) &&
      machine.sandboxId === expected.sandboxId && (machine.issueId ?? null) === (run.issueId ?? null) &&
      threadMachineTemplateKind(machine) === kind && machineRepo &&
      machineRepo.repoPath === run.repoPath && machineRepo.remoteUrl === run.remoteUrl)
    if (!eligible) { await client.query('COMMIT'); return null }
    transition = (await client.query(`UPDATE thread_machines SET state='restore',epoch=epoch+1,"sandboxId"=NULL,"operationId"=$4,
        "workerLeaseId"=$5,"workerLeaseUntil"=now()+interval '15 minutes',"restoreStartedAt"=now(),"lifecycleAt"=now()+interval '2 minutes',
        "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL,
        lifecycle=(lifecycle-'pausedAt')||jsonb_build_object('phase','restore_requested','owner','run-recovery','failures',0)
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "workerLeaseId"=$5 AND state<>'ended'
        AND "sandboxId" IS NOT DISTINCT FROM $6::text AND "snapshotState"='ready' AND "filesystemSnapshotId"=$7
      RETURNING *`, [runId, actor.userId, actor.workspaceId, randomUUID(), leaseId, expected.sandboxId, machine.filesystemSnapshotId])).rows[0]
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  if (!transition) return null
  const metadata = { application: 'mikka-thread', workspaceId: actor.workspaceId, runId, operationId: transition.operationId }
  try {
    const sandbox = await threadLifecycleProvider.createFromSnapshot(transition.filesystemSnapshotId, transition.operationId, metadata, actor.userId)
    return { sandbox, machine: transition }
  } catch (error) {
    if (!snapshotUnusable(error)) throw error
    await releaseUnusableSnapshot(pool, actor, runId, transition.epoch, transition.operationId)
    const replaced = await replaceGoneSandbox(pool, runId, template, leaseId)
    // error-cause: the unusable snapshot is already recorded; this new error reports that the lease moved away
    if (!replaced) throw new ComputerError(409, 'Thread provisioning cancelled')
    const fallback = { application: 'mikka-thread', workspaceId: actor.workspaceId, runId, operationId: replaced.operationId }
    const sandbox = await provider.create(replaced.snapshotId, replaced.operationId, fallback, actor.userId)
    return { sandbox, machine: replaced }
  }
}

// Prepare the owner's key before a stop holds an APP client. The existing key
// reader may itself need that pool (including legacy-key adoption).
const threadMachineStopPreparation: { prepareKill?: (ownerId: string) => Promise<(sandboxId: string) => Promise<void>> } = {
  prepareKill: async (ownerId) => {
    const preparedOptions = await options(ownerId)
    return async (sandboxId) => { await Sandbox.kill(sandboxId, preparedOptions) }
  },
}
/** Provider calls of scoped thread operations; tests replace them, production uses E2B. */
export const threadMachineProvider = {
  ...threadMachineStopPreparation,
  connect: (sandboxId: string, workspaceId: string, budget?: RuntimeBudget) => connectComputer(workspaceId, sandboxId, undefined, budget),
  create: async (snapshotId: string, operationId: string, metadata: Record<string, string>, ownerId: string) => {
    if (!cloudTemplateOrigin(snapshotId)) throw new ComputerError(409, 'Verified cloud template required')
    const attributes = metadata.runId ? cloudStartupRunAttributes(metadata.runId) : {}
    const base = await cloudStartupSpan('cloud.sandbox.credentials', attributes, () => options(ownerId))
    const sandbox = await cloudStartupSpan('cloud.sandbox.create', attributes, () => withE2BErrors(ownerId, true, () => Sandbox.create(snapshotId, { ...base, idempotencyKey: operationId, timeoutMs: 15 * 60_000, metadata, lifecycle: { onTimeout: 'pause', autoResume: false } })))
    if (isOfficialE2BTemplate(snapshotId)) await cloudStartupSpan('cloud.sandbox.bootstrap', attributes, () => bootstrapOfficialInstance(sandbox, snapshotId))
    return sandbox
  },
  kill: async (sandboxId: string, ownerId: string) => { await Sandbox.kill(sandboxId, await options(ownerId)) },
}

/**
 * A queued run whose stop was requested while it has a machine binding (stopOwnedRun leaves
 * those to the machine lifecycle) ends here instead of provisioning. The caller is inside
 * BEGIN and holds the agent_runs row lock. Same writes as the 'end' action: run 'stopped',
 * machine 'ended' (sandboxId kept so a failed kill stays retryable; a lease another worker
 * still holds keeps workerLeaseUntil so that worker cleans up its own sandbox). Commits and
 * returns the sandbox to kill, if any.
 */
async function endStopRequestedRun(client: PoolClient, actor: Actor, runId: string, confirmedKilledSandboxId?: string) {
  const m = (await client.query('SELECT "sandboxId","deviceId","workerLeaseId","workerLeaseUntil" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE', [runId, actor.userId, actor.workspaceId])).rows[0]
  const pending = Boolean(m && !m.sandboxId && (m.workerLeaseId || m.workerLeaseUntil))
  const stopped = await client.query(`UPDATE agent_runs SET status='stopped',"finishedAt"=COALESCE("finishedAt",now()),"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND status='queued' RETURNING id`, [runId, actor.userId])
  if (stopped.rowCount) { await runListChanged(client, runId); await runChanged(client, runId) }
  if (m) await client.query(`UPDATE thread_machines SET state='ended',"endedAt"=COALESCE("endedAt",now()),"computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL,
    "workerLeaseId"=NULL,"workerLeaseUntil"=CASE WHEN $2 THEN COALESCE("workerLeaseUntil",now()) ELSE NULL END,
    "lifecycleAt"=CASE WHEN "sandboxId"=$3 OR ("sandboxId" IS NULL AND NOT $2) THEN NULL ELSE now() END,
    lifecycle=(lifecycle-'reconcileId'-'reconcileUntil')||jsonb_build_object('phase',CASE WHEN "sandboxId"=$3 OR ("sandboxId" IS NULL AND NOT $2) THEN 'retired' ELSE 'retire_requested' END,'owner','run-recovery'),
    "sandboxId"=CASE WHEN "sandboxId"=$3 THEN NULL ELSE "sandboxId" END WHERE "runId"=$1`, [runId, pending, confirmedKilledSandboxId ?? null])
  if (m && (m.sandboxId || pending)) {
    await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [m.deviceId])
    await client.query('UPDATE devices SET "removedAt"=COALESCE("removedAt",now()) WHERE id=$1 AND "ownerId"=$2 AND kind=\'cloud\'', [m.deviceId, actor.userId])
  }
  if (m?.sandboxId && m.sandboxId === confirmedKilledSandboxId) taskActivityChanged(client, runId)
  armDueTimerAfterCommit(client, 'run-recovery')
  await client.query('COMMIT')
  return (m?.sandboxId as string | null) ?? null
}

/** Shared by explicit Stop and a queued wake that observes Stop before any
 * provider work. A never-claimed continuation may still own its task's native
 * history, so checking only the current run's status is not enough to kill. */
async function canAcknowledgeQueuedThreadStop(client: PoolClient, actor: Actor, run: Record<string, any>, machine: Record<string, any> | undefined) {
  if (run.workspaceId !== actor.workspaceId || run.status !== 'queued' || !run.stopRequestedAt || run.startedAt != null || run.sessionId != null ||
    run.deviceTokenId != null || run.leaseExpiresAt != null || run.questionContinuation != null) return false
  const legacyMachine = machine?.issueId === null
  if (machine && (machine.runId !== run.id || machine.ownerId !== actor.userId || machine.workspaceId !== actor.workspaceId ||
    machine.state === 'ended' || machine.botId !== run.runtimeBotId || (!legacyMachine && machine.issueId !== run.issueId) ||
    machine.workerLeaseId || (machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now()) ||
    machine.lifecycle?.requiresNativeExit === true)) return false
  if (machine && legacyMachine) {
    // The task-machine migration added a nullable column without backfilling
    // old machines. A verified never-claimed binding may still be stopped;
    // this does not assign a Task or authorize a wake, adoption or credential.
    if (!machine.deviceId || !machine.repoId || machine.deviceId !== run.deviceId || machine.repoId !== run.deviceRepoId) return false
    const target = await client.query(`SELECT 1 FROM devices d
      JOIN device_repos repo ON repo."deviceId"=d.id AND repo."userId"=d."ownerId"
      WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='cloud' AND repo.id=$3 FOR SHARE OF d,repo`,
    [machine.deviceId, actor.userId, machine.repoId])
    if (!target.rowCount) return false
  }
  const native = await client.query(`SELECT 1 FROM byos_native_runs WHERE "runId"=$1
    UNION ALL SELECT 1 FROM agent_runs source WHERE source.id<>$1
      AND ($5::boolean OR (source."userId"=$2 AND source."issueId" IS NOT DISTINCT FROM $3::uuid))
      AND source."deviceId"=$4 AND (source."sessionId" IS NOT NULL OR source."startedAt" IS NOT NULL
        OR source."deviceTokenId" IS NOT NULL OR EXISTS(SELECT 1 FROM byos_native_runs n WHERE n."runId"=source.id))
    LIMIT 1`, [run.id, actor.userId, run.issueId, machine?.deviceId ?? null, legacyMachine])
  return native.rowCount === 0
}

/** A rejected first claim may leave no daemon journal or lifecycle to acknowledge
 * Stop. This host path handles only a bound, never-claimed run without native
 * continuity. Its frozen Profile and retry lineage are not proof of a claim.
 * Keep the original queued binding on an uncertain kill, so ordinary Stop can
 * retry; only a confirmed kill (including provider not-found) commits the end. */
export async function acknowledgeQueuedThreadStop(pool: Pool, actor: Actor, runId: string, provider: Pick<typeof threadMachineProvider, 'kill' | 'prepareKill'> = threadMachineProvider): Promise<boolean> {
  // This read releases its pool client before credential preparation. It is
  // only a preflight: every authority/native check is repeated under locks.
  const candidate = await pool.query(`SELECT 1 FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId" AND m."workspaceId"=b."workspaceId"
    WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."workspaceId"=b."workspaceId" AND r.status='queued' AND r."stopRequestedAt" IS NOT NULL
      AND r."startedAt" IS NULL AND r."sessionId" IS NULL AND r."deviceTokenId" IS NULL AND r."leaseExpiresAt" IS NULL AND r."questionContinuation" IS NULL
      AND m."sandboxId" IS NOT NULL AND m.state<>'ended' AND m."botId"=b."botId"
      AND ((m."issueId" IS NOT NULL AND m."issueId"=r."issueId") OR (m."issueId" IS NULL
        AND m."deviceId"=r."deviceId" AND m."repoId"=r."deviceRepoId"
        AND EXISTS(SELECT 1 FROM devices d JOIN device_repos repo ON repo."deviceId"=d.id AND repo."userId"=d."ownerId"
          WHERE d.id=m."deviceId" AND d."ownerId"=r."userId" AND d.kind='cloud' AND repo.id=m."repoId")))
      AND m."workerLeaseId" IS NULL AND (m."workerLeaseUntil" IS NULL OR m."workerLeaseUntil"<=now())
      AND m.lifecycle->>'requiresNativeExit' IS DISTINCT FROM 'true'
      AND NOT EXISTS(SELECT 1 FROM byos_native_runs n WHERE n."runId"=r.id)
      AND NOT EXISTS(SELECT 1 FROM agent_runs source WHERE source.id<>r.id
        AND (m."issueId" IS NULL OR (source."userId"=r."userId" AND source."issueId" IS NOT DISTINCT FROM r."issueId")) AND source."deviceId"=m."deviceId"
        AND (source."sessionId" IS NOT NULL OR source."startedAt" IS NOT NULL OR source."deviceTokenId" IS NOT NULL
          OR EXISTS(SELECT 1 FROM byos_native_runs n WHERE n."runId"=source.id)))`, [runId, actor.userId, actor.workspaceId])
  if (!candidate.rowCount) return false
  const kill = provider.prepareKill ? await provider.prepareKill(actor.userId) : (sandboxId: string) => provider.kill(sandboxId, actor.userId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-machine:${runId}`])
    const run = (await client.query(`SELECT r.*,b."botId" AS "runtimeBotId"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."workspaceId"=b."workspaceId" FOR UPDATE OF r`, [runId, actor.userId, actor.workspaceId])).rows[0]
    if (!run) { await client.query('ROLLBACK'); return false }
    const machine = (await client.query(`SELECT * FROM thread_machines
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE`, [runId, actor.userId, actor.workspaceId])).rows[0]
    // A native claim is authoritative even if a stale status says queued.
    // An adopted machine may retain the same task's native history without
    // retryOf/continuesRunId. Protect actual history on this task/device; a
    // frozen Profile or lineage id without a claim is not such history.
    if (!machine?.sandboxId || !await canAcknowledgeQueuedThreadStop(client, actor, run, machine)) {
      await client.query('ROLLBACK'); return false
    }
    // The persisted stop blocks claims; these same run/machine locks fence
    // adoption and provisioning. No nested transaction or Run write is used.
    await kill(machine.sandboxId)
    await endStopRequestedRun(client, actor, runId, machine.sandboxId)
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  await afterRunEnded(actor.userId, runId)
  return true
}

// These queries bind m to the machine and r to its source run. Host lease
// recovery can write a terminal status without stopping a claimed native process.
const unconfirmedNativeExitSql = `((m.lifecycle->>'requiresNativeExit' IS NOT DISTINCT FROM 'true'
  OR r."stopRequestedAt" IS NOT NULL OR (r."stopReason"='device_lost'
    AND (r."startedAt" IS NOT NULL OR r."sessionId" IS NOT NULL OR r."deviceTokenId" IS NOT NULL)))
  IS TRUE AND r.report->'safePoint'->>'session' IS DISTINCT FROM 'exited')`

/**
 * One task, one sandbox (Alex, 2026-11-01: 「任务跟沙箱机器应该是强绑定。不能一个任务用完之后，
 * 另外一个任务接着去用，这是不允许的。」). A new run of a task takes over the task's
 * own paused sandbox: same owner, workspace, task and repository, and the run
 * that left it has ended. The machine belongs to the task, not to a bot: a
 * follow-up the person sends to another bot on the same task still gets it. The old row ends without a kill and gives up the
 * sandbox; the new row resumes it, so the worktree, the agent's sessions and
 * the worker survive. No other task's machine can match. Caller holds BEGIN
 * and the new run's lock.
 */
async function adoptTaskMachine(client: PoolClient, actor: Actor, runId: string, run: { issueId: string; runtimeBotId: string; repoPath: string; remoteUrl: string | null }, template: string | null) {
  // The run's bot runtime is recorded on the new row; the old row's bot does not have to match.
  // A repository task's machine holds only its harness's CLI. Keep the same
  // harness's VM across additive releases; its private worker upgrades below.
  const templateKind = template ? cloudTemplateOrigin(template)?.kind ?? template : null
  // A person can continue immediately after the terminal receipt, before the
  // lifecycle parks the VM. Use the same locked handoff as adjacent stages;
  // a terminal status without native exit never authorizes this transfer.
  const { rows: [running] } = await client.query(`SELECT m."runId" FROM thread_machines m
    WHERE m."ownerId"=$1 AND m."workspaceId"=$2 AND m."issueId"=$3 AND m."runId"<>$4
      AND m.state='running' AND m."sandboxId" IS NOT NULL
    ORDER BY m."lastActiveAt" DESC LIMIT 1`, [actor.userId, actor.workspaceId, run.issueId, runId])
  if (running) await retainThreadMachineForHandoffLocked(client, actor, running.runId, runId)
  const previous = (await client.query(`SELECT m.* FROM thread_machines m
      JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
      JOIN device_repos repo ON repo.id=m."repoId" AND repo."userId"=m."ownerId"
    WHERE m."ownerId"=$1 AND m."workspaceId"=$2 AND m."issueId"=$3 AND m."runId"<>$4
      AND (m.state='paused' OR (m.state='running' AND m.lifecycle->>'phase'='handoff' AND m.lifecycle->>'handoffRunId'=$4::text
        AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=now())
        AND COALESCE((m.lifecycle->>'reconcileUntil')::double precision,0)<=extract(epoch FROM clock_timestamp())*1000))
      AND (m."workerLeaseUntil" IS NULL OR m."workerLeaseUntil"<=now()) AND m."sandboxId" IS NOT NULL AND m."deviceId" IS NOT NULL
      AND r.status IN ('succeeded','failed','stopped','cancelled')
      AND NOT ${unconfirmedNativeExitSql}
      AND repo."repoPath"=$5 AND repo."remoteUrl" IS NOT DISTINCT FROM $6
      AND ($7::text IS NULL OR m."templateKind"=$7 OR (m."templateKind" IS NULL AND m."snapshotId"=$7))
    ORDER BY m."lastActiveAt" DESC LIMIT 1 FOR UPDATE OF m`, [actor.userId, actor.workspaceId, run.issueId, runId, run.repoPath, run.remoteUrl, templateKind])).rows[0]
  if (!previous) {
    const busy = await client.query(`SELECT 1 FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
      JOIN device_repos repo ON repo.id=m."repoId" AND repo."userId"=m."ownerId"
      WHERE m."ownerId"=$1 AND m."workspaceId"=$2 AND m."issueId"=$3 AND m."runId"<>$4 AND m.state='paused'
        AND m."sandboxId" IS NOT NULL AND (m."workerLeaseUntil">now() OR r.status NOT IN ('succeeded','failed','stopped','cancelled')
          OR ${unconfirmedNativeExitSql})
        AND repo."repoPath"=$5 AND repo."remoteUrl" IS NOT DISTINCT FROM $6
        AND ($7::text IS NULL OR m."templateKind"=$7 OR (m."templateKind" IS NULL AND m."snapshotId"=$7)) LIMIT 1`,[actor.userId,actor.workspaceId,run.issueId,runId,run.repoPath,run.remoteUrl,templateKind])
    if (busy.rowCount) throw new ComputerError(409,'Task runtime maintenance in progress')
    return null
  }
  const { rows: [transfer] } = await client.query<{ transferredAt: string }>(`UPDATE thread_machines SET state='ended',"endedAt"=COALESCE("endedAt",now()),"sandboxId"=NULL,"lifecycleAt"=NULL,
    "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL,
    lifecycle=lifecycle||jsonb_build_object('phase','transferred','transferredAt',GREATEST(clock_timestamp(),"runningSince"))
    WHERE "runId"=$1 RETURNING lifecycle->>'transferredAt' AS "transferredAt"`, [previous.runId])
  taskActivityChanged(client, previous.runId)
  taskActivityChanged(client, runId)
  // A snapshot whose create response was lost is named after the previous run
  // and cannot be reconciled by this row. Transfer only a settled reference.
  const snapshot = previous.snapshotState === 'creating'
    ? { state: 'none', operationId: null, takenAt: null }
    : { state: previous.snapshotState, operationId: previous.snapshotOperationId, takenAt: previous.snapshotTakenAt }
  return (await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","snapshotId","operationId",state,"sandboxId","deviceId","repoId","templateKind",epoch,"runningSince","filesystemSnapshotId","snapshotOperationId","snapshotTakenAt","snapshotState")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$12,$8,$9,$10,$11,$13,CASE WHEN $12='running' THEN $14::timestamptz ELSE NULL END,$15,$16,$17,$18)
    ON CONFLICT ("runId") DO UPDATE SET "issueId"=EXCLUDED."issueId","snapshotId"=EXCLUDED."snapshotId","templateKind"=EXCLUDED."templateKind",state=EXCLUDED.state,"sandboxId"=EXCLUDED."sandboxId","deviceId"=EXCLUDED."deviceId","repoId"=EXCLUDED."repoId",epoch=EXCLUDED.epoch,"runningSince"=EXCLUDED."runningSince","filesystemSnapshotId"=EXCLUDED."filesystemSnapshotId","snapshotOperationId"=EXCLUDED."snapshotOperationId","snapshotTakenAt"=EXCLUDED."snapshotTakenAt","snapshotState"=EXCLUDED."snapshotState","lifecycleAt"=now(),lifecycle='{}'::jsonb
    RETURNING *`, [runId, actor.workspaceId, actor.userId, run.runtimeBotId, run.issueId, previous.snapshotId, randomUUID(), previous.sandboxId, previous.deviceId, previous.repoId, threadMachineTemplateKind(previous), previous.state, previous.epoch + 1, transfer.transferredAt, previous.filesystemSnapshotId, snapshot.operationId, snapshot.takenAt, snapshot.state])).rows[0]
}

/** An already admitted next run gets a short transfer window.
 * The daemon must have closed the native session first; a status string alone
 * never authorizes moving a still executing VM. */
async function retainThreadMachineForHandoffLocked(client: PoolClient, actor: Actor, runId: string, nextRunId: string): Promise<boolean> {
    const { rows: [run] } = await client.query(`SELECT r.id FROM agent_runs r JOIN issues i ON i.id=r."issueId"
      WHERE r.id=$1 AND r."userId"=$2 AND r.status IN ('succeeded','failed','stopped','cancelled')
        AND r."stopRequestedAt" IS NULL AND r.report->'safePoint'->>'session'='exited'
        AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=now())
        AND i.status NOT IN ('done','canceled','duplicate') AND i.content->'attrs'->'mikka'->>'deletedAt' IS NULL
        AND EXISTS (SELECT 1 FROM agent_runs n JOIN computer_run_bindings b ON b."runId"=n.id
          WHERE n.id=$4 AND n."userId"=r."userId" AND n."issueId"=r."issueId" AND n.status='queued'
            AND n."stopRequestedAt" IS NULL AND (n."leaseExpiresAt" IS NULL OR n."leaseExpiresAt"<=now())
            AND b."ownerId"=r."userId" AND b."workspaceId"=$3)
      FOR UPDATE OF r`, [runId, actor.userId, actor.workspaceId, nextRunId])
    if (!run) return false
    const { rows: [machine] } = await client.query(`SELECT * FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
      AND state='running' AND "sandboxId" IS NOT NULL AND ("workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=now())
      AND COALESCE(lifecycle->>'phase','') IN ('','created','resumed','active','handoff')
      AND COALESCE((lifecycle->>'reconcileUntil')::double precision,0)<=extract(epoch FROM clock_timestamp())*1000
      AND (lifecycle->>'phase' IS DISTINCT FROM 'handoff' OR lifecycle->>'handoffRunId'=$4::text)
      FOR UPDATE`, [runId, actor.userId, actor.workspaceId, nextRunId])
    if (!machine) return false
    const { rows: [placement] } = await client.query(`SELECT source."repoPath" AS "sourcePath",source."remoteUrl" AS "sourceRemote",
      target."repoPath" AS "targetPath",target."remoteUrl" AS "targetRemote",COALESCE(n."agentDefinition"->>'harness',a.harness) AS harness
      FROM agent_runs n JOIN agents a ON a.id=n."agentId" AND a."userId"=n."userId"
      JOIN device_repos target ON target.id=n."deviceRepoId" AND target."userId"=n."userId"
      JOIN device_repos source ON source.id=$3 AND source."userId"=n."userId"
      WHERE n.id=$1 AND n."userId"=$2`, [nextRunId, actor.userId, machine.repoId])
    const nextKind = placement?.targetRemote ? placement.harness === 'claude_code' ? 'claude' : placement.harness === 'codex' ? 'codex' : null : 'desktop'
    if (!placement || placement.sourcePath !== placement.targetPath || placement.sourceRemote !== placement.targetRemote || threadMachineTemplateKind(machine) !== nextKind) {
      return false
    }
    await client.query(`UPDATE thread_machines SET epoch=epoch+CASE WHEN lifecycle->>'handoffRunId'=$2 THEN 0 ELSE 1 END,
      lifecycle=(lifecycle-'reconcileId'-'reconcileUntil')||jsonb_build_object('phase','handoff','owner','run-recovery','handoffRunId',$2::text,'handoffUntil',floor(extract(epoch FROM (clock_timestamp()+interval '45 seconds'))*1000)::bigint),
      "lifecycleAt"=now()+interval '45 seconds' WHERE "runId"=$1`, [runId, nextRunId])
    await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [machine.deviceId])
    await runChanged(client, runId)
    armDueTimerAfterCommit(client, 'run-recovery')
    return true
}

export async function retainThreadMachineForHandoff(pool: Pool, actor: Actor, runId: string, nextRunId: string, existing?: PoolClient): Promise<boolean> {
  const client = existing ?? await pool.connect()
  try {
    if (!existing) await client.query('BEGIN')
    const retained = await retainThreadMachineForHandoffLocked(client, actor, runId, nextRunId)
    if (!existing) await client.query('COMMIT')
    return retained
  } catch (error) { if (!existing) await client.query('ROLLBACK'); throw error } finally { if (!existing) client.release() }
}

/**
 * A finished run of an open task keeps its sandbox for the task's next run:
 * paused, which E2B neither bills nor expires (docs.e2b.dev/faq/calculate-sandbox-price:
 * "Paused and killed sandboxes are not billed."; docs.e2b.dev/sandbox/persistence:
 * "A paused sandbox is kept indefinitely."). Its worker's tokens are revoked;
 * a resume mints new ones. A refused pause (503, the sandbox keeps running)
 * throws, and the lifecycle tries again on its next tick.
 */
export async function parkThreadMachine(pool: Pool, actor: Actor, runId: string,
  pause: (sandboxId: string) => Promise<unknown> = sandboxId => withE2BErrors(actor.userId, false, async () => Sandbox.pause(sandboxId, { ...await options(actor.userId), requestTimeoutMs: 15_000 })),
  // Connecting solely to fetch logs can resume an already paused machine.
  // Keep the uploaded run/checkpoint evidence and any previously saved tail.
  readTail: (sandboxId: string) => Promise<string | null> = async () => null,
  existing?: PoolClient, expectedFence?: ThreadMachineFence) {
  const client = existing ?? await pool.connect()
  let intent: { sandboxId: string; epoch: number; failures: number } | undefined
  const locked = async () => {
    const run = (await client.query('SELECT status,"leaseExpiresAt","stopRequestedAt","stopReason","startedAt","sessionId","deviceTokenId","pauseReason",report FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
    const machine = (await client.query(`SELECT "sandboxId","deviceId","issueId","computeSeconds",state,epoch,"workerLeaseUntil",lifecycle,
        "snapshotState","snapshotOperationId","filesystemSnapshotId"
      FROM thread_machines
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE`, [runId, actor.userId, actor.workspaceId])).rows[0]
    if (!machine?.sandboxId || machine.state === 'ended') return null
    if (expectedFence && (machine.epoch !== expectedFence.epoch || machine.sandboxId !== expectedFence.sandboxId)) return null
    // A status alone is not a safe point. A live claim or bootstrap remains
    // responsible for commands and checkpoint upload until it acknowledges end.
    const terminal = ['succeeded', 'failed', 'stopped', 'cancelled'].includes(run?.status)
    const quotaWait = run?.status === 'paused' && run.pauseReason === 'quota_exhausted' && run.report?.safePoint?.session === 'exited' &&
      (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= Date.now())
    const stopExpired = expectedFence?.suspendAfterStop === true && run?.stopRequestedAt && new Date(run.stopRequestedAt).getTime() + 30_000 <= Date.now()
    if ((!terminal && !quotaWait && !stopExpired && (run?.status !== 'queued' || (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > Date.now()))) ||
      (!stopExpired && machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now()))
      throw new ComputerError(409, 'Only an idle unclaimed thread can pause; an active run keeps its lease')
    // Forced suspension freezes the whole VM, including an unacknowledged
    // native process. A host-only terminal transition must never unfreeze it.
    const hostEndedNative = run?.stopReason === 'device_lost' && (run.startedAt != null || run.sessionId != null || run.deviceTokenId != null)
    return { ...machine, requiresNativeExit: Boolean(stopExpired || run?.stopRequestedAt || hostEndedNative) || machine.lifecycle?.requiresNativeExit === true }
  }
  try {
    if (!existing) await client.query('BEGIN')
    let machine = await locked()
    if (!machine) { if (!existing) await client.query('COMMIT'); return }
    intent = { sandboxId: machine.sandboxId, epoch: machine.epoch, failures: Number(machine.lifecycle?.failures) || 0 }
    // A previous attempt may have created the snapshot before its response was
    // lost. Reconcile even on an already paused row, without connecting.
    if (threadSnapshotsEnabled() && machine.snapshotState === 'creating' && !machine.requiresNativeExit)
      await reconcileCreatingSnapshot(client, actor, runId, machine)
    if (machine.state !== 'paused') {
      await client.query(`UPDATE thread_machines SET lifecycle=lifecycle||jsonb_build_object('phase','pause_requested','owner','run-recovery')
          ||CASE WHEN $3::boolean THEN '{"requiresNativeExit":true}'::jsonb ELSE '{}'::jsonb END,
        "lifecycleAt"=now()+interval '30 seconds' WHERE "runId"=$1 AND epoch=$2`, [runId, intent.epoch, machine.requiresNativeExit])
      armDueTimerAfterCommit(client, 'run-recovery')
      if (!existing) {
        // The image must never capture a live worker credential. Revoke this
        // stage's token before the snapshot exists; a resumed machine mints a
        // new one during registration. The parked write repeats it idempotently.
        await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [machine.deviceId])
        // Commit the intent before provider I/O, then recheck the same owner.
        // A crash after E2B pauses is reconciled by the durable timer.
        await client.query('COMMIT')
        logThreadLifecycle({ runId, issueId: machine.issueId, ...intent }, { phase: 'pause_requested', provider: 'not_observed', deadline: Date.now()+30_000, computeSeconds: machine.computeSeconds })
        await client.query('BEGIN')
        machine = await locked()
        if (!machine || machine.sandboxId !== intent.sandboxId || machine.epoch !== intent.epoch) {
          await client.query('COMMIT'); return
        }
      }
      if (machine.state !== 'paused') {
        const tail = await readTail(machine.sandboxId)
        if (tail) await saveWorkerTail(client, runId, tail, await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })).catch(() => undefined)
        // Snapshot before pausing. E2B pauses the sandbox while it creates the
        // image; the pause below is then idempotent. Never snapshot a machine
        // whose native process has not acknowledged exit, and never inside a
        // caller-owned transaction (the image can take longer than its budget).
        if (!existing && threadSnapshotsEnabled() && !machine.requiresNativeExit)
          await takeThreadSnapshot(client, actor, runId, machine)
        await pause(machine.sandboxId)
      }
    }
    // An already paused provider/row still needs token revocation after a lost
    // response. Both the run and machine stay locked through this commit.
    const parked = await client.query(`UPDATE thread_machines SET state='paused',"lastActiveAt"=now(),
      "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),"runningSince"=NULL,
      "workerLeaseId"=NULL,"workerLeaseUntil"=NULL,
      lifecycle=lifecycle||jsonb_build_object('phase','paused','owner','run-recovery','failures',0,'pausedAt',COALESCE(lifecycle->'pausedAt',to_jsonb(floor(extract(epoch FROM clock_timestamp())*1000)::bigint)))
        ||CASE WHEN $4::boolean THEN '{"requiresNativeExit":true}'::jsonb ELSE '{}'::jsonb END,
      "lifecycleAt"=COALESCE(to_timestamp((lifecycle->>'pausedAt')::double precision/1000),now())+interval '7 days'
      WHERE "runId"=$1 AND "sandboxId"=$2 AND epoch=$3 AND state<>'ended' RETURNING "computeSeconds","lifecycleAt"`, [runId, intent.sandboxId, intent.epoch, machine.requiresNativeExit])
    if (parked.rowCount) taskActivityChanged(client, runId)
    await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [machine.deviceId])
    await runChanged(client, runId)
    armDueTimerAfterCommit(client, 'run-recovery')
    const reportPause = () => {
      if (parked.rowCount) logThreadLifecycle({ runId, issueId: machine.issueId, ...intent! }, { phase: 'paused', provider: 'pause_ack', deadline: new Date(parked.rows[0].lifecycleAt).getTime(), computeSeconds: parked.rows[0].computeSeconds })
    }
    if (!existing) { await client.query('COMMIT'); reportPause() }
    else {
      try { afterDatabaseCommit(client, `thread-machine-park:${runId}`, reportPause) } catch { /* Fixtures without commit observation do not emit a success receipt. */ }
    }
  } catch (error) {
    if (!existing) {
      await client.query('ROLLBACK')
      if (intent) {
        const failures = Math.min(intent.failures + 1, 16), delay = Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6))
        const failed = await client.query(`UPDATE thread_machines SET lifecycle=lifecycle||jsonb_build_object('phase','pause_failed','owner','run-recovery','failures',$4::int),
          "lifecycleAt"=now()+$5::double precision*interval '1 millisecond'
          WHERE "runId"=$1 AND "sandboxId"=$2 AND epoch=$3 AND state NOT IN ('ended','paused') RETURNING "issueId","computeSeconds"`, [runId, intent.sandboxId, intent.epoch, failures, delay])
          .catch(() => { /* The committed pause intent remains due if the DB is unavailable. */ })
        if (failed?.rowCount) logThreadLifecycle({ runId, issueId: failed.rows[0].issueId, ...intent }, { phase: 'pause_failed', reason: 'operation_failed', provider: 'unavailable', deadline: Date.now()+delay, computeSeconds: failed.rows[0].computeSeconds })
        armDueTimerSoon('run-recovery')
      }
    }
    throw error
  } finally { if (!existing) client.release() }
}

/** The worker's last output, saved before a kill; never throws, never waits past readWorkerTail's timeout. */
export async function keepTailBeforeKill(pool: Pick<Pool, 'query'>, actor: Actor, runId: string, sandboxId: string, readTail: (sandboxId: string) => Promise<string | null> = async () => null) {
  try { await saveWorkerTail(pool, runId, await readTail(sandboxId), await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })) } catch { /* the kill goes ahead */ }
}

/** Closed, duplicate or deleted tasks give up their paused sandboxes for good (kill, device retired). */
export async function endClosedTaskMachines(pool: Pool, end: (actor: Actor, runId: string) => Promise<unknown> = (actor, runId) => threadMachineAction(pool, actor, runId, 'end')) {
  const { rows } = await pool.query(`SELECT m."runId",m."ownerId",m."workspaceId" FROM thread_machines m
    LEFT JOIN issues i ON i.id=m."issueId"
    WHERE m.state='paused' AND m."issueId" IS NOT NULL
      AND (i.id IS NULL OR i.status IN ('done','canceled','duplicate') OR i.content->'attrs'->'mikka'->>'deletedAt' IS NOT NULL)
    LIMIT 50`)
  let ended = 0
  for (const row of rows) {
    try { await end({ userId: row.ownerId, workspaceId: row.workspaceId }, row.runId); ended++ } catch { /* retried on the next sweep */ }
  }
  return { ended, pending: rows.length - ended }
}

const threadDesktop = { startDesktop, syncDesktopLease }
/** Display :1 and its driver lease, published under the workspace policy lock so a
 * concurrent policy change (ComputerStore.setPolicy) cannot be overwritten with an older version.
 * No person can watch or take over a thread desktop (decision 1050): the lease is never controlled. */
async function startThreadDesktop(pool: Pool, actor: Actor, runId: string, leaseId: string, sandbox: Sandbox, runtime: typeof threadDesktop, budget?: RuntimeBudget) {
  await runtime.startDesktop(sandbox, 1, true, budget)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const machine = (await client.query('SELECT "botId",epoch FROM thread_machines WHERE "runId"=$1 AND "workerLeaseId"=$2 AND state<>\'ended\'', [runId, leaseId])).rows[0]
    if (!machine) throw new ComputerError(409, 'Thread provisioning cancelled')
    const policy = (await client.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [actor.workspaceId])).rows[0]
    const policyVersion = Number(policy?.version ?? 0)
    await runtime.syncDesktopLease(sandbox, { botId: machine.botId, ownerId: actor.userId, display: 1, epoch: machine.epoch, controlledBy: null, controlUntil: 0, computerAllowed: computerPermission(policy?.permission) === 'allow', policyVersion }, budget)
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

type QuestionRuntimeUpgrade = { taskId: string; attemptId: string; requestEpoch: string; stage: string; candidateId: string | null; receiptId: string; receiptDigest: string }

/** Maintenance uses the existing answer/recovery receipt for every stage. Lock
 * the task/question before the run, matching answer, claim and cancellation. */
async function lockQuestionRuntimeUpgrade(tx: PoolClient, actor: Actor, runId: string, questionId: string, expected?: QuestionRuntimeUpgrade): Promise<QuestionRuntimeUpgrade> {
  const unavailable = (): never => { throw new ComputerError(409, 'Original question runtime is no longer current') }
  const { rows: [identity] } = await tx.query('SELECT "taskId" FROM factory_questions WHERE id=$1 AND "userId"=$2 AND "continuationRunId"=$3', [questionId, actor.userId, runId])
  if (!identity) return unavailable()
  const { rows: [task] } = await tx.query('SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE', [identity.taskId, actor.userId])
  if (!task || task.status !== 'running') return unavailable()
  const { rows } = await tx.query(`SELECT to_jsonb(q) AS question,to_jsonb(r) AS run,to_jsonb(origin.*) AS origin,e."eventId",e.request,e.result
    FROM factory_questions q
    JOIN factory_attempts a ON a.id=$4 AND a."taskId"=q."taskId" AND a.stage=$5 AND a.status='running'
    JOIN agent_runs r ON r.id=a."runId" AND r.id=q."continuationRunId" AND r."userId"=q."userId" AND r."issueId"=q."issueId"
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId" AND b."workspaceId"=$7
    JOIN agent_runs origin ON origin.id=q."originRunId" AND origin."userId"=q."userId" AND origin."issueId"=q."issueId"
    JOIN factory_events e ON e."taskId"=q."taskId" AND e.request->>'kind' IN ('question_resume','question_recover') AND e.result->>'continuationRunId'=r.id::text
    WHERE q.id=$1 AND q."userId"=$2 AND q."taskId"=$3 AND q.stage=$5 AND q.status='resuming'
      AND q."candidateId" IS NOT DISTINCT FROM $6::uuid AND a."candidateId" IS NOT DISTINCT FROM $6::uuid
      AND (q."expiresAt" IS NULL OR q."expiresAt">clock_timestamp()) AND q."answerId" IS NOT NULL
      AND r.id=$8 AND r.status='queued' AND r."startedAt" IS NULL AND r."sessionId" IS NULL AND r."stopRequestedAt" IS NULL
      AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=clock_timestamp())
      AND r."questionContinuation"->>'questionId'=q.id::text AND r."questionContinuation"->>'requireSessionResume'='true'
      AND r."questionContinuation"->>'originRunId'=origin.id::text AND r."questionContinuation"->>'originSessionId'=q."originSessionId"
      AND origin.status='stopped' AND origin."stopRequestedAt" IS NULL AND origin."sessionId"=q."originSessionId"
      AND origin."deviceId"=r."deviceId" AND origin."deviceRepoId"=r."deviceRepoId" AND origin."agentId"=r."agentId"
    FOR SHARE OF q,a,origin,e`, [questionId, actor.userId, task.id, task.attemptId, task.stage, task.candidateId, actor.workspaceId, runId])
  if (rows.length !== 1) return unavailable()
  const { question: q, run, origin, eventId, request, result } = rows[0], saved = result?.task
  if (!q.answer || q.answer.userId !== actor.userId || q.answer.source !== q.answerSource ||
    questionFingerprint(q.answer) !== q.answerFingerprint || request?.userId !== actor.userId ||
    result?.questionId !== q.id || result.originRunId !== origin.id || result.originSessionId !== q.originSessionId ||
    result.continuationRunId !== runId || !saved || saved.id !== task.id || saved.userId !== task.userId ||
    saved.issueId !== task.issueId || saved.botId !== task.botId || saved.sourceEventId !== task.sourceEventId ||
    saved.attemptId !== task.attemptId || saved.stage !== task.stage || saved.status !== 'running' || saved.candidateId !== task.candidateId ||
    !run.agentDefinition?.definitionDigest || run.baseBranch !== origin.baseBranch ||
    ['definitionDigest', 'harness', 'model', 'subscription', 'apiKey', 'executionIdentity'].some(key =>
      !isDeepStrictEqual(run.agentDefinition[key], origin.agentDefinition?.[key]))) return unavailable()
  if (request.kind === 'question_resume') {
    if (eventId !== factoryEventId('question-resume', q.answerId) || request.source !== q.answerSource ||
      !isDeepStrictEqual(request.input, q.answer.input) || result.answerId !== q.answerId ||
      result.answerFingerprint !== q.answerFingerprint || result.originAttemptId !== q.attemptId) return unavailable()
  } else {
    const input = request.input, reference = input?.reference
    if (!input?.requestId || eventId !== factoryEventId('question-recover', input.requestId) ||
      result.historyRunId !== run.continuesRunId || input.expectedFailedRunId !== run.continuesRunId ||
      reference?.questionId !== q.id || reference.originRunId !== origin.id || reference.originSessionId !== q.originSessionId ||
      reference.binding?.taskId !== task.id || reference.binding.issueId !== task.issueId || reference.binding.candidateId !== task.candidateId) return unavailable()
  }
  const current = { taskId: task.id, attemptId: task.attemptId, requestEpoch: task.sourceEventId, stage: task.stage,
    candidateId: task.candidateId, receiptId: eventId, receiptDigest: questionFingerprint({ request, result }) }
  if (expected && !isDeepStrictEqual(current, expected)) return unavailable()
  return current
}

type UnclaimedQuestionRuntimeRecovery = {
  taskId: string; taskRevision: number; requestEpoch: string; questionRevision: number
  answerFingerprint: string; receiptDigest: string
  continuation: NonNullable<Awaited<ReturnType<typeof unclaimedPlanQuestionContinuation>>>
}

/** A failed claim owns the retained VM, but never acquired a native SID. The
 * same immutable spec receipt used by recovery is the only authority to
 * maintain that VM. Lock task/question before run/machine, as settle does. */
async function lockUnclaimedQuestionRuntimeRecovery(client: PoolClient, actor: Actor, runId: string,
  expected?: UnclaimedQuestionRuntimeRecovery): Promise<UnclaimedQuestionRuntimeRecovery | null> {
  const unavailable = (): null => {
    if (expected) throw new ComputerError(409, 'Original question runtime is no longer current')
    return null
  }
  const { rows: [task] } = await client.query<FactoryTask>(`SELECT t.* FROM factory_tasks t
    JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id AND a.stage='spec' AND a.status='blocked' AND a."candidateId" IS NULL
    JOIN agent_runs r ON r.id=a."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN factory_questions q ON q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId"
      AND q.id::text=r."questionContinuation"->>'questionId' AND q."continuationRunId"=r.id
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=t."userId"
    WHERE r.id=$1 AND t."userId"=$2 AND b."workspaceId"=$3
      AND t.stage='spec' AND t.status='blocked' AND t."candidateId" IS NULL
      AND q.stage='spec' AND q.status='blocked' AND q."candidateId" IS NULL
      AND r.status='failed' AND r."sessionId" IS NULL AND r."startedAt" IS NULL
    FOR UPDATE OF t`, [runId, actor.userId, actor.workspaceId])
  if (!task) return unavailable()
  const { rows: [question] } = await client.query(`SELECT revision,"answerFingerprint",id FROM factory_questions
    WHERE "taskId"=$1 AND "userId"=$2 AND "continuationRunId"=$3 AND stage='spec' AND status='blocked'
      AND "candidateId" IS NULL FOR SHARE`, [task.id, actor.userId, runId])
  if (!question) return unavailable()
  const continuation = await unclaimedPlanQuestionContinuation(client, task, runId)
  if (!continuation || continuation.continuationAttemptId !== task.attemptId || continuation.questionId !== question.id) return unavailable()
  // A historical definition can predate executionIdentity. Keep this device
  // fence explicit, including the transaction that publishes new credentials.
  const device = await client.query(`SELECT 1 FROM devices d JOIN agent_runs r ON r."deviceId"=d.id AND r."userId"=d."ownerId"
    WHERE r.id=$1 AND d."ownerId"=$2 AND d.kind='cloud' AND d.enabled=true FOR SHARE OF d`, [runId, actor.userId])
  if (!device.rowCount) return unavailable()
  const { rows: [receipt] } = await client.query('SELECT request,result FROM factory_events WHERE "taskId"=$1 AND "eventId"=$2 FOR SHARE',
    [task.id, continuation.recoveryEventId])
  if (!receipt) return unavailable()
  const current = { taskId: task.id, taskRevision: task.revision, requestEpoch: task.sourceEventId,
    questionRevision: question.revision, answerFingerprint: question.answerFingerprint,
    receiptDigest: questionFingerprint(receipt), continuation }
  if (expected && !isDeepStrictEqual(current, expected)) throw new ComputerError(409, 'Original question runtime is no longer current')
  return current
}

/** The queued run is moved to a dedicated device before any worker can claim
 * it. Bot workers are denied these runs by claimCloudRun. */
export async function ensureThreadMachine(...args: Parameters<typeof ensureThreadMachineInternal>) {
  const [pool, actor, runId] = args
  z.uuid().parse(runId)
  const { rows: [run] } = await pool.query<typeof agentRuns.$inferSelect>(`SELECT r.* FROM agent_runs r
    JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."workspaceId"=b."workspaceId"`, [runId, actor.userId, actor.workspaceId])
  if (!run) throw new ComputerError(404, 'Thread unavailable')
  // Admission precedes even retained-machine connect/refresh. A refusal must
  // not acquire provisioning custody, rewrite its timer, or disturb an old VM.
  return withRunProjectResources(pool, run, async () => {
    let resourceRefused = false
    try {
      return await cloudStartupSpan('cloud.thread.ensure', cloudStartupRunAttributes(args[2]), () => ensureThreadMachineInternal(...args))
    } catch (error) {
      resourceRefused = isProjectExecutionRefusal(error)
      throw error
    } finally {
      // Every admitted wake, including resume/replay/retained-stage adoption,
      // leaves the existing durable timer responsible if its request disappears.
      // The provisioning transaction already stored a deadline before E2B I/O.
      if (!resourceRefused) {
        await pool.query(`UPDATE thread_machines SET "lifecycleAt"=now()
          WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3
            AND (state<>'ended' OR "sandboxId" IS NOT NULL OR "workerLeaseUntil" IS NOT NULL)`, [runId, actor.userId, actor.workspaceId])
          .catch(() => { /* The previous durable deadline and recovery sweep remain. */ })
        armDueTimerSoon('run-recovery')
      }
    }
  })
}

async function ensureThreadMachineInternal(pool: Pool, actor: Actor, runId: string, provider: typeof threadMachineProvider & { state?: (sandboxId: string, ownerId: string, budget?: RuntimeBudget) => Promise<string> } = threadMachineProvider, desktop = threadDesktop, refreshRuntime = false) {
  z.uuid().parse(runId)
  let refreshDeadline = refreshRuntime ? Date.now() + 240_000 : undefined
  const budgetUntil = (deadline: number): RuntimeBudget => maximumMs => {
    const remaining = Math.min(maximumMs, deadline - Date.now())
    if (remaining <= 0) throw new ComputerError(503, 'Task runtime refresh timed out')
    return remaining
  }
  let refreshBudget = refreshDeadline ? budgetUntil(refreshDeadline) : undefined
  const client = await pool.connect()
  const leaseId = randomUUID()
  const timings = cloudStartupPhases(cloudStartupRunAttributes(runId))
  let refreshPhase: RuntimeRefreshPhase = timings.next('admission')
  let parallelFailurePhase: RuntimeRefreshPhase | undefined
  let exactQuestionMachine = false
  let retainedSandboxId: string | undefined
  let upgradeRetainedRuntime = false
  let questionRuntimeUpgrade: QuestionRuntimeUpgrade | undefined
  let unclaimedQuestionRecovery: UnclaimedQuestionRuntimeRecovery | null = null
  let unclaimedRuntimeSwitchStarted = false
  let reservedStartLease = false
  let runtimeRollback: (() => Promise<void>) | undefined
  let verifyRefreshedRuntime: (() => Promise<unknown>) | undefined
  let workerBroker: WorkerBootstrapBroker | undefined
  try {
    await client.query('BEGIN')
    if (refreshBudget) await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${refreshBudget(5_000)}ms`])
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-machine:${runId}`])
    // Different runs of one task must serialize the choice to adopt/create,
    // even if both admitted requests arrive before either records a sandbox.
    const taskOwner = (await client.query('SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, actor.userId])).rows[0]
    if (taskOwner?.issueId) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`thread-task-machine:${actor.userId}:${actor.workspaceId}:${taskOwner.issueId}`])
    // Recovery takes policy before question/run locks. Acquire its order while
    // reserving maintenance so a blocked continuation cannot transfer custody.
    if (refreshRuntime) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      unclaimedQuestionRecovery = await lockUnclaimedQuestionRuntimeRecovery(client, actor, runId)
    }
    const run = (await client.query(`SELECT r.*${refreshRuntime ? ',r."stopRequestedAt"::text AS "registrationStopRequestedAt"' : ''},r."baseBranch" AS "runBaseBranch",COALESCE(r."agentDefinition"->>'harness',agent.harness) AS "runHarness",b."workspaceId",b."botId" AS "runtimeBotId",repo."repoPath",repo."remoteUrl",repo."baseBranch",repo."verifyCommand"
      FROM agent_runs r JOIN computer_run_bindings b ON b."runId"=r.id AND b."ownerId"=r."userId"
      LEFT JOIN agents agent ON agent.id=r."agentId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
      JOIN cloud_machines m ON m."workspaceId"=b."workspaceId" AND m."ownerId"=b."ownerId"
      WHERE r.id=$1 AND r."userId"=$2 AND b."workspaceId"=$3 AND r."workspaceId"=b."workspaceId" FOR UPDATE OF r FOR SHARE OF repo`, [runId, actor.userId, actor.workspaceId])).rows[0]
    if (!run || !(refreshRuntime ? ['succeeded','failed','stopped','cancelled'] : ['queued', 'preparing', 'running', 'waiting_input']).includes(run.status)) throw new ComputerError(404, 'Thread unavailable')
    // The public preflight can precede a placement change. Recheck the locked
    // Run/target on this APP executor, borrowing its already-held WS lease.
    await assertRunProjectResources(client, { ...run, baseBranch: run.runBaseBranch })
    return await withRunSpan('cloud.thread.provision', { ...cloudStartupRunAttributes(runId), 'mikka.run_id': runId }, async () => {
    if (!refreshRuntime) {
      refreshPhase = timings.next('execution_identity')
      await revalidateExecutionIdentity(client, run)
      refreshPhase = timings.next('admission')
    }

    exactQuestionMachine = run.questionContinuation?.requireSessionResume === true
    const repositoryTask = Boolean(run.remoteUrl)
    const freshTemplate = () => repositoryTask ? taskTemplate(run.runHarness) : computerTemplate()
    let machine = (await client.query('SELECT * FROM thread_machines WHERE "runId"=$1 FOR UPDATE', [runId])).rows[0]
    // Stop check 1 shares the explicit Stop path's native-history and lease
    // fence. A never-started bootstrap can end; an adopted task's filesystem
    // remains available even when this particular queued run never claimed.
    if (run.status === 'queued' && run.stopRequestedAt) {
      if (exactQuestionMachine) throw new ComputerError(409, 'Thread stopped')
      if (!await canAcknowledgeQueuedThreadStop(client, actor, run, machine)) throw new ComputerError(409, 'Task runtime is busy')
      const stale = await endStopRequestedRun(client, actor, runId)
      await afterRunEnded(actor.userId, runId)
      if (stale) {
        await provider.kill(stale, actor.userId)
        await recordCancelledThreadSessionEnd(pool, { runId, ownerId: actor.userId, workspaceId: actor.workspaceId, sandboxId: stale, operationId: machine.operationId })
      }
      throw new ComputerError(409, 'Thread stopped')
    }
    // connect resumes provider-paused native execution before local worker
    // maintenance can inspect its journal. Require the daemon's exit receipt first.
    if (machine?.sandboxId && (machine.lifecycle?.requiresNativeExit === true || run.stopRequestedAt ||
      (run.stopReason === 'device_lost' && (run.startedAt != null || run.sessionId != null || run.deviceTokenId != null))) && run.report?.safePoint?.session !== 'exited')
      throw new ComputerError(409, 'Task runtime is busy')
    if (!refreshRuntime && !exactQuestionMachine && run.issueId && machine?.sandboxId && machine.deviceId &&
      machine.ownerId === actor.userId && machine.workspaceId === actor.workspaceId && machine.issueId === run.issueId &&
      (['paused','error'].includes(machine.state) || (machine.state === 'running' && run.status === 'queued'))) retainedSandboxId = machine.sandboxId
    if (exactQuestionMachine && run.stopRequestedAt) throw new ComputerError(409, 'Thread stopped')
    if (retainedSandboxId && !refreshRuntime && (run.status !== 'queued' || run.stopRequestedAt)) throw new ComputerError(409, 'Retained task runtime is not queued')
    if (repositoryTask && !repositoryBindingMatches(run.repoPath, run.remoteUrl)) throw new ComputerError(409, 'Repository identity unavailable')
    if (exactQuestionMachine) {
      refreshPhase = timings.next('question_machine')
      const continuation = run.questionContinuation
      if (!continuation?.requireSessionResume || typeof continuation.requiredSandboxId !== 'string' ||
        !machine?.sandboxId || machine.sandboxId !== continuation.requiredSandboxId ||
        machine.ownerId !== actor.userId || machine.workspaceId !== actor.workspaceId ||
        machine.deviceId !== run.deviceId || machine.repoId !== run.deviceRepoId || machine.issueId !== run.issueId ||
        machine.botId !== run.runtimeBotId) throw new ComputerError(409, 'Original question machine unavailable')
      if (refreshRuntime && (run.status !== 'failed' || (run.sessionId !== continuation.originSessionId &&
        !(run.sessionId === null && unclaimedQuestionRecovery)))) throw new ComputerError(409, 'Original question machine unavailable')
      refreshPhase = timings.next('question_source')
      const source = await client.query(`SELECT 1 FROM factory_questions q
        JOIN agent_runs origin ON origin.id=q."originRunId" AND origin."userId"=q."userId" AND origin."issueId"=q."issueId"
        JOIN computer_run_bindings b ON b."runId"=origin.id AND b."ownerId"=origin."userId"
        JOIN thread_machines m ON m."runId"=origin.id AND m."ownerId"=b."ownerId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId"
        WHERE q.id=$1 AND q."userId"=$2 AND q."continuationRunId"=$3
          AND q.status=CASE WHEN $13::boolean THEN 'blocked' ELSE 'resuming' END
          AND q."originRunId"=$4 AND q."originSessionId"=$5 AND origin."sessionId"=$5
          AND origin.status='stopped' AND origin."agentId"=$6 AND origin."deviceId"=$7 AND origin."deviceRepoId"=$8
          AND b."workspaceId"=$9 AND b."botId"=$10 AND m.state='ended' AND m."sandboxId" IS NULL
          AND m."deviceId"=$7 AND m."repoId"=$8 AND m."issueId"=$11 AND m."snapshotId"=$12
          AND (NOT $13::boolean OR EXISTS (SELECT 1 FROM factory_tasks t
            JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
            WHERE t.id=q."taskId" AND t."userId"=q."userId" AND t."issueId"=q."issueId" AND t.status='blocked'
              AND a."runId"=$3 AND t."candidateId" IS NOT DISTINCT FROM q."candidateId"))
        FOR SHARE OF q,origin,b,m`, [continuation.questionId,actor.userId,runId,continuation.originRunId,continuation.originSessionId,
        run.agentId,run.deviceId,run.deviceRepoId,actor.workspaceId,run.runtimeBotId,run.issueId,machine.snapshotId,refreshRuntime])
      if (!source.rowCount) throw new ComputerError(409, 'Original question machine unavailable')
      refreshPhase = timings.next('question_machine')
      // A live worker may have claimed between answer commit and this wake.
      // Its lease, credentials and native process must remain untouched.
      if (['preparing','running','waiting_input'].includes(run.status) && run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime()>Date.now()) {
        await client.query('COMMIT'); return { runId, state: 'running' }
      }
      if (machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime()>Date.now()) throw new ComputerError(409,'Thread provisioning in progress')
    }
    refreshPhase = timings.next('admission')
    if (refreshRuntime && (!machine?.sandboxId || !machine.deviceId || !threadMachineTemplateKind(machine))) throw new ComputerError(409, 'Existing official task runtime required')
    if (refreshRuntime) {
      if (machine.ownerId!==actor.userId || machine.workspaceId!==actor.workspaceId || machine.deviceId!==run.deviceId) throw new ComputerError(404,'Thread unavailable')
      const idle = await client.query(`SELECT 1 FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='cloud' AND d.enabled=true
        AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r."deviceId"=d.id AND r.status NOT IN ('succeeded','failed','stopped','cancelled'))`,[machine.deviceId,actor.userId])
      if (!idle.rowCount) throw new ComputerError(409,'Task runtime is busy')
    }
    if (refreshRuntime && machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now()) throw new ComputerError(409, 'Thread provisioning in progress')
    if (machine?.state === 'ended') throw new ComputerError(409, 'Thread ended')
    if (!exactQuestionMachine && !retainedSandboxId && machine?.state === 'running' && machine.sandboxId) {
      refreshPhase = timings.next('provider_state')
      const base = await options(actor.userId)
      const state = await withE2BErrors(actor.userId, false, () => Sandbox.getInfo(machine.sandboxId, { ...base, ...runtimeRequestOptions(refreshBudget), ...(refreshBudget ? { retries: 0 } : {}) })).catch((error: unknown) => {
        if (sandboxGone(error)) return null
        throw error
      })
      refreshPhase = timings.next('admission')
      if (!state) machine = await replaceGoneSandbox(client, runId, freshTemplate())
      else if (state.state !== 'paused' && !refreshRuntime) {
        const current = await provider.connect(machine.sandboxId, actor.workspaceId)
        if ((await current.files.read('/opt/mikka/worker-source-sha', {user:'root'})).trim() !== process.env.MIKKA_CLOUD_WORKER_SHA) throw new ComputerError(409, 'Worker version mismatch; refresh the idle task runtime')
        await switchOfficialWorkerRelease(current,{sourceCommit:process.env.MIKKA_CLOUD_WORKER_SOURCE_COMMIT ?? '',workerSha:process.env.MIKKA_CLOUD_WORKER_SHA ?? '',previousSha:process.env.MIKKA_CLOUD_WORKER_SHA ?? ''},{deviceId:machine.deviceId,workspaceId:actor.workspaceId,operationId:leaseId},'verify')
        await client.query('COMMIT'); return { runId, state: 'running' }
      }
    }
    if (!exactQuestionMachine && !retainedSandboxId && machine?.state === 'running' && machine.sandboxId) {
      // The provider paused this sandbox on its own timeout. E2B stops billing
      // at pause, so persist the end of the running interval before resuming.
      await client.query(`UPDATE thread_machines SET "computeSeconds"="computeSeconds"+GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,"runningSince"=NULL,state='paused' WHERE "runId"=$1 AND "runningSince" IS NOT NULL`, [runId])
      taskActivityChanged(client, runId)
      machine.state = 'paused'
    }
    if (machine?.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now() && machine.state !== 'paused') throw new ComputerError(409, 'Thread provisioning in progress')
    // No Mikka caps: the person's own E2B account sets the limit (orchestration.md § 5).
    if (!machine || machine.snapshotId === 'pending' || (!machine.sandboxId && !cloudTemplateOrigin(machine.snapshotId))) {
      // A follow-up keeps this task's own machine. A new repository task starts
      // from the anonymous ready template of its harness (E2B's claude or codex
      // with Mikka's worker, decision 2026-11-01-2335): the daemon clones its admitted
      // remote and creates the task worktree from the configured base branch.
      // Non-repository work starts from the official desktop template too.
      const template = freshTemplate()
      const adopted = run.issueId ? await adoptTaskMachine(client, actor, runId, run, template) : null
      if (adopted) { machine = adopted; retainedSandboxId = adopted.sandboxId }
      else {
        if (run.issueId) {
          const busy = await client.query(`SELECT 1 FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
            WHERE m."issueId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."runId"<>$4
              AND (m.state IN ('starting','running','error') OR (m.state='paused' AND (r.status NOT IN ('succeeded','failed','stopped','cancelled')
                OR ${unconfirmedNativeExitSql})))
              AND (m."sandboxId" IS NOT NULL OR m."workerLeaseUntil">now()) LIMIT 1`, [run.issueId, actor.userId, actor.workspaceId, runId])
          if (busy.rowCount) throw new ComputerError(409, 'Thread provisioning in progress')
        }
        machine = (await client.query(`INSERT INTO thread_machines ("runId","workspaceId","ownerId","botId","issueId","snapshotId","operationId",state,"templateKind")
          VALUES ($1,$2,$3,$4,$5,$6,$7,'starting',$8) ON CONFLICT ("runId") DO UPDATE SET "snapshotId"=EXCLUDED."snapshotId","templateKind"=EXCLUDED."templateKind","issueId"=EXCLUDED."issueId" RETURNING *`, [runId, actor.workspaceId, actor.userId, run.runtimeBotId, run.issueId ?? null, template, randomUUID(), cloudTemplateOrigin(template)?.kind ?? null])).rows[0]
      }
    }
    if (retainedSandboxId && !refreshRuntime) {
      // Adoption is host-owned and remains fenced before any provider I/O.
      // A replay may reuse its own queued run, never another active executor.
      if (run.status !== 'queued' || run.stopRequestedAt || (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > Date.now()) ||
        (machine.workerLeaseUntil && new Date(machine.workerLeaseUntil).getTime() > Date.now()))
        throw new ComputerError(409, 'Retained task runtime is busy')
      const idle = await client.query(`SELECT 1 FROM devices d WHERE d.id=$1 AND d."ownerId"=$2 AND d.kind='cloud' AND d.enabled=true
        AND NOT EXISTS(SELECT 1 FROM agent_runs active WHERE active."deviceId"=d.id AND active.id<>$3
          AND active.status NOT IN ('succeeded','failed','stopped','cancelled'))`, [machine.deviceId, actor.userId, runId])
      if (!idle.rowCount) throw new ComputerError(409, 'Retained task runtime is busy')
      refreshDeadline = Date.now() + 240_000
      refreshBudget = budgetUntil(refreshDeadline)
    }
    // Persist the official template and operation ID before provider requests.
    await client.query(`UPDATE thread_machines SET "workerLeaseId"=$2,"workerLeaseUntil"=now()+interval '15 minutes',epoch=epoch+1,"lifecycleAt"=now(),
      lifecycle=(lifecycle-'pausedAt')||jsonb_build_object('phase',CASE WHEN "sandboxId" IS NULL THEN 'create_requested' ELSE 'resume_requested' END,'owner','run-recovery','failures',0),
      state=CASE WHEN $3::boolean AND state='running' THEN 'error' ELSE state END WHERE "runId"=$1`, [runId, leaseId, Boolean(retainedSandboxId)])
    armDueTimerAfterCommit(client, 'run-recovery')
    await client.query('COMMIT')
    reservedStartLease = true
    if (exactQuestionMachine) {
      // Provider I/O happens after the lease transaction. A running original VM
      // already has its worker; only a paused VM needs bootstrap after connect.
      refreshPhase = timings.next('provider_state')
      const state = provider.state ? await provider.state(machine.sandboxId, actor.userId, refreshBudget) :
        (await withE2BErrors(actor.userId, false, async () => Sandbox.getInfo(machine.sandboxId, { ...await options(actor.userId), ...runtimeRequestOptions(refreshBudget), ...(refreshBudget ? { retries: 0 } : {}) }))).state
      if (state !== 'running' && state !== 'paused') throw new ComputerError(409,'Original question machine unavailable')
      if (state === 'running' && machine.state === 'running' && !refreshRuntime) {
        await pool.query('UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "workerLeaseId"=$2',[runId,leaseId])
        return { runId, state: 'running' }
      }
    }
    refreshPhase = timings.next('connect')
    let connected = machine.sandboxId ? await provider.connect(machine.sandboxId, actor.workspaceId, refreshBudget).catch((error: unknown) => {
      if (sandboxGone(error)) return null
      throw error
    }) : null
    if (exactQuestionMachine && (!connected || connected.sandboxId !== machine.sandboxId)) throw new ComputerError(409, 'Original question machine unavailable')
    if (refreshRuntime && !connected) throw new ComputerError(409, 'Original task machine unavailable')
    // A resumed or adopted VM now holds newer state than its parked image. Mark
    // the image stale so the next park takes a fresh one; keep the reference
    // for cleanup. The image still serves a restore if the VM disappears before
    // this connection succeeded.
    if (connected && !refreshRuntime && !exactQuestionMachine && machine.snapshotState === 'ready')
      await pool.query(`UPDATE thread_machines SET "snapshotState"='failed'
        WHERE "runId"=$1 AND "sandboxId"=$2 AND "snapshotState"='ready' AND state<>'ended'`, [runId, machine.sandboxId])
    // The provider lost this task's VM. Prefer its own filesystem snapshot over
    // the official template; the restore helper re-fences the same task, owner,
    // workspace, repository and template kind before any provider I/O.
    const restoreCandidate = !refreshRuntime && !exactQuestionMachine && threadSnapshotsEnabled() &&
      machine.snapshotState === 'ready' && Boolean(machine.filesystemSnapshotId) &&
      (machine.sandboxId ? !connected : ['restore', 'error'].includes(machine.state))
    let restored: Awaited<ReturnType<typeof restoreThreadMachineFromSnapshot>> = null
    if (restoreCandidate) {
      refreshDeadline = Date.now() + 240_000
      refreshBudget = budgetUntil(refreshDeadline)
      const restoreTemplate = freshTemplate()
      const restoreKind = cloudTemplateOrigin(restoreTemplate)?.kind
        ?? (run.remoteUrl ? (run.runHarness === 'claude_code' ? 'claude' : 'codex') : 'desktop')
      restored = await restoreThreadMachineFromSnapshot(pool, actor, runId, leaseId,
        { sandboxId: machine.sandboxId ?? null, kind: restoreKind }, restoreTemplate, provider)
    }
    if (retainedSandboxId && (!connected || connected.sandboxId !== retainedSandboxId) && !restored)
      throw new ComputerError(409, 'Retained task machine unavailable')
    if (machine.sandboxId && !connected && !restored) {
      // No usable snapshot: recreate this thread from its official template.
      machine = await replaceGoneSandbox(pool, runId, freshTemplate(), leaseId)
      if (!machine) throw new ComputerError(409, 'Thread provisioning cancelled')
    }
    if (restored) machine = restored.machine
    const anonymousFreshMachine = !connected && !restored && !machine.sandboxId && !machine.deviceId && ['claude', 'codex'].includes(cloudTemplateOrigin(machine.snapshotId)?.kind ?? '')
    const sandbox = restored?.sandbox ?? connected ?? await provider.create(machine.snapshotId, machine.operationId, { application: 'mikka-thread', workspaceId: actor.workspaceId, runId, operationId: machine.operationId }, actor.userId)
    connected = null
    refreshPhase = timings.next('record_sandbox')
    const recorded = await recordThreadSandbox(pool, runId, sandbox.sandboxId, leaseId)
    if (!recorded) {
      // An end can win while Sandbox.create is in flight. The just-created
      // sandbox is not in the row end observed, so this worker must clean it up.
      if (!machine.sandboxId) {
        // Record it even after end so a failed kill remains retryable. A newer
        // lease may share the idempotent sandbox and must not have it killed.
        if (await recordCancelledSandbox(pool, runId, sandbox.sandboxId, machine.operationId)) {
          await provider.kill(sandbox.sandboxId, actor.userId)
          await recordCancelledThreadSessionEnd(pool, { runId, ownerId: actor.userId, workspaceId: actor.workspaceId, sandboxId: sandbox.sandboxId, operationId: machine.operationId })
        }
      }
      throw new ComputerError(409, 'Thread provisioning cancelled')
    }
    if (restored) {
      // The restored VM now holds the task's state; keep the retained-runtime
      // upgrade/failure paths fenced on this exact sandbox.
      machine.sandboxId = sandbox.sandboxId
      retainedSandboxId = sandbox.sandboxId
      // The source image is the state this VM started from, not its future
      // state. Mark it stale so the next park takes a fresh image and only
      // then deletes this one; the reference stays for cleanup if the row is
      // ended first.
      await pool.query(`UPDATE thread_machines SET "snapshotState"='failed'
        WHERE "runId"=$1 AND "sandboxId"=$2 AND state<>'ended'`, [runId, sandbox.sandboxId])
    }
    refreshPhase = timings.next('post_connect_admission')
    // Stop check 2: a stop may have landed while the first transaction was committed and the
    // sandbox was being created. Re-take the run lock and check again before the worker starts.
    await client.query('BEGIN')
    if (refreshBudget) await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${refreshBudget(5_000)}ms`])
    if (unclaimedQuestionRecovery) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      await lockUnclaimedQuestionRuntimeRecovery(client, actor, runId, unclaimedQuestionRecovery)
    }
    const again = (await client.query('SELECT status,"stopRequestedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
    if (exactQuestionMachine && again?.stopRequestedAt) throw new ComputerError(409, 'Thread stopped')
    if (retainedSandboxId && !refreshRuntime && (again?.status !== 'queued' || again.stopRequestedAt)) throw new ComputerError(409, 'Retained task runtime is no longer queued')
    if (again?.status === 'queued' && again.stopRequestedAt) {
      const stale = await endStopRequestedRun(client, actor, runId)
      await afterRunEnded(actor.userId, runId)
      if (stale) {
        await provider.kill(stale, actor.userId)
        await recordCancelledThreadSessionEnd(pool, { runId, ownerId: actor.userId, workspaceId: actor.workspaceId, sandboxId: stale, operationId: machine.operationId })
      }
      throw new ComputerError(409, 'Thread stopped')
    }
    await client.query('COMMIT')
    if (!machine.sandboxId && !repositoryTask && threadMachineTemplateKind(machine) && run.repoPath === botWorkspacePath(run.runtimeBotId)) {
      // A fresh official instance never inherits the parent Bot's files. Give
      // its registered private workspace a Git base before the daemon starts.
      await initializeBotWorkspace(sandbox, run.runtimeBotId)
    }
    refreshPhase = timings.next('runtime_configuration')
    const deviceId = machine.deviceId ?? randomUUID()
    const repoId = machine.repoId ?? randomUUID()
    const credential = `orv_${randomBytes(32).toString('base64url')}`
    const origin = new URL(process.env.MIKKA_CLOUD_WORKER_URL ?? '')
    if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error('Worker unavailable')
    const expectedSha = process.env.MIKKA_CLOUD_WORKER_SHA
    const handoff = `/run/mikka-viewer/thread-${leaseId}.json`
    const directory = '/home/user/.mikka/worker'
    const publish = `install -o user -g user -m 600 ${handoff} /home/user/.mikka/bootstrap.next && install -o user -g user -m 600 ${handoff}.run /home/user/.mikka/initial-run.next && mv /home/user/.mikka/initial-run.next /home/user/.mikka/initial-run.json && install -o user -g user -m 600 ${handoff}.claude /home/user/.mikka/anonymous-claude.next && mv /home/user/.mikka/anonymous-claude.next /home/user/.mikka/anonymous-claude.json && install -o user -g user -m 600 ${handoff}.codex /home/user/.mikka/anonymous-codex.next && mv /home/user/.mikka/anonymous-codex.next /home/user/.mikka/anonymous-codex.json && mv /home/user/.mikka/bootstrap.next /home/user/.mikka/bootstrap.json && unlink ${handoff} && unlink ${handoff}.run && unlink ${handoff}.claude && unlink ${handoff}.codex`
    let registrationWaiting = false, phaseOutput = ''
    const onRegistrationOutput = (chunk: string) => {
      phaseOutput = (phaseOutput + chunk).slice(-1024)
      if (!registrationWaiting && phaseOutput.includes(REGISTRATION_WAITING)) {
        registrationWaiting = true
        refreshPhase = timings.next('worker_register')
      }
    }
    // Version verification and viewer startup are independent. Hosted runs no
    // longer use Docker; never pull its obsolete image on the critical path.
    // A repository task's machine (claude or codex template) has no desktop.
    refreshPhase = timings.next('read_worker')
    const [sourceSha] = await Promise.all([
      (repositoryTask && anonymousFreshMachine && !refreshRuntime && !retainedSandboxId && !exactQuestionMachine &&
        expectedSha && /^[a-f0-9]{40}$/.test(expectedSha) && typeof sandbox.commands.streamInput === 'function'
        ? openWorkerBootstrapBroker(sandbox, {
          runId, leaseId, workerSha: expectedSha, handoff, directory,
          prepare: `install -d -o user -g user -m 700 /home/user/.mikka ${directory}`,
          publish, wake: `runuser -u user -- sh -c ${quoteShell(CLOUD_PRELOADER_WAKE_COMMAND)}`,
          wakeReceipt: CLOUD_PRELOADER_WAKE_RECEIPT,
          start: `runuser -u user -- sh -c ${quoteShell(workerCommand(CLOUD_WORKER_COMMAND))}`,
          timeoutMs: 40_000, registrationTimeoutMs: 30_000,
        }, { ...runtimeRequestOptions(refreshBudget), onStdout: onRegistrationOutput }).then(broker => {
          workerBroker = broker
          return broker.sourceSha
        })
        : sandbox.files.read('/opt/mikka/worker-source-sha', { user: 'root', ...runtimeRequestOptions(refreshBudget) }).then(value => value.trim())
      ).catch(error => { parallelFailurePhase ??= 'read_worker'; throw error }),
      repositoryTask ? undefined : installComputerRuntime(sandbox, refreshBudget).catch(error => { parallelFailurePhase ??= 'install_computer'; throw error }),
    ])
    refreshPhase = timings.next('verify_worker')
    const upgradeQuestion = exactQuestionMachine && run.status === 'queued' && !run.startedAt && !run.sessionId &&
      !run.stopRequestedAt && (!run.leaseExpiresAt || new Date(run.leaseExpiresAt).getTime() <= Date.now())
    const officialKind = threadMachineTemplateKind(machine)
    upgradeRetainedRuntime = Boolean(!refreshRuntime && (retainedSandboxId || upgradeQuestion) && expectedSha && sourceSha !== expectedSha && officialKind)
    if (refreshRuntime || upgradeRetainedRuntime) {
      if (upgradeRetainedRuntime && upgradeQuestion) {
        // Same VM, native CLI data and child. Only an idle Mikka worker moves
        // to the published release; a claimed continuation keeps its process.
        refreshDeadline = Date.now() + 240_000
        refreshBudget = budgetUntil(refreshDeadline)
        refreshPhase = timings.next('stage_admission')
        await client.query('BEGIN')
        await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${refreshBudget(5_000)}ms`])
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
        questionRuntimeUpgrade = await lockQuestionRuntimeUpgrade(client, actor, runId, run.questionContinuation.questionId)
        const { rows: [current] } = await client.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])
        if (!current || current.status !== 'queued' || current.startedAt || current.sessionId || current.stopRequestedAt ||
          (current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() > Date.now())) throw new ComputerError(409, 'Original question runtime is busy')
        await revalidateExecutionIdentity(client, current)
        const fenced = await client.query(`UPDATE thread_machines m SET state=CASE WHEN state='running' THEN 'error' ELSE state END
          WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."sandboxId"=$4 AND m."deviceId"=$5
            AND m."workerLeaseId"=$6 AND m."workerLeaseUntil">now() AND m.state<>'ended'
            AND NOT EXISTS(SELECT 1 FROM agent_runs active WHERE active."deviceId"=m."deviceId" AND active.id<>$1
              AND active.status NOT IN ('succeeded','failed','stopped','cancelled')) RETURNING m."runId"`,
        [runId, actor.userId, actor.workspaceId, sandbox.sandboxId, machine.deviceId, leaseId])
        if (!fenced.rowCount) throw new ComputerError(409, 'Original question runtime is busy or its ownership changed')
        await client.query('COMMIT')
      }
      const maintenance = async (action: 'switch' | 'rollback', release: Awaited<ReturnType<typeof stageOfficialWorkerRelease>>, budget = refreshBudget) => {
        await client.query('BEGIN')
        try {
          if (budget) await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${budget(5_000)}ms`])
          // The cloud claim path uses this same lock: staging happens before it;
          // only the bounded stop/switch window blocks new claims.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
          if (unclaimedQuestionRecovery && action === 'switch') await lockUnclaimedQuestionRuntimeRecovery(client, actor, runId, unclaimedQuestionRecovery)
          if (questionRuntimeUpgrade) await lockQuestionRuntimeUpgrade(client, actor, runId, run.questionContinuation.questionId, questionRuntimeUpgrade)
          const { rows: [maintenanceRun] } = await client.query('SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])
          if (upgradeRetainedRuntime) {
            if (!maintenanceRun || maintenanceRun.status !== 'queued' || maintenanceRun.stopRequestedAt ||
              (maintenanceRun.leaseExpiresAt && new Date(maintenanceRun.leaseExpiresAt).getTime() > Date.now())) throw new ComputerError(409, 'Retained task runtime is no longer queued')
            if (action === 'switch') await revalidateExecutionIdentity(client, maintenanceRun)
          }
          const held = await client.query(`SELECT 1 FROM thread_machines m JOIN devices d ON d.id=m."deviceId" AND d."ownerId"=m."ownerId" AND d.kind='cloud' AND (d.enabled=true OR $8::boolean)
            WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."sandboxId"=$4 AND m."deviceId"=$5
              AND m."workerLeaseId"=$6 AND m."workerLeaseUntil">now() AND m.state<>'ended'
              AND NOT EXISTS(SELECT 1 FROM agent_runs active WHERE active."deviceId"=m."deviceId" AND active."userId"=m."ownerId"
                AND (NOT $7::boolean OR active.id<>$1) AND active.status NOT IN ('succeeded','failed','stopped','cancelled')) FOR UPDATE OF m`,
            [runId,actor.userId,actor.workspaceId,sandbox.sandboxId,machine.deviceId,leaseId,upgradeRetainedRuntime,
              Boolean(unclaimedQuestionRecovery && unclaimedRuntimeSwitchStarted && action === 'rollback')])
          if (!held.rowCount) throw new ComputerError(409, 'Task runtime is busy or its ownership changed')
          if (unclaimedQuestionRecovery && action === 'switch') unclaimedRuntimeSwitchStarted = true
          await switchOfficialWorkerRelease(sandbox, release, {deviceId:machine.deviceId,workspaceId:actor.workspaceId,operationId:leaseId}, action, undefined, budget)
          await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1 AND "userId"=$2', [machine.deviceId,actor.userId])
          await client.query('COMMIT')
        } catch(error) { await client.query('ROLLBACK'); throw error }
      }
      refreshPhase = timings.next('stage_admission')
      if (unclaimedQuestionRecovery) {
        await client.query('BEGIN')
        await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${refreshBudget!(5_000)}ms`])
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
        await lockUnclaimedQuestionRuntimeRecovery(client, actor, runId, unclaimedQuestionRecovery)
        await client.query('COMMIT')
      }
      // Refuse busy/foreign machines before fetching or building any release.
      const idle = await pool.query(`SELECT 1 FROM thread_machines m JOIN agent_runs current ON current.id=m."runId" AND current."userId"=m."ownerId"
        WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m."sandboxId"=$4 AND m."workerLeaseId"=$5 AND m."workerLeaseUntil">now() AND m.state<>'ended'
          AND (NOT $6::boolean OR (current.status='queued' AND current."stopRequestedAt" IS NULL AND (current."leaseExpiresAt" IS NULL OR current."leaseExpiresAt"<=now())))
          AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r."deviceId"=m."deviceId" AND r."userId"=m."ownerId"
            AND (NOT $6::boolean OR r.id<>$1) AND r.status NOT IN ('succeeded','failed','stopped','cancelled'))`, [runId,actor.userId,actor.workspaceId,sandbox.sandboxId,leaseId,upgradeRetainedRuntime])
      if (!idle.rowCount) throw new ComputerError(409, 'Task runtime is busy')
      refreshPhase = timings.next('stage_release')
      if (!officialKind) throw new ComputerError(409, 'Verified cloud template required')
      const release = await stageOfficialWorkerRelease(sandbox,officialKind,sourceSha,process.env,undefined,refreshBudget)
      runtimeRollback = async () => {
        // Staging alone did not switch the worker. Once a switch may have
        // started, restore under this lease even if its answer/permission was
        // revoked; forward work still revalidates the full question receipt.
        if (!unclaimedQuestionRecovery || unclaimedRuntimeSwitchStarted) await maintenance('rollback',release,budgetUntil(Date.now()+30_000))
      }
      refreshPhase = timings.next('switch_release')
      await maintenance('switch',release)
      verifyRefreshedRuntime = () => switchOfficialWorkerRelease(sandbox,release,{deviceId:machine.deviceId,workspaceId:actor.workspaceId,operationId:leaseId},'verify',undefined,refreshBudget)
    } else if (!expectedSha || sourceSha !== expectedSha) throw new Error('Worker version mismatch')
    refreshPhase = timings.next('read_refreshed_worker')
    const refreshedSha = refreshRuntime || upgradeRetainedRuntime
      ? (await sandbox.files.read('/opt/mikka/worker-source-sha',{user:'root',...runtimeRequestOptions(refreshBudget)})).trim()
      : sourceSha
    refreshPhase = timings.next('verify_refreshed_worker')
    if (!expectedSha || refreshedSha!==expectedSha) throw new Error('Worker version mismatch')
    // Every computer action runs through lease-driver.py, which needs display :1 and its lease.
    // A snapshot boots with neither, and a resumed one may hold a lease from an older policy.
    refreshPhase = timings.next('start_desktop')
    if (!repositoryTask) await startThreadDesktop(pool, actor, runId, leaseId, sandbox, desktop, refreshBudget)
    refreshPhase = timings.next('credential_bootstrap')
    await client.query('BEGIN')
    if (refreshBudget) await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${refreshBudget(5_000)}ms`])
    if (unclaimedQuestionRecovery) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      await lockUnclaimedQuestionRuntimeRecovery(client, actor, runId, unclaimedQuestionRecovery)
    }
    if (questionRuntimeUpgrade) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
      await lockQuestionRuntimeUpgrade(client, actor, runId, run.questionContinuation.questionId, questionRuntimeUpgrade)
    }
    // Provision and end both lock the parent run before its machine.
    const current = (await client.query(refreshRuntime
      ? 'SELECT *,"stopRequestedAt"::text AS "registrationStopRequestedAt" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE'
      : 'SELECT * FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
    const activeLease = await client.query('SELECT 1 FROM thread_machines WHERE "runId"=$1 AND "workerLeaseId"=$2 AND state<>\'ended\' FOR UPDATE', [runId, leaseId])
    if (!activeLease.rowCount) throw new ComputerError(409, 'Thread provisioning cancelled')
    if (questionRuntimeUpgrade && (current.status !== 'queued' || current.startedAt || current.sessionId || current.stopRequestedAt ||
      (current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() > Date.now()))) throw new ComputerError(409, 'Original question runtime is busy')
    if (exactQuestionMachine && current.stopRequestedAt) throw new ComputerError(409, 'Thread stopped')
    if (retainedSandboxId && !refreshRuntime) {
      if (current.status !== 'queued' || current.stopRequestedAt || (current.leaseExpiresAt && new Date(current.leaseExpiresAt).getTime() > Date.now())) throw new ComputerError(409, 'Retained task runtime is no longer queued')
      await revalidateExecutionIdentity(client, current)
    }
    if (refreshRuntime) {
      // Maintenance preserves the terminal run. It does not claim a new
      // continuation or borrow the active-worker shortcut used by a wake.
      if (!['succeeded','failed','stopped','cancelled'].includes(current.status) ||
        current.status !== run.status || current.registrationStopRequestedAt !== run.registrationStopRequestedAt ||
        (exactQuestionMachine && (current.status !== 'failed' || current.sessionId !== run.sessionId))) throw new ComputerError(409, 'Task runtime is busy or its ownership changed')
    } else if (exactQuestionMachine && current.status !== 'queued') {
      if (!['preparing','running','waiting_input'].includes(current.status) || !current.leaseExpiresAt || new Date(current.leaseExpiresAt).getTime()<=Date.now()) throw new ComputerError(409,'Question continuation unavailable')
      await client.query('UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "workerLeaseId"=$2',[runId,leaseId])
      await client.query('COMMIT'); return { runId, state: 'running' }
    }
    let definition = current.agentDefinition
    const admission = definition?.repositoryAdmission
    if (current.status === 'queued' && admission) {
      if ((admission.workspaceId != null && (admission.workspaceId !== current.workspaceId || current.workspaceId !== actor.workspaceId)) ||
        !matchesRepositoryAdmission(admission, {
        userId: actor.userId, issueId: current.issueId, deviceId: current.deviceId, agentId: current.agentId,
        remoteKey: run.repoPath, remoteUrl: run.remoteUrl, targetBranch: admission.targetBranch,
        workspaceId: admission.workspaceId,
        workspaceLinked: admission.workspaceLinked, requestEventId: admission.requestEventId,
      })) throw new ComputerError(409, 'Repository authority unavailable')
      // Host-owned relocation changes the executor, never the admitted repository or branch.
      definition.repositoryAdmission = { ...admission, deviceId }
    }
    // Preserve five writes and their order inside this existing transaction.
    // The new token remains private until commit and bootstrap publication.
    const issuedCredential = await prepareThreadRegistration(client, {
      runId, deviceId, repoId, ownerId: actor.userId, workspaceId: actor.workspaceId,
      repoPath: run.repoPath, baseBranch: run.baseBranch, verifyCommand: run.verifyCommand, remoteUrl: run.remoteUrl,
      tokenId: randomUUID(), tokenSha256: createHash('sha256').update(credential).digest('hex'),
    })
    definition = await rebindExecutionDevice(client, { ...current, agentDefinition: definition }, deviceId)
    await client.query('UPDATE agent_runs SET "deviceId"=$2,"deviceRepoId"=$3,"agentDefinition"=COALESCE($5::jsonb,"agentDefinition") WHERE id=$1 AND "userId"=$4 AND status=\'queued\'', [runId, deviceId, repoId, actor.userId, definition ? JSON.stringify(definition) : null])
    // The host relocates a check to its dedicated machine before claim. Its
    // candidate remains fixed; only execution placement changes.
    await client.query(`UPDATE factory_attempts SET output=jsonb_set(jsonb_set(output,'{check,deviceRepoId}',to_jsonb($2::text)),'{check,environment}',to_jsonb($3::text))
      WHERE "runId"=$1 AND stage IN ('review','verify') AND output ? 'check'`, [runId, repoId, `device:${deviceId}`])
    await client.query('COMMIT')
    // Publishing bootstrap wakes an existing preloader before the explicit start
    // command. Count only this credential's use since its handoff began.
    refreshPhase = timings.next('publish_bootstrap')
    const handoffStartedAt = issuedCredential.now as Date
    const bootstrap = JSON.stringify({ deviceId, workspaceId: actor.workspaceId, credential, server: origin.toString(),
      traceContext: captureTraceContext({ runId }), tracing: daemonTraceSettings(),
      ...(process.env.VERCEL_ENV === 'preview' && process.env.MIKKA_CLOUD_PREVIEW_BYPASS ? { protectionBypass: process.env.MIKKA_CLOUD_PREVIEW_BYPASS } : {}) })
    // Keep the strict bootstrap schema readable by old workers during rollout
    // and rollback. This optional locator binds to the same one-use bytes; it
    // carries no assignment or usable credential. String multipart is one RPC.
    const initialRun = refreshRuntime ? '' : JSON.stringify({ version: 1, runId, bootstrapSha256: createHash('sha256').update(bootstrap).digest('hex') })
    const anonymousClaude = anonymousClaudeStartupHint({
      freshTask: firstAnonymousClaudeTask({ created: anonymousFreshMachine, refresh: refreshRuntime, retained: Boolean(retainedSandboxId), question: exactQuestionMachine }, current),
      runId, bootstrap, kind: current.kind, repository: run.repoPath, definition, userId: actor.userId, botId: current.botId,
    })
    const anonymousCodex = anonymousCodexStartupHint({
      freshTask: firstAnonymousClaudeTask({ created: anonymousFreshMachine, refresh: refreshRuntime, retained: Boolean(retainedSandboxId), question: exactQuestionMachine }, current),
      runId, bootstrap, kind: current.kind, repository: run.repoPath, definition, userId: actor.userId, botId: current.botId,
    })
    const uploads = [{ path: handoff, data: bootstrap }, { path: `${handoff}.run`, data: initialRun }, { path: `${handoff}.claude`, data: anonymousClaude }, { path: `${handoff}.codex`, data: anonymousCodex }]
    if (workerBroker?.active) workerBroker.assertAwaitingUpload()
    await sandbox.files.write(uploads, { user: 'root', useOctetStream: false, ...runtimeRequestOptions(refreshBudget) })
    // The foreground command must finish the atomic publication before waking
    // the existing watcher as user. Keep credential bytes in the file upload,
    // never in this command/argv/env. Only an acknowledged signal skips the
    // redundant remote start; absent/old preloaders keep the original fallback.
    refreshPhase = timings.next('start_worker')
    try {
      // Only an acknowledged whole upload may commit on the existing stream.
      // Enter start_worker first: a fast registration push may arrive in send().
      if (workerBroker?.active) await workerBroker.commit(uploads, {
        deviceId, workspaceId: actor.workspaceId, tokenSha256: createHash('sha256').update(credential).digest('hex'),
      })
      const publication = workerBroker?.active ? await workerBroker.result : await sandbox.commands.run(`install -d -o user -g user -m 700 /home/user/.mikka ${directory} && ${registrationCommand({
        directory, deviceId, workspaceId: actor.workspaceId, workerSha: expectedSha,
        tokenSha256: createHash('sha256').update(credential).digest('hex'),
        publish, wake: `runuser -u user -- sh -c ${quoteShell(CLOUD_PRELOADER_WAKE_COMMAND)}`,
        wakeReceipt: CLOUD_PRELOADER_WAKE_RECEIPT,
        // The detached fallback retains the original sandbox log, without
        // keeping this foreground wait's stdout/stderr pipes open.
        start: `runuser -u user -- sh -c ${quoteShell(workerCommand(CLOUD_WORKER_COMMAND))}`,
        timeoutMs: refreshBudget ? refreshBudget(30_000) : 30_000,
      })}`, { user: 'root', ...runtimeCommandOptions(40_000, refreshBudget), onStdout: onRegistrationOutput })
      const messages = publication.stdout.split('\n')
      if (messages.includes(REGISTRATION_LEGACY)) {
        // Rolling deployments/rollback can still select a legitimate old worker.
        // Only absence of its release-bound capability retains the original
        // polling path; no timeout probing or extra queries on new workers.
        registrationWaiting = true
        refreshPhase = timings.next('worker_register')
        const deadline = Math.min(Date.now() + 30_000, refreshDeadline ?? Infinity)
        let ready = false
        do {
          refreshBudget?.(1)
          ready = Boolean((await pool.query('SELECT 1 FROM devices d JOIN device_tokens t ON t."boundDeviceId"=d.id WHERE d.id=$1 AND d."ownerId"=$2 AND d."lastSeenAt">=$3 AND t."tokenHash"=$4 AND t."revokedAt" IS NULL AND t."lastUsedAt">=$3',
            [deviceId, actor.userId, handoffStartedAt, createHash('sha256').update(credential).digest('hex')])).rowCount)
          if (!ready) await new Promise(resolve => setTimeout(resolve, 500))
        } while (!ready && Date.now() < deadline)
        if (!ready) throw new Error('Thread worker did not register')
      } else if (!messages.includes(REGISTRATION_COMPLETE)) throw new Error('Thread worker did not register')
      // A transport may coalesce stdout until completion. Keep every phase;
      // its wait then remains in start_worker, never outside the parent clock.
      if (!registrationWaiting) refreshPhase = timings.next('worker_register')
    } catch (error) {
      if (!registrationWaiting) throw error
      const mask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
      await saveWorkerTail(pool, runId, await readWorkerTail(async () => sandbox), mask, refreshRuntime ? undefined : 'Thread worker did not register').catch(() => undefined)
      throw new Error('Thread worker did not register', { cause: error })
    }
    await workerBroker?.close()
    refreshPhase = timings.next('verify_runtime')
    if (verifyRefreshedRuntime) await verifyRefreshedRuntime()
    refreshPhase = timings.next('finish')
    refreshBudget?.(1)
    const finished = await finishThreadRegistration(client, runId, leaseId, deviceId,
      createHash('sha256').update(credential).digest('hex'), handoffStartedAt,
      refreshRuntime ? { status: current.status, stopRequestedAt: current.registrationStopRequestedAt } : undefined)
    if (!finished.rowCount) throw new ComputerError(409, 'Thread provisioning cancelled')
    taskActivityChanged(pool, runId)
    await runChanged(pool, runId)
    logThreadLifecycle(finished.rows[0], { phase: finished.rows[0].lifecycle.phase, reason: finished.rows[0].lifecycle.phase, provider: 'running', deadline: Date.now(), computeSeconds: finished.rows[0].computeSeconds })
    return { runId, state: 'running' }
    }, run.agentDefinition?.traceContext)
  } catch (error) {
    // Capture the rejecting branch before cleanup and the start wrapper hide
    // it. Admission can fail before the exact-question flag is available.
    // Only the existing bounded classifications are logged; no run history or
    // original VM/session is changed by these diagnostics.
    logRuntimeRefreshFailure(runId, parallelFailurePhase ?? refreshPhase, error, undefined,
      refreshRuntime || upgradeRetainedRuntime ? 'refresh' : 'start')
    await client.query('ROLLBACK')
    // Abort this lease's unpublished broker before start-failure recovery.
    // Preserve the primary admission/upload/registration failure if transport cleanup also fails.
    await workerBroker?.close().catch(() => undefined)
    // A placement change can invalidate the locked target after preflight.
    // No provisioning lease was acquired, so there is nothing to clean up.
    if (isProjectExecutionRefusal(error) && !reservedStartLease) throw error
    if (runtimeRollback) {
      try { await runtimeRollback() } catch (rollbackError) { logRuntimeRefreshFailure(runId, 'rollback', rollbackError) }
    }
    if (refreshRuntime) await pool.query(`UPDATE thread_machines SET state='error',"workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "ownerId"=$2 AND "workerLeaseId"=$3 AND state<>'ended'`,[runId,actor.userId,leaseId]).catch(()=>undefined)
    else if (exactQuestionMachine) await pool.query('UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "workerLeaseId"=$2',[runId,leaseId]).catch(()=>undefined)
    else if (retainedSandboxId) {
      await pool.query(`UPDATE thread_machines m SET state=CASE WHEN EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=m."runId" AND r.status='queued'
        AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=now())) THEN 'error' ELSE m.state END,
        "workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND "workerLeaseId"=$5 AND state<>'ended'`, [runId,actor.userId,actor.workspaceId,retainedSandboxId,leaseId]).catch(()=>undefined)
      throw new RetainedTaskMachineUnavailable()
    }
    else if (reservedStartLease && error && typeof error === 'object') {
      failedThreadStarts.set(error, Object.freeze({ userId: actor.userId, workspaceId: actor.workspaceId, runId, leaseId }))
    }
    throw error
  } finally { timings.end(); client.release() }
}

export async function threadMachineAction(pool: Pool, actor: Actor, runId: string, action: 'pause' | 'resume' | 'end' | 'refresh_runtime', expectedFence?: ThreadMachineFence) {
  const machine = (await pool.query('SELECT * FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!machine || (machine.state === 'ended' && action !== 'end')) throw new ComputerError(404, 'Thread unavailable')
  if (action === 'refresh_runtime') return ensureThreadMachine(pool,actor,runId,threadMachineProvider,threadDesktop,true)
  if (action === 'end') {
    // Fence provisioning and revoke any existing token before provider I/O.
    // Retain the sandbox ID so a failed or lost kill response can be retried.
    const client = await pool.connect()
    let sandboxId: string | null
    let filesystemSnapshotId: string | null = null
    let creationPending: boolean
    let epoch: number
    try {
      await client.query('BEGIN')
      // Task edits lock the task before their runs. Keep that order while
      // validating automatic retirement, so reopening cannot race a kill.
      const issue = expectedFence?.requireClosedTask && machine.issueId
        ? (await client.query('SELECT status,content FROM issues WHERE id=$1 FOR SHARE', [machine.issueId])).rows[0]
        : undefined
      const lockedRun = (await client.query('SELECT status,report FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])).rows[0]
      const locked = (await client.query('SELECT "sandboxId","deviceId","workerLeaseId","workerLeaseUntil",epoch,state,"filesystemSnapshotId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE', [runId, actor.userId, actor.workspaceId])).rows[0]
      if (!locked) throw new ComputerError(404, 'Thread unavailable')
      if (expectedFence && (locked.epoch !== expectedFence.epoch || locked.sandboxId !== expectedFence.sandboxId)) {
        await client.query('COMMIT')
        return { runId, state: locked.state }
      }
      if (expectedFence?.requireClosedTask && (!machine.issueId || (issue && !['done', 'canceled', 'duplicate'].includes(issue.status) && !issue.content?.attrs?.mikka?.deletedAt))) {
        await client.query('COMMIT')
        return { runId, state: locked.state }
      }
      if (expectedFence?.requireArchived) {
        const proof = lockedRun?.report?.safePoint
        const checkpoint = (await client.query('SELECT "takenAt","unavailableReason" FROM run_checkpoints WHERE "runId"=$1 AND "userId"=$2', [runId, actor.userId])).rows[0]
        const checkpointAt = typeof proof?.checkpointTakenAt === 'string' ? new Date(proof.checkpointTakenAt).getTime() : NaN
        const observedAt = typeof proof?.observedAt === 'string' ? new Date(proof.observedAt).getTime() : NaN
        if (!['succeeded', 'failed', 'stopped', 'cancelled'].includes(lockedRun?.status) || proof?.session !== 'exited' || proof.checkpoint !== 'ready' ||
          !checkpoint || checkpoint.unavailableReason || !Number.isFinite(checkpointAt) || !Number.isFinite(observedAt) ||
          checkpointAt !== new Date(checkpoint.takenAt).getTime() || observedAt < checkpointAt || observedAt > Date.now()) {
          await client.query('COMMIT')
          return { runId, state: locked.state }
        }
      }
      sandboxId = locked.sandboxId
      filesystemSnapshotId = locked.filesystemSnapshotId
      epoch = locked.epoch
      creationPending = !sandboxId && Boolean(locked.workerLeaseId || locked.workerLeaseUntil)
      const stopped = await client.query(`UPDATE agent_runs SET status='stopped',"stopRequestedAt"=COALESCE("stopRequestedAt",now()),"finishedAt"=COALESCE("finishedAt",now())
        WHERE id=$1 AND "userId"=$2 AND status NOT IN ('succeeded','failed','stopped','cancelled') RETURNING id`, [runId, actor.userId])
      if (stopped.rowCount) { await runListChanged(client, runId); await runChanged(client, runId) }
      await client.query(`UPDATE thread_machines SET state='ended',"endedAt"=COALESCE("endedAt",now()),"computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0),
        "runningSince"=NULL,"workerLeaseId"=NULL,"workerLeaseUntil"=CASE WHEN $2 THEN COALESCE("workerLeaseUntil",now()) ELSE NULL END,
        "lifecycleAt"=CASE WHEN "sandboxId" IS NOT NULL OR $2 THEN now()+interval '30 seconds' ELSE NULL END,
        lifecycle=lifecycle||jsonb_build_object('phase','retire_requested','owner','run-recovery') WHERE "runId"=$1`, [runId, creationPending])
      // An adopted old row has given up its sandbox; its historical device ID
      // belongs to the new stage now. Only the machine still owning a sandbox
      // (or an in-flight creation) can revoke/retire that device.
      if (sandboxId || creationPending) {
        await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "boundDeviceId"=$1', [locked.deviceId])
        await client.query('UPDATE devices SET "removedAt"=COALESCE("removedAt",now()) WHERE id=$1 AND "ownerId"=$2 AND kind=\'cloud\'', [locked.deviceId, actor.userId])
      }
      armDueTimerAfterCommit(client, 'run-recovery')
      await runChanged(client, runId)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    // This is a terminal write outside the daemon completion path: finalize a
    // bound Factory task after commit. Flag-gated, idempotent, never throws.
    await afterRunEnded(actor.userId, runId)
    if (creationPending) throw new ComputerError(409, 'Thread creation cleanup pending')
    // Run end has fenced new captures. Preserve existing recordings before
    // destroying the dedicated filesystem that still holds their bytes.
    const { screenCaptures } = await import('@/lib/captures/screen')
    await screenCaptures.stopRunRecordings([runId])
    // A running machine's last output is kept before the kill (a parked one kept it when it paused).
    // Best effort and bounded: reading never blocks the kill.
    if (sandboxId && machine.state !== 'paused') await keepTailBeforeKill(pool, actor, runId, sandboxId)
    try {
      if (sandboxId) await threadMachineProvider.kill(sandboxId, actor.userId).catch(error => { if (!sandboxGone(error)) throw error })
      const retired = await pool.query(`UPDATE thread_machines SET "sandboxId"=NULL,"lifecycleAt"=NULL,
        lifecycle=(lifecycle-'reconcileId'-'reconcileUntil')||jsonb_build_object('phase','retired','owner','run-recovery','failures',0)
        WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND state='ended'
          AND "sandboxId" IS NOT DISTINCT FROM $5::text RETURNING "computeSeconds"`, [runId, actor.userId, actor.workspaceId, epoch, sandboxId])
      if (retired.rowCount) taskActivityChanged(pool, runId)
      if (retired.rowCount) logThreadLifecycle({ runId, issueId: machine.issueId, sandboxId, epoch }, { phase: 'retired', provider: sandboxId ? 'kill_ack' : 'not_observed', deadline: null, computeSeconds: retired.rows[0].computeSeconds })
      // The VM is gone; a task-owned snapshot has no remaining reader once the
      // task is closed or the run is ended.
      if (retired.rowCount && filesystemSnapshotId) await releaseEndedThreadSnapshot(pool, actor, runId, filesystemSnapshotId)
    } catch (error) {
      await pool.query(`UPDATE thread_machines SET "lifecycleAt"=now()+interval '30 seconds',
        lifecycle=lifecycle||jsonb_build_object('phase','retire_failed','owner','run-recovery')
        WHERE "runId"=$1 AND "sandboxId"=$2 AND epoch=$3 AND state='ended'`, [runId, sandboxId, epoch])
        .catch(() => { /* The committed retirement intent survives a lost DB response. */ })
      armDueTimerSoon('run-recovery')
      throw error
    }
    return { runId, state: 'ended' }
  }
  if (action === 'resume') return ensureThreadMachine(pool, actor, runId)
  if (!machine.sandboxId) throw new ComputerError(409, 'Thread machine has not started')
  if (action === 'pause') {
    await parkThreadMachine(pool, actor, runId, undefined, undefined, undefined, expectedFence)
  }
  return { runId, state: action === 'pause' ? 'paused' : machine.state }
}

