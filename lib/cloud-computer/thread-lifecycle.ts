import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { ThreadMachineFence } from './thread-machines'
import { threadLifecycleProvider, type ThreadProviderInfo } from './thread-lifecycle-provider'
import { logThreadLifecycle, threadLifecycleErrorKind } from './thread-lifecycle-log'
import { taskActivityChanged } from '../factory/activity-live'

export const THREAD_MACHINE_IDLE_MS = 2 * 60_000
export const THREAD_MACHINE_PROVIDER_MS = 15 * 60_000
export const THREAD_MACHINE_REFRESH_MS = 5 * 60_000
export const THREAD_MACHINE_BUDGET_MS = 12 * 60 * 60_000
export const THREAD_MACHINE_RETENTION_MS = 7 * 24 * 60 * 60_000
export const CLOSED_TASK_RETENTION_MS = 60 * 60_000
export const THREAD_MACHINE_STOP_GRACE_MS = 30_000
const CLAIM_MS = 60_000
const TERMINAL = new Set(['succeeded', 'failed', 'stopped', 'cancelled'])

type Actor = { userId: string; workspaceId: string }
export type ThreadLifecycleMetadata = {
  owner?: 'run-recovery'; phase?: string; reason?: string; failures?: number
  sponsoredUntil?: string
  pausedAt?: number; executionDeadline?: number; providerDeadline?: number | null
  observedStatus?: string; observedStop?: boolean; observedClosed?: boolean
  reconcileId?: string; reconcileUntil?: number; reconcileVersion?: number
  handoffRunId?: string; handoffUntil?: number
  transferredAt?: string
  providerMissingAt?: number
  providerMissingReceipt?: string
  creationMissingAt?: number
  requiresNativeExit?: boolean
  computeSource?: 'database_estimate' | 'provider_started_at_estimate' | 'unconfirmed_creation_interval'
}
type Instant = Date | string | number | null
export type ThreadLifecycleRow = {
  runId: string; ownerId: string; workspaceId: string; epoch: number
  snapshotId?: string; sandboxId: string | null; state: string; deviceId: string | null; operationId?: string
  workerLeaseId?: string | null; workerLeaseUntil: Instant; leaseExpiresAt: Instant; lastActiveAt: Instant
  runningSince: Instant; computeSeconds: string | number; lifecycleAt: Instant
  /** PostgreSQL text preserves the microseconds lost by pg's Date decoder. */
  lifecycleAtVersion: string | null
  lifecycle: ThreadLifecycleMetadata; status: string; stopRequestedAt: Instant
  pauseReason?: string | null; safeExit?: boolean
  issueId: string | null; taskClosed: boolean; checkpointReady: boolean
}
type Dependencies = {
  provider: Pick<typeof threadLifecycleProvider, 'info' | 'keepAlive'> & Partial<Pick<typeof threadLifecycleProvider, 'findCreated'>>
  park: (pool: Pool, actor: Actor, runId: string, fence: ThreadMachineFence) => Promise<unknown>
  end: (pool: Pool, actor: Actor, runId: string, fence: ThreadMachineFence) => Promise<unknown>
  acknowledgeStop: (pool: Pool, actor: Actor, runId: string) => Promise<boolean>
  stop: (pool: Pool, actor: Actor, row: ThreadLifecycleRow, cause: StopCause, claimId: string, now: number) => Promise<boolean>
  recover: (pool: Pool, actor: Actor, row: ThreadLifecycleRow, now: number) => Promise<void>
  now: () => number
}

const at = (value: Instant) => value === null ? 0 : new Date(value).getTime()
const live = (value: Instant, now: number) => at(value) > now
const nextRetry = (now: number, failures: number) => now + Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6))
const fenceOf = (row: ThreadLifecycleRow): ThreadMachineFence => ({ epoch: row.epoch, sandboxId: row.sandboxId })
const pendingCreation = (row: ThreadLifecycleRow) => Boolean(row.workerLeaseId || row.workerLeaseUntil
  || row.lifecycle.phase === 'create_requested' || row.lifecycle.creationMissingAt != null)

