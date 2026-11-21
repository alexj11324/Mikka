import { afterDatabaseCommit } from './db/commit-effects'
import { wakeTokens, wakeTransport, workflowWakesEnabled } from './workflow-wake'

/**
 * Jobs whose work carries a persisted due time (#1212 D). Instead of a minute
 * sweep, one durable timer per job (workflows/due-timer) does the work when it
 * is due; a write that makes work due sooner wakes it after COMMIT, or starts
 * it when none runs. The job's cron route stays as a slow reconciliation sweep
 * that only recovers a start lost between COMMIT and here.
 */
export type DueKind = 'schedules' | 'run-recovery' | 'account-deletions' | 'audit-retention'
export type DueJob = { run(): Promise<number | null>; next(): Promise<number | null> }

export const dueJobs: Record<DueKind, DueJob> = {
  schedules: {
    run: async () => { const { sweepSchedules, scheduleNextDue } = await import('./schedules/runtime'); await sweepSchedules(); return scheduleNextDue() },
    next: async () => (await import('./schedules/runtime')).scheduleNextDue(),
  },
  'run-recovery': {
    // Only the sweeps due now run (#1371); a pass with nothing due costs one statement.
    run: async () => (await import('./run-recovery-due')).runRecoveryPass(),
    next: async () => (await import('./run-recovery-due')).runRecoveryNextDue(),
  },
  'account-deletions': {
    run: async () => {
      const [{ sweepAccountDeletions }, { cleanupChatFiles }] = await Promise.all([import('./account/deletion-jobs'), import('./chat-attachments/store')])
      await sweepAccountDeletions()
      await cleanupChatFiles()
      return accountDeletionsNextDue()
    },
    next: () => accountDeletionsNextDue(),
  },
  'audit-retention': {
    run: async () => {
      const [{ deliverWorkspaceAudits }, { sweepAuditRetention }] = await Promise.all([import('./audit/delivery'), import('./audit/retention')])
      await deliverWorkspaceAudits()
      await (await import('./enterprise/maintenance')).maintainEnterpriseGovernance()
      await sweepAuditRetention()
      return auditRetentionNextDue()
    },
    next: () => auditRetentionNextDue(),
  },
}

async function accountDeletionsNextDue() {
  const [{ pool }, { nextAccountDeletionsDue }] = await Promise.all([import('./db'), import('./account-deletions-due')])
  return nextAccountDeletionsDue(pool)
}

async function auditRetentionNextDue() {
  const [{ pool }, { workspacePool }, { nextAuditRetentionDue }] = await Promise.all([import('./db'), import('./workspace-db'), import('./audit-retention-due')])
  const { nextEnterpriseMaintenanceDue } = await import('./enterprise/maintenance')
  const due = await Promise.all([nextAuditRetentionDue(pool, workspacePool), nextEnterpriseMaintenanceDue(pool, workspacePool)])
  const times = due.filter((value): value is number => value !== null)
  return times.length ? Math.min(...times) : null
}

/** The run holding a timer's token, and the deployment it is pinned to. */
export type DueTimerHolder = { runId: string; deploymentId: string }

/** Tests replace the Workflow calls here to observe timer starts, lookups and cancels without a Workflow world. */
export const dueTimerTransport: {
  start?: (kind: DueKind) => Promise<unknown>
  holder?: (token: string) => Promise<DueTimerHolder | null>
  latestDeployment?: () => Promise<string | undefined>
  cancel?: (runId: string) => Promise<unknown>
} = {}

const ENDED = new Set(['completed', 'failed', 'cancelled'])

async function timerHolder(token: string): Promise<DueTimerHolder | null> {
  if (dueTimerTransport.holder) return dueTimerTransport.holder(token)
  const { getHookByToken } = await import('workflow/api')
  let runId: string
  try { ({ runId } = await getHookByToken(token)) } catch { return null }
  const { getWorld } = await import('workflow/runtime')
  const run = await (await getWorld()).runs.get(runId, { resolveData: 'none' })
  return ENDED.has(run.status) ? null : { runId, deploymentId: run.deploymentId }
}

async function latestTimerDeployment() {
  if (dueTimerTransport.latestDeployment) return dueTimerTransport.latestDeployment()
  const { getWorld } = await import('workflow/runtime')
  const world = await getWorld()
  return world.resolveLatestDeploymentId?.()
}

async function startDueTimer(kind: DueKind) {
  if (dueTimerTransport.start) return dueTimerTransport.start(kind)
  const [{ start }, { dueTimer }] = await Promise.all([import('workflow/api'), import('@/workflows/due-timer/workflow')])
  if (process.env.VERCEL_DEPLOYMENT_ID) return start(dueTimer, [kind], { deploymentId: 'latest' })
  return start(dueTimer, [kind])
}

/** A bounded machine Workflow may exit only after another durable owner has
 * accepted responsibility. Unlike a request's best-effort wake, a failed
 * handoff propagates so the Workflow step remains retryable. */
