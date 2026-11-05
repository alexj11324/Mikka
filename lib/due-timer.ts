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
    // In a Workflow step the group-turn sweep runs inline: there is no request to run it after.
    run: async () => { const { recoverRuns } = await import('./run-recovery'); await recoverRuns(work => work()); return (await import('./run-recovery-due')).runRecoveryNextDue() },
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
  return nextAuditRetentionDue(pool, workspacePool)
}

/** Tests replace `start` here to observe timer starts without a Workflow world. */
export const dueTimerTransport: { start?: (kind: DueKind) => Promise<unknown> } = {}

/** Wakes the job's running timer, or starts one. Best effort: the slow sweep re-arms a lost start. */
export async function armDueTimer(kind: DueKind): Promise<void> {
  if (!workflowWakesEnabled()) return
  try {
    const resume = wakeTransport.resume ?? (await import('workflow/api')).resumeHook
    await resume(wakeTokens.dueTimer(kind), {})
    return
  } catch { /* no timer holds the token: start one */ }
  try {
    if (dueTimerTransport.start) { await dueTimerTransport.start(kind); return }
    const [{ start }, { dueTimer }] = await Promise.all([import('workflow/api'), import('@/workflows/due-timer/workflow')])
    await start(dueTimer, [kind])
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