/** A paused interval is not execution time. Recalculate after resume from the
 * persisted billed time instead of expiring a week-old wall-clock deadline. */
export function threadMachineExecutionDeadline(row: ThreadLifecycleRow, now: number): number {
  const elapsed = row.state === 'running' && row.runningSince ? Math.max(0, now - at(row.runningSince)) : 0
  return now + Math.max(0, THREAD_MACHINE_BUDGET_MS - Number(row.computeSeconds) * 1_000 - elapsed)
}

type StopCause = 'task_closed' | 'execution_budget' | 'execution_lease_lost' | 'provider_paused'
type Decision = { action: 'stop' | 'recover'; at: number; reason: StopCause }
  | { action: 'keep' | 'pause' | 'retire' | 'wait' | 'missing'; at: number | null; reason: string }

/** Status/heartbeat alone never proves that a native process has exited. A
 * terminal receipt can park; only its matching uploaded checkpoint can retire. */
export function threadMachineLifecycleDecision(row: ThreadLifecycleRow, provider: ThreadProviderInfo | null, now: number): Decision {
  const bootstrap = live(row.workerLeaseUntil, now)
  if (row.state === 'ended') return { action: row.sandboxId ? 'retire' : 'wait', at: bootstrap ? at(row.workerLeaseUntil) + 1 : null,
    reason: !row.sandboxId && pendingCreation(row) ? 'creation_cleanup_unconfirmed' : 'retirement' }
  if (!row.sandboxId) return { action: 'wait', at: bootstrap ? at(row.workerLeaseUntil) + 1 : null,
    reason: bootstrap ? 'provisioning' : pendingCreation(row) ? 'creation_cleanup_unconfirmed' : 'provider_missing' }
  const terminal = TERMINAL.has(row.status)
  if (provider?.state === 'missing' && !bootstrap) return { action: 'missing',
    at: row.lifecycle.providerMissingAt == null || now < row.lifecycle.providerMissingAt + THREAD_MACHINE_STOP_GRACE_MS
      ? (row.lifecycle.providerMissingAt ?? now) + THREAD_MACHINE_STOP_GRACE_MS : null, reason: 'provider_missing' }
  if (!terminal && row.stopRequestedAt) {
    const stopAt = at(row.stopRequestedAt) + THREAD_MACHINE_STOP_GRACE_MS
    return { action: now >= stopAt ? 'pause' : provider?.state === 'running' ? 'keep' : 'wait', at: stopAt,
      reason: now >= stopAt ? 'stop_unacknowledged' : 'stop_pending' }
  }
  if (bootstrap) return { action: provider?.state === 'running' ? 'keep' : 'wait', at: Math.min(at(row.workerLeaseUntil) + 1, now + THREAD_MACHINE_REFRESH_MS), reason: 'provisioning' }
  if (row.lifecycle.phase === 'handoff' && row.lifecycle.handoffRunId && (row.lifecycle.handoffUntil ?? 0) > now && !row.stopRequestedAt && !row.taskClosed)
    return { action: 'wait', at: row.lifecycle.handoffUntil!, reason: 'stage_handoff' }
  // A quota completion deliberately leaves status=paused with no run lease.
  // It is waiting for account recovery, not a crashed/abandoned execution.
  const quotaWait = row.status === 'paused' && row.pauseReason === 'quota_exhausted'
  if (quotaWait && !row.taskClosed && provider?.state === 'running') return row.safeExit
    ? { action: 'pause', at: now, reason: 'quota_wait' }
    : { action: 'wait', at: provider.endAt && provider.endAt > now ? provider.endAt : null, reason: 'quota_safe_point_unverified' }
  if (!terminal && (row.taskClosed || threadMachineExecutionDeadline(row, now) <= now))
    return { action: 'stop', at: now + THREAD_MACHINE_STOP_GRACE_MS, reason: row.taskClosed ? 'task_closed' : 'execution_budget' }
  if (!terminal && !quotaWait && row.status !== 'queued' && !live(row.leaseExpiresAt, now))
    return { action: 'recover', at: now + THREAD_MACHINE_STOP_GRACE_MS, reason: 'execution_lease_lost' }
  if (!terminal && !quotaWait && row.status !== 'queued' && provider?.state === 'paused')
    return { action: 'stop', at: now + THREAD_MACHINE_STOP_GRACE_MS, reason: 'provider_paused' }
  if (provider?.state === 'paused' || (!provider && row.state === 'paused')) {
    const pausedAt = row.lifecycle.pausedAt ?? now
    const retireAt = pausedAt + (row.taskClosed ? CLOSED_TASK_RETENTION_MS : THREAD_MACHINE_RETENTION_MS)
    if (now >= retireAt) {
      if (terminal && row.taskClosed && row.checkpointReady) return { action: 'retire', at: null, reason: 'retention_elapsed' }
      // The task may own the only copy of its work. An expired retention timer
      // asks for evidence; it cannot manufacture permission to destroy bytes.
      return { action: 'wait', at: null, reason: !row.taskClosed && row.checkpointReady ? 'native_archive_unverified' : 'checkpoint_unverified' }
    }
    return { action: 'wait', at: retireAt, reason: 'paused_retention' }
  }
  if (terminal) return { action: 'pause', at: now, reason: 'run_ended' }
  if (row.status === 'queued' && !live(row.leaseExpiresAt, now)) {
    const idleAt = at(row.lastActiveAt) + THREAD_MACHINE_IDLE_MS
    return { action: now >= idleAt ? 'pause' : 'keep', at: Math.min(idleAt, now + THREAD_MACHINE_REFRESH_MS), reason: 'unclaimed_idle' }
  }
  return { action: 'keep', at: Math.min(now + THREAD_MACHINE_REFRESH_MS,
    row.stopRequestedAt ? Infinity : threadMachineExecutionDeadline(row, now)), reason: row.stopRequestedAt ? 'stop_pending' : 'active_run' }
}