export async function handoffRunRecoveryTimer(): Promise<void> {
  if (!workflowWakesEnabled()) return
  if (process.env.VERCEL_ENV === 'production') {
    await (await import('./due-timer-owner')).armCurrentRecoveryTimer()
    return
  }
  if (await replaceStaleDueTimer('run-recovery')) return
  try {
    const resume = wakeTransport.resume ?? (await import('workflow/api')).resumeHook
    await resume(wakeTokens.dueTimer('run-recovery'), {})
  } catch {
    await startDueTimer('run-recovery')
  }
}

/** Production run recovery elects and hands over its own owner (lib/due-timer-owner.ts, #1403); it is never cancelled here. */
const ownsItsDeployment = (kind: DueKind) => kind === 'run-recovery' && process.env.VERCEL_ENV === 'production'

/** Kinds this process has seen held by a run on its own deployment; checked once per process. */
const current = new Set<DueKind>()

/**
 * A timer run is pinned to the deployment that started it and keeps that code
 * for its whole life (#1410). Every kind but production run recovery, which owns its handover (#1403): The first arm of each kind in a process on a newer
 * deployment cancels a run on another deployment and starts its successor on the latest deployment.
 * The successor's first pass does whatever came due meanwhile. True when it
 * replaced one. Workflow API calls only, no database.
 */
export async function replaceStaleDueTimer(kind: DueKind): Promise<boolean> {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID
  if (!deploymentId || current.has(kind) || !workflowWakesEnabled() || ownsItsDeployment(kind)) return false
  const holder = await timerHolder(wakeTokens.dueTimer(kind))
  if (!holder) return false
  if (holder.deploymentId === deploymentId) {
    current.add(kind)
    return false
  }
  // An older instance can still receive a request after a rollout. Only the
  // latest deployment in this Workflow environment may replace another run.
  if (await latestTimerDeployment() !== deploymentId) return false
  if (dueTimerTransport.cancel) await dueTimerTransport.cancel(holder.runId)
  else await (await import('workflow/api')).getRun(holder.runId).cancel({ cancelReason: `due timer replaced by deployment ${deploymentId}` })
  await startDueTimer(kind)
  return true
}

/** replaceStaleDueTimer for every kind; never throws. */
export async function replaceStaleDueTimers() {
  await Promise.all((Object.keys(dueJobs) as DueKind[]).map(kind => replaceStaleDueTimer(kind).catch(error => {
    console.error('Due timer replacement failed', { kind, name: error instanceof Error ? error.name : typeof error })
    return false
  })))
}

/** Tests only: forget which kinds this process already checked. */
export function forgetCheckedDueTimers() { current.clear() }

/** Wakes the job's running timer, or starts one. Best effort: the slow sweep re-arms a lost start. */
export async function armDueTimer(kind: DueKind): Promise<void> {
  if (!workflowWakesEnabled()) return
  if (kind === 'run-recovery' && process.env.VERCEL_ENV === 'production') {
    try { await (await import('./due-timer-owner')).armCurrentRecoveryTimer() }
    catch (error) {
      const { CodedError, logCodedError } = await import('@mikka/protocol/coded-error')
      // A guard has already emitted its closed metadata at the failed check.
      if (!(error instanceof CodedError && error.code === 'due_timer_owner_unavailable')) {
        logCodedError(new CodedError('due_timer_owner_unavailable', { detail: 'sdk_operation_failed', cause: error }), { kind, phase: 'arm' })
      }
    }
    return
  }
  try {
    if (await replaceStaleDueTimer(kind)) return
  } catch (error) {
    console.error('Due timer replacement failed', { kind, name: error instanceof Error ? error.name : typeof error })
  }
  try {
    const resume = wakeTransport.resume ?? (await import('workflow/api')).resumeHook
    await resume(wakeTokens.dueTimer(kind), {})
    return
  } catch { /* no timer holds the token: start one */ }
  try {
    await startDueTimer(kind)
  } catch (error) {
    console.error('Due timer start failed', { kind, name: error instanceof Error ? error.name : typeof error })
  }
}

/** armDueTimer after the current request, for a write that has already committed. */
export function armDueTimerSoon(kind: DueKind) {
  if (!workflowWakesEnabled()) return
  void import('./background').then(({ afterJob }) => afterJob('after:due-timer', () => armDueTimer(kind), { orRun: true })).catch(() => {})
}

/** armDueTimer once this transaction commits; nothing on rollback. Never fails the write. */
export function armDueTimerAfterCommit(executor: object, kind: DueKind) {
  if (!workflowWakesEnabled()) return
  try {
    afterDatabaseCommit(executor, `due-timer:${kind}`, async () => {
      const { afterJob } = await import('./background')
      afterJob('after:due-timer', () => armDueTimer(kind), { orRun: true })
    })
  } catch { /* an executor without commit tracking: the slow sweep re-arms */ }
}
