import 'server-only'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { Pool, PoolClient } from 'pg'
import { computerPermission } from '../computer/permission'
import { FactoryError } from '../factory/contract'
import { retainedDeliverableForRecovery, type ObserveRetainedDeliverable, type RetainedDeliverableScope, type RetainedDeliverableSnapshot } from '../factory/deliverable-recovery'
import { snapshotMatchesScope } from '../factory/deliverable-snapshot'
import type { FactoryTask } from '../factory/store'
import { retainedDeliverableProbeCommand } from './retained-deliverable-probe.mjs'
import { recordThreadMaintenanceSession } from './thread-machine-sessions'

type Budget = (maximumMs: number) => number
type ProbeOptions = { user: 'user'; timeoutMs: number; requestTimeoutMs: number; signal: AbortSignal }
type ProbeSandbox = { sandboxId: string; commands: { run(command: string, options: ProbeOptions): Promise<{ stdout: string; exitCode: number }> } }
export interface RetainedDeliverableRuntime {
  state(scope: RetainedDeliverableScope, budget: Budget): Promise<string>
  connect(scope: RetainedDeliverableScope, budget: Budget): Promise<ProbeSandbox>
  pause(scope: RetainedDeliverableScope, budget: Budget): Promise<void>
  script(): Promise<string>
  now(): number
  log(line: string): void
}
const unavailable = () => new FactoryError('factoryDeliverableSnapshotUnavailable')
const requestOptions = (budget: Budget, maximumMs: number) => {
  const requestTimeoutMs = budget(maximumMs)
  return { requestTimeoutMs, signal: AbortSignal.timeout(requestTimeoutMs), retries: 0 }
}
async function ownerOptions(scope: RetainedDeliverableScope) {
  const { e2bApiKey } = await import('../secrets/e2b-runtime')
  return { apiKey: await e2bApiKey(scope.ownerId, 'Cloud runtime unavailable'), proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy }
}
const defaultRuntime: RetainedDeliverableRuntime = {
  async state(scope, budget) {
    const [{ Sandbox }, { withE2BErrors }, options] = await Promise.all([import('e2b'), import('../secrets/e2b-runtime'), ownerOptions(scope)])
    const info = await withE2BErrors(scope.ownerId, false, () => Sandbox.getInfo(scope.sandboxId, { ...options, ...requestOptions(budget, 8_000) }))
    if (info.sandboxId !== scope.sandboxId || info.lifecycle?.onTimeout !== 'pause' || info.lifecycle?.autoResume !== false) throw unavailable()
    return info.state
  },
  async connect(scope, budget) {
    const [{ Sandbox }, { withE2BErrors }, options] = await Promise.all([import('e2b'), import('../secrets/e2b-runtime'), ownerOptions(scope)])
    return withE2BErrors(scope.ownerId, false, () => Sandbox.connect(scope.sandboxId, { ...options, timeoutMs: 60_000, ...requestOptions(budget, 10_000) }))
  },
  async pause(scope, budget) {
    const [{ Sandbox }, { withE2BErrors }, options] = await Promise.all([import('e2b'), import('../secrets/e2b-runtime'), ownerOptions(scope)])
    await withE2BErrors(scope.ownerId, false, () => Sandbox.pause(scope.sandboxId, { ...options, ...requestOptions(budget, 10_000) }))
  },
  script: () => readFile(join(process.cwd(), 'scripts/e2b/inspect-retained-deliverable.mjs'), 'utf8'),
  now: Date.now,
  log: line => console.warn(line),
}
const PROBE_CODES = new Set(['scope_mismatch', 'path_mismatch', 'journal_unavailable', 'journal_mismatch', 'active_run',
  'journal_binding_mismatch', 'journal_state_mismatch', 'git_unavailable', 'git_filter', 'dirty', 'index_flags',
  'checkpoint_mismatch', 'changed', 'probe_failed'].map(code => `retained_delivery_${code}`))

/** The task store supplies its canonical owner/access lock. No caller-provided
 * path, VM id or report becomes authority without the full locked DB reread. */