async function requestLifecycleStop(pool: Pool, actor: Actor, row: ThreadLifecycleRow, cause: StopCause, claimId: string, now: number): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Task closure locks issue→run→machine, as retirement does. A reopen cannot
    // cross this stop commit after the final closed-task guard has succeeded.
    if (cause === 'task_closed') await client.query(`SELECT i.id FROM issues i JOIN thread_machines m ON m."issueId"=i.id
      WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m.epoch=$4
        AND m."sandboxId" IS NOT DISTINCT FROM $5::text AND m.lifecycle->>'reconcileId'=$6 FOR SHARE OF i`,
    [row.runId, actor.userId, actor.workspaceId, row.epoch, row.sandboxId, claimId])
    // A renewed run lease or a replacement reconciliation claim must win
    // before this snapshot can request a stop.
    await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [row.runId, actor.userId])
    await client.query(`SELECT "runId" FROM thread_machines WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE`,
      [row.runId, actor.userId, actor.workspaceId])
    const stopped = await client.query(`UPDATE agent_runs r SET "stopRequestedAt"=now(),"updatedAt"=now()
      FROM thread_machines m LEFT JOIN issues i ON i.id=m."issueId"
      WHERE r.id=$1 AND r."userId"=$2 AND m."runId"=r.id AND m."ownerId"=$2 AND m."workspaceId"=$3
        AND m.epoch=$4 AND m."sandboxId" IS NOT DISTINCT FROM $5::text AND m.lifecycle->>'reconcileId'=$6
        AND r.status NOT IN ('succeeded','failed','stopped','cancelled') AND r."stopRequestedAt" IS NULL
        AND CASE $7::text
          WHEN 'execution_lease_lost' THEN r.status<>'queued' AND NOT (r.status='paused' AND r."pauseReason" IS NOT DISTINCT FROM 'quota_exhausted')
            AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt"<=to_timestamp($8::double precision/1000))
          WHEN 'task_closed' THEN m."issueId" IS NOT NULL AND (i.id IS NULL OR i.status IN ('done','canceled','duplicate')
            OR i.content->'attrs'->'mikka'->>'deletedAt' IS NOT NULL)
          WHEN 'execution_budget' THEN m."computeSeconds"*1000+CASE WHEN m.state='running' THEN
            COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (to_timestamp($8::double precision/1000)-m."runningSince")))*1000,0) ELSE 0 END >= $9::double precision
          WHEN 'provider_paused' THEN m.state='paused' AND r.status<>'queued'
            AND NOT (r.status='paused' AND r."pauseReason" IS NOT DISTINCT FROM 'quota_exhausted')
          ELSE false END
      RETURNING r."deviceId"`, [row.runId, actor.userId, actor.workspaceId, row.epoch, row.sandboxId, claimId, cause, now, THREAD_MACHINE_BUDGET_MS])
    if (!stopped.rowCount) { await client.query('COMMIT'); return false }
    const [{ runChanged }, { runListChanged }, { notifyDeviceWork }] = await Promise.all([
      import('@/lib/live/panels'), import('@/lib/live/lists'), import('@/lib/device-gateway-notify'),
    ])
    await runChanged(client, row.runId)
    await runListChanged(client, row.runId)
    await client.query('COMMIT')
    notifyDeviceWork(stopped.rows[0].deviceId)
    return true
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

const runtime: Dependencies = {
  provider: threadLifecycleProvider, now: Date.now,
  park: async (pool, actor, runId, fence) => (await import('./thread-machines')).parkThreadMachine(pool, actor, runId, undefined, undefined, undefined, fence),
  end: async (pool, actor, runId, fence) => (await import('./thread-machines')).threadMachineAction(pool, actor, runId, 'end', fence),
  acknowledgeStop: async (pool, actor, runId) => (await import('./thread-machines')).acknowledgeQueuedThreadStop(pool, actor, runId),
  stop: requestLifecycleStop,
  recover: async (_pool, actor, _row, now) => (await import('@/lib/run-leases')).reclaimLostRuns(actor.userId, new Date(now)),
}

/** Shared by the per-run Workflow and the existing deployment-owned recovery
 * timer. Every I/O attempt has a committed claim/deadline before it starts. */
export async function reconcileThreadMachine(pool: Pool, actor: Actor, runId: string, overrides: Partial<Dependencies> = {}): Promise<false | number> {
  const deps = { ...runtime, ...overrides }, now = deps.now()
  const row = (await pool.query<ThreadLifecycleRow>(`SELECT m.*,m."lifecycleAt"::text AS "lifecycleAtVersion",r.status,r."stopRequestedAt",r."leaseExpiresAt",r."pauseReason",
      COALESCE(r.report->'safePoint'->>'session'='exited',false) AS "safeExit",
      (m."issueId" IS NOT NULL AND (i.id IS NULL OR i.status IN ('done','canceled','duplicate')
        OR i.content->'attrs'->'mikka'->>'deletedAt' IS NOT NULL)) AS "taskClosed",
      COALESCE(r.report->'safePoint'->>'session'='exited' AND r.report->'safePoint'->>'checkpoint'='ready'
        AND c."unavailableReason" IS NULL
        AND r.report->'safePoint'->>'checkpointTakenAt'=to_char(c."takenAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        AND r.report->'safePoint'->>'observedAt'>=r.report->'safePoint'->>'checkpointTakenAt'
        AND r.report->'safePoint'->>'observedAt'<=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),false) AS "checkpointReady"
    FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
    LEFT JOIN issues i ON i.id=m."issueId" LEFT JOIN run_checkpoints c ON c."runId"=r.id AND c."userId"=r."userId"
    WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3`, [runId, actor.userId, actor.workspaceId])).rows[0]
  if (!row) return false
  if (row.snapshotId === 'cloudflare-task-v1') {
    const { reconcileSponsoredTaskMachine } = await import('./sponsored-lifecycle')
    return reconcileSponsoredTaskMachine(pool, actor, runId, row, now)
  }
  // A replay of the legacy monitor is not new task demand. Share the stored
  // deadline with recovery so two sequential callbacks cannot both renew a
  // VM, and provider failures respect their persisted backoff.
  const unchanged = row.lifecycle.observedStatus === row.status && row.lifecycle.observedStop === Boolean(row.stopRequestedAt)
    && row.lifecycle.observedClosed === row.taskClosed
  if (unchanged && !live(row.lifecycle.reconcileUntil ?? null, now)) {
    if (row.lifecycleAt === null) return false
    if (at(row.lifecycleAt) > now) return at(row.lifecycleAt)
  }
  const token = randomUUID(), claimUntil = now + CLAIM_MS
  const claimed = await pool.query(`UPDATE thread_machines SET lifecycle=lifecycle||jsonb_build_object('owner','run-recovery','reconcileId',$6::text,'reconcileUntil',$7::double precision,
        'reconcileVersion',COALESCE((lifecycle->>'reconcileVersion')::bigint,0)+1),
      "lifecycleAt"=to_timestamp($7::double precision/1000)
    WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND "sandboxId" IS NOT DISTINCT FROM $5::text
      AND COALESCE((lifecycle->>'reconcileUntil')::double precision,0)<=$8::double precision
      AND "lifecycleAt" IS NOT DISTINCT FROM $9::timestamptz
      AND COALESCE((lifecycle->>'reconcileVersion')::bigint,0)=$10::bigint RETURNING "runId"`,
  [runId, actor.userId, actor.workspaceId, row.epoch, row.sandboxId, token, claimUntil, now, row.lifecycleAtVersion, row.lifecycle.reconcileVersion ?? 0])
  if (!claimed.rowCount) return row.lifecycle.reconcileUntil && row.lifecycle.reconcileUntil > now ? row.lifecycle.reconcileUntil : now + 1

  const observed = { owner: 'run-recovery', observedStatus: row.status, observedStop: Boolean(row.stopRequestedAt), observedClosed: row.taskClosed }
  let phase = 'needs_reconciliation'
  let providerOutcome = 'not_observed'
  let committedTransition: (() => void) | undefined
  const finish = async (metadata: Record<string, unknown>, due: number | null, client: Pick<PoolClient, 'query'> = pool) => {
    const result = await client.query(`UPDATE thread_machines SET lifecycle=(lifecycle-'reconcileId'-'reconcileUntil')||$7::jsonb,
        "lifecycleAt"=CASE WHEN $8::double precision IS NULL THEN NULL ELSE to_timestamp($8::double precision/1000) END
      WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND "sandboxId" IS NOT DISTINCT FROM $5::text
        AND lifecycle->>'reconcileId'=$6 AND (state<>'ended' OR $9::boolean) RETURNING "runId"`,
    [runId, actor.userId, actor.workspaceId, row.epoch, row.sandboxId, token, JSON.stringify({ ...observed, ...metadata }), due, row.state === 'ended'])
    if (result.rowCount && (metadata.phase !== row.lifecycle.phase || metadata.reason !== row.lifecycle.reason)) {
      const emit = () => logThreadLifecycle(row, { phase: metadata.phase, reason: metadata.reason, deadline: due, provider: providerOutcome,
        computeSeconds: Number(row.computeSeconds) + (row.runningSince ? Math.max(0, deps.now() - at(row.runningSince)) / 1_000 : 0),
        computeSource: row.lifecycle.computeSource })
      if (client === pool) emit()
      else committedTransition = emit
    }
    return result.rowCount ? due ?? false : now + 1
  }
  const keepAlive = async (due: number, reason: string) => {
    // A static provider timeout cannot resume a paused VM. Hold the same
    // run→machine lock order as resume/adopt while extending this exact epoch.
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [runId, actor.userId])
      const current = (await client.query(`SELECT state,epoch,"sandboxId",lifecycle FROM thread_machines
        WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE`, [runId, actor.userId, actor.workspaceId])).rows[0]
      if (!current || current.epoch !== row.epoch || current.sandboxId !== row.sandboxId || current.lifecycle.reconcileId !== token || ['paused', 'ended'].includes(current.state)) {
        await client.query('COMMIT')
        return now + 1
      }
      await deps.provider.keepAlive(row.sandboxId!, actor.userId, THREAD_MACHINE_PROVIDER_MS)
      providerOutcome = 'timeout_renewed'
      const next = await finish({ phase: reason === 'provisioning' ? 'provisioning' : 'active', reason, failures: 0, providerDeadline: deps.now() + THREAD_MACHINE_PROVIDER_MS,
        executionDeadline: threadMachineExecutionDeadline(row, now) }, due, client)
      await client.query('COMMIT')
      committedTransition?.()
      committedTransition = undefined
      return next
    } catch (error) { committedTransition = undefined; await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  try {
    if (row.status === 'queued' && row.stopRequestedAt && await deps.acknowledgeStop(pool, actor, runId)) {
      // True is returned only after provider kill acknowledgement and the
      // atomic retired write. Pending creation/failed kills retain their due row.
      return false
    }
    let provider: ThreadProviderInfo | null = null
    if (!row.sandboxId && !live(row.workerLeaseUntil, now) && pendingCreation(row) && row.operationId && deps.provider.findCreated) {
      const created = await deps.provider.findCreated(runId, actor.workspaceId, row.operationId, actor.userId)
      if (!created) {
        // A list response may briefly lag allocation creation. Reconfirm once
        // on a persisted deadline, keeping both the intent and an honest UI.
        const observedAt = deps.now(), missingAt = row.lifecycle.creationMissingAt ?? observedAt
        const missing = await pool.query(`UPDATE thread_machines SET state=CASE WHEN state='ended' THEN state ELSE 'error' END
          WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND lifecycle->>'reconcileId'=$5
            AND "operationId"=$6 AND "sandboxId" IS NULL
            AND ("workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=to_timestamp($7::double precision/1000)) RETURNING state`,
        [runId, actor.userId, actor.workspaceId, row.epoch, token, row.operationId, observedAt])
        if (!missing.rowCount) return now + 1
        row.state = missing.rows[0].state
        providerOutcome = 'missing'
        await (await import('@/lib/live/panels')).runChanged(pool, runId)
        return await finish({ phase: 'needs_reconciliation', reason: 'creation_cleanup_unconfirmed', creationMissingAt: missingAt },
          observedAt < missingAt + THREAD_MACHINE_STOP_GRACE_MS ? missingAt + THREAD_MACHINE_STOP_GRACE_MS : null)
      }
      const metadata: ThreadLifecycleMetadata = { phase: created.state === 'paused' ? 'paused' : 'created', reason: 'creation_recovered',
        computeSource: created.state === 'running' ? 'provider_started_at_estimate' : 'unconfirmed_creation_interval',
        ...(created.state === 'paused' ? { pausedAt: now } : {}) }
      // Discovery proves the allocation identity, not that this callback still
      // owns it. Clear the expired bootstrap token only with the same operation
      // and claim so a late create response cannot finish a replacement epoch.
      const restored = await pool.query(`WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR KEY SHARE)
        UPDATE thread_machines m SET "sandboxId"=$7,
          state=CASE WHEN state='ended' THEN state ELSE $8::text END,
          "runningSince"=CASE WHEN $8::text='running' THEN COALESCE("runningSince",to_timestamp($9::double precision/1000)) ELSE NULL END,
          "workerLeaseId"=NULL,"workerLeaseUntil"=NULL,
          lifecycle=(lifecycle-'creationMissingAt')||$10::jsonb||CASE WHEN state='ended' THEN '{"phase":"retire_requested"}'::jsonb ELSE '{}'::jsonb END
        FROM parent WHERE m."runId"=parent.id AND "ownerId"=$2 AND "workspaceId"=$3 AND epoch=$4 AND lifecycle->>'reconcileId'=$5
          AND "operationId"=$6 AND "sandboxId" IS NULL
          AND ("workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=to_timestamp($11::double precision/1000))
        RETURNING state,"runningSince","computeSeconds",lifecycle`,
      [runId, actor.userId, actor.workspaceId, row.epoch, token, row.operationId, created.sandboxId, created.state, created.startedAt,
        JSON.stringify(metadata), deps.now()])
      if (!restored.rowCount) return now + 1
      row.sandboxId = created.sandboxId
      Object.assign(row, restored.rows[0], { workerLeaseId: null, workerLeaseUntil: null })
      taskActivityChanged(pool, runId)
      provider = { state: created.state, endAt: created.endAt }
      logThreadLifecycle(row, { phase: row.lifecycle.phase, reason: 'creation_recovered', provider: created.state, deadline: claimUntil,
        computeSeconds: row.computeSeconds, computeSource: row.lifecycle.computeSource })
      await (await import('@/lib/live/panels')).runChanged(pool, runId)
      if (created.state === 'paused' && row.state !== 'ended' && (TERMINAL.has(row.status)
        || (row.status === 'queued' && !live(row.leaseExpiresAt, now))
        || (row.status === 'paused' && row.pauseReason === 'quota_exhausted' && row.safeExit)))
        await deps.park(pool, actor, runId, fenceOf(row))
    }
    provider ??= row.sandboxId ? await deps.provider.info(row.sandboxId, actor.userId) : null
    providerOutcome = provider?.state ?? 'not_observed'
    if (provider && provider.state !== 'missing' && !live(row.workerLeaseUntil, now) && row.state !== 'ended' && row.state !== provider.state) {
      // Resume/pause may have succeeded before the response or DB commit was
      // lost. Observe control-plane state without connect or identity changes.
      const updated = await pool.query(`WITH parent AS MATERIALIZED (SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$6 FOR KEY SHARE)
        UPDATE thread_machines m SET state=$5,
          "computeSeconds"="computeSeconds"+CASE WHEN $5='paused' THEN COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0) ELSE 0 END,
          "runningSince"=CASE WHEN $5='paused' THEN NULL ELSE COALESCE("runningSince",now()) END,
          lifecycle=CASE WHEN $5='running' THEN lifecycle-'pausedAt' ELSE lifecycle END
        FROM parent WHERE m."runId"=parent.id AND epoch=$2 AND "sandboxId"=$3 AND lifecycle->>'reconcileId'=$4 AND state<>'ended' RETURNING "runningSince","computeSeconds"`,
      [runId, row.epoch, row.sandboxId, token, provider.state, actor.userId])
      if (!updated.rowCount) return now + 1
      row.state = provider.state
      row.runningSince = updated.rows[0].runningSince
      row.computeSeconds = updated.rows[0].computeSeconds
      taskActivityChanged(pool, runId)
      if (provider.state === 'running') delete row.lifecycle.pausedAt
      await (await import('@/lib/live/panels')).runChanged(pool, runId)
      if (provider.state === 'paused' && (TERMINAL.has(row.status) || (row.status === 'queued' && !live(row.leaseExpiresAt, now))
        || (row.status === 'paused' && row.pauseReason === 'quota_exhausted' && row.safeExit)))
        await deps.park(pool, actor, runId, fenceOf(row))
    }
    const decision = threadMachineLifecycleDecision(row, provider, now)
    if (decision.action === 'retire') {
      phase = 'retire_failed'
      const result = await deps.end(pool, actor, runId, { ...fenceOf(row), ...(row.state === 'ended' ? {} : { requireClosedTask: true, requireArchived: true }) })
      if (result && typeof result === 'object' && 'state' in result && result.state !== 'ended')
        return finish({ phase: 'needs_reconciliation', reason: 'retirement_guard_refused' }, now + THREAD_MACHINE_REFRESH_MS)
      if (result && typeof result === 'object' && 'state' in result && result.state === 'ended') return false
      providerOutcome = 'kill_ack'
      // end clears sandboxId only after provider acknowledgement; its own
      // fenced write is authoritative, so do not overwrite it with this row.
      return await finish({ phase: 'retired', reason: decision.reason, failures: 0 }, null)
    }
    if (decision.action === 'pause') {
      phase = 'pause_failed'
      await deps.park(pool, actor, runId, { ...fenceOf(row), ...(decision.reason === 'stop_unacknowledged' ? { suspendAfterStop: true } : {}) })
      providerOutcome = 'pause_ack'
      if (TERMINAL.has(row.status)) await pool.query(`UPDATE suggestion_executions SET status=$2,"endedAt"=COALESCE("endedAt",now()) WHERE "runId"=$1`,
        [runId, row.status === 'succeeded' ? 'done' : row.status === 'cancelled' ? 'stopped' : row.status])
      return await finish({ phase: decision.reason === 'stop_unacknowledged' ? 'needs_reconciliation' : 'paused', reason: decision.reason, failures: 0, pausedAt: row.lifecycle.pausedAt ?? now },
        (row.lifecycle.pausedAt ?? now) + (row.taskClosed ? CLOSED_TASK_RETENTION_MS : THREAD_MACHINE_RETENTION_MS))
    }
    if (decision.action === 'stop' || decision.action === 'recover') {
      if (decision.action === 'recover') await deps.recover(pool, actor, row, now)
      if (!await deps.stop(pool, actor, row, decision.reason, token, deps.now()))
        return finish({ phase: 'needs_reconciliation', reason: 'execution_condition_changed' }, deps.now() + 1)
      observed.observedStop = true
      const stopAt = deps.now() + THREAD_MACHINE_STOP_GRACE_MS
      if (provider?.state === 'running' && row.state === 'running') return await keepAlive(stopAt, decision.reason)
      return await finish({ phase: 'needs_reconciliation', reason: decision.reason, observedStop: true }, stopAt)
    }
    if (decision.action === 'keep') return await keepAlive(decision.at!, decision.reason)
    if (decision.action === 'missing') {
      const missing = await pool.query(`UPDATE thread_machines SET state='error',"runningSince"=NULL,
          lifecycle=lifecycle||jsonb_build_object('providerMissingReceipt',$4::text),
          "computeSeconds"="computeSeconds"+COALESCE(GREATEST(0,EXTRACT(EPOCH FROM (clock_timestamp()-"runningSince")))::bigint,0)
        WHERE "runId"=$1 AND epoch=$2 AND "sandboxId"=$3 AND lifecycle->>'reconcileId'=$4 AND state<>'ended'
          AND "ownerId"=$5 AND "workspaceId"=$6`, [runId, row.epoch, row.sandboxId, token, actor.userId, actor.workspaceId])
      if (missing.rowCount) {
        taskActivityChanged(pool, runId)
        await (await import('@/lib/live/panels')).runChanged(pool, runId)
      }
    }
    return await finish({ phase: decision.reason === 'stage_handoff' ? 'handoff' : decision.reason === 'paused_retention' ? 'paused'
      : decision.reason === 'provisioning' ? 'provisioning' : decision.reason === 'retirement' && !row.sandboxId ? 'retired' : 'needs_reconciliation', reason: decision.reason, failures: 0,
      ...(decision.action === 'missing' ? { providerMissingAt: row.lifecycle.providerMissingAt ?? now } : {}),
      ...(provider?.state === 'paused' ? { pausedAt: row.lifecycle.pausedAt ?? now } : {}) }, decision.at)
  } catch (error) {
    const failures = Math.min((row.lifecycle.failures ?? 0) + 1, 16), retryAt = nextRetry(deps.now(), failures)
    // Persist only closed diagnostics, never provider messages, URLs or bodies.
    console.error('Thread machine reconciliation failed', { runId, epoch: row.epoch, phase, name: threadLifecycleErrorKind(error) })
    providerOutcome = 'unavailable'
    return finish({ phase, reason: 'operation_failed', failures }, retryAt)
  }
}