export function createRetainedDeliverableObserver(pool: Pool,
  lockTask: (tx: PoolClient, scope: RetainedDeliverableScope) => Promise<FactoryTask>,
  runtime: RetainedDeliverableRuntime = defaultRuntime): ObserveRetainedDeliverable {
  return async input => {
    const scope = structuredClone(input), leaseId = randomUUID(), started = runtime.now()
    const budgetUntil = (deadline: number): Budget => maximumMs => {
      const remaining = Math.min(maximumMs, Math.floor(deadline - runtime.now()))
      if (remaining <= 0) throw unavailable()
      return remaining
    }
    const workBudget = budgetUntil(started + 35_000), restoreBudget = budgetUntil(started + 55_000)
    const bounded = async <T>(budget: Budget, maximumMs: number, action: (budget: Budget) => Promise<T>): Promise<T> => {
      const ms = budget(maximumMs), operationBudget = budgetUntil(runtime.now() + ms)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([action(operationBudget), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(unavailable()), ms)
        })])
      } finally { clearTimeout(timer) }
    }
    const release = async () => {
      await bounded(budgetUntil(runtime.now() + 2_000), 2_000, () => pool.query(`UPDATE thread_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL
        WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND "operationId"=$5 AND "workerLeaseId"=$6`,
      [scope.machineRunId, scope.ownerId, scope.workspaceId, scope.sandboxId, scope.machineOperationId, leaseId]))
    }
    const markUnconfirmed = async () => {
      await bounded(budgetUntil(runtime.now() + 2_000), 2_000, () => pool.query(`UPDATE thread_machines SET state='error'
        WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND "operationId"=$5 AND "workerLeaseId"=$6 AND state<>'ended'`,
      [scope.machineRunId, scope.ownerId, scope.workspaceId, scope.sandboxId, scope.machineOperationId, leaseId]))
    }
    let leased = false, connectAttempted = false, connectConfirmed = false, confirmedPaused = false, initialStateMismatch = false
    let phase = 'admission', failure = false, probeCode: string | undefined, snapshot: RetainedDeliverableSnapshot | undefined
    const checkCustody = async (budget: Budget, acquire = false, observation?: 'running' | 'paused') => {
      let tx: PoolClient | undefined, abandoned = false, released = false
      const releaseClient = (error?: Error) => {
        if (tx && !released) { released = true; tx.release(error) }
      }
      try {
        await bounded(budget, 5_000, async transactionBudget => {
          tx = await pool.connect()
          if (abandoned) { releaseClient(unavailable()); throw unavailable() }
          try {
            await tx.query('BEGIN')
            await tx.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)", [`${transactionBudget(3_000)}ms`])
            await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${scope.workspaceId}`])
            const task = await lockTask(tx, scope)
            const policy = (await tx.query('SELECT permission FROM workspace_computer_policies WHERE "workspaceId"=$1', [scope.workspaceId])).rows[0]
            if (computerPermission(policy?.permission) !== 'allow') throw unavailable()
            const eligible = await retainedDeliverableForRecovery(tx, task, acquire ? undefined : leaseId)
            if (!eligible || !isDeepStrictEqual(eligible.scope, scope)) throw unavailable()
            // Session history's FK checks this run. Keep run→machine order
            // before taking custody, as the normal lifecycle writers do.
            await tx.query('SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR KEY SHARE', [scope.machineRunId,scope.ownerId])
            await tx.query(`SELECT "runId" FROM thread_machines
              WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR UPDATE`, [scope.machineRunId, scope.ownerId, scope.workspaceId])
            const locked = await retainedDeliverableForRecovery(tx, task, acquire ? undefined : leaseId)
            if (!locked || !isDeepStrictEqual(locked.scope, scope)) throw unavailable()
            transactionBudget(1)
            if (acquire) {
              const lease = await tx.query(`UPDATE thread_machines SET "workerLeaseId"=$6,"workerLeaseUntil"=clock_timestamp()+interval '3 minutes'
                WHERE "runId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "sandboxId"=$4 AND "operationId"=$5
                  AND "deviceId"=$7 AND "repoId"=$8 AND "snapshotId"=$9 AND state='paused'
                  AND ("workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=clock_timestamp()) RETURNING "runId"`,
              [scope.machineRunId, scope.ownerId, scope.workspaceId, scope.sandboxId, scope.machineOperationId, leaseId, scope.deviceId, scope.deviceRepoId, scope.machineSnapshotId])
              if (lease.rowCount !== 1) throw unavailable()
              // Also clean up this token if the COMMIT response is uncertain.
              leased = true
            }
            if (observation && !await recordThreadMaintenanceSession(tx, {
              runId: scope.machineRunId, ownerId: scope.ownerId, workspaceId: scope.workspaceId,
              sandboxId: scope.sandboxId, operationId: scope.machineOperationId,
            }, leaseId, observation)) throw unavailable()
            transactionBudget(1)
            await tx.query('COMMIT')
          } catch (error) { if (!released) await tx.query('ROLLBACK').catch(() => undefined); throw error }
          finally { releaseClient() }
        })
      } catch (error) {
        // A timed-out transaction must never continue on a reusable connection.
        // A late pool acquisition is destroyed before it may issue BEGIN.
        abandoned = true; releaseClient(unavailable()); throw error
      }
    }
    try {
      await checkCustody(workBudget, true)

      phase = 'provider_state'
      const state = await bounded(workBudget, 8_000, budget => runtime.state(scope, budget))
      if (state !== 'paused') { initialStateMismatch = true; throw unavailable() }
      phase = 'connect_custody'
      // This also closes any earlier uncertain interval at the first proven
      // pause observation, never at a guessed historical provider timestamp.
      await checkCustody(workBudget, false, 'paused')
      phase = 'connect'
      connectAttempted = true
      const sandbox = await bounded(workBudget, 10_000, budget => runtime.connect(scope, budget))
      if (sandbox.sandboxId !== scope.sandboxId) throw unavailable()
      connectConfirmed = true
      phase = 'running_custody'
      await checkCustody(workBudget, false, 'running')
      phase = 'script'
      const source = await bounded(workBudget, 3_000, () => runtime.script())
      if (!source || Buffer.byteLength(source, 'utf8') > 64 * 1024) throw unavailable()
      phase = 'probe_custody'
      await checkCustody(workBudget)
      phase = 'probe'
      const result = await bounded(workBudget, 25_000, async budget => {
        const requestTimeoutMs = budget(25_000), executionMs = requestTimeoutMs - 3_000
        if (executionMs <= 0) throw unavailable()
        const command = retainedDeliverableProbeCommand(source, {
          producerRunId: scope.producerRunId, producerSessionId: scope.producerSessionId, deviceId: scope.deviceId,
          deviceRepoId: scope.deviceRepoId, issueId: scope.issueId, repoPath: scope.repoPath, worktreePath: scope.worktreePath,
          sourceCommit: scope.sourceCommit, checkpoint: { files: scope.checkpoint.files, patchSha256: scope.checkpoint.patchSha256, patchBytes: scope.checkpoint.patchBytes },
          ...(scope.legacyQuestionSubmission ? { legacyQuestionSubmission: scope.legacyQuestionSubmission } : {}),
        })
        return sandbox.commands.run(`/usr/bin/timeout --signal=TERM --kill-after=2s ${(executionMs / 1000).toFixed(3)}s ${command}`,
          { user: 'user', timeoutMs: requestTimeoutMs, requestTimeoutMs, signal: AbortSignal.timeout(requestTimeoutMs) })
      })
      if (result.exitCode !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout, 'utf8') > 8192) throw unavailable()
      const response = JSON.parse(result.stdout)
      if (response?.ok !== true) {
        if (PROBE_CODES.has(response?.code)) probeCode = response.code
        throw unavailable()
      }
      const value = response.value
      const observed = { head: value?.head, tree: value?.tree, diffSha256: value?.diffSha256, diffBytes: value?.diffBytes,
        clean: value?.clean, observedAt: value?.observedAt, journalUpdatedAt: value?.journalUpdatedAt,
        producerRunId: value?.producerRunId, sessionId: value?.sessionId, worktreePath: value?.worktreePath,
        sandboxId: scope.sandboxId, machineRunId: scope.machineRunId } as RetainedDeliverableSnapshot
      if (!snapshotMatchesScope(scope, observed) || Date.parse(observed.observedAt) < started - 60_000 || Date.parse(observed.observedAt) > runtime.now() + 60_000) throw unavailable()
      snapshot = observed
    } catch { failure = true }

    // Only the current custodian may restore this recorded VM. Owner end or a
    // newer operation wins; never pause an unrelated returned sandbox object.
    if (connectAttempted) {
      let restorePhase = 'pause_custody'
      try {
        await checkCustody(restoreBudget)
        restorePhase = 'restore_pause'
        await bounded(restoreBudget, 10_000, budget => runtime.pause(scope, budget))
        restorePhase = 'pause_state_custody'
        await checkCustody(restoreBudget)
        restorePhase = 'pause_state'
        if (await bounded(restoreBudget, 8_000, budget => runtime.state(scope, budget)) !== 'paused') throw unavailable()
        confirmedPaused = true
        restorePhase = 'post_pause_custody'
        await checkCustody(restoreBudget, false, 'paused')
      } catch { confirmedPaused = false }
      if (!confirmedPaused) { failure = true; phase = restorePhase; snapshot = undefined }
    }
    // An aborted client wait does not prove the remote resume was cancelled.
    // A late connect may follow the paused read: retain error + lease, never
    // accept a snapshot or schedule unowned background provider operations.
    if (leased && ((connectAttempted && (!confirmedPaused || !connectConfirmed)) || initialStateMismatch)) {
      await markUnconfirmed().catch(() => undefined)
    }
    if (failure && leased && (!connectAttempted || (connectConfirmed && confirmedPaused))) {
      await release().catch(() => undefined)
    }
    if (failure || !snapshot || !confirmedPaused) {
      try { runtime.log(JSON.stringify({ event: 'retained_deliverable_observation_failed', runId: scope.machineRunId, phase, ...(probeCode ? { code: probeCode } : {}) })) } catch { /* Diagnostics never change the recovery outcome. */ }
      throw unavailable()
    }
    return { snapshot, leaseId, release }
  }
}
