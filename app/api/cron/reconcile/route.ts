import { withRecoveryCronAuthority } from '@/lib/enterprise/execution-authority'
import { cronUnauthorized } from '@/lib/cron-auth'
import { afterJob, cronJob } from '@/lib/background'
import { pool } from '@/lib/db'
import { reconcileDue } from '@/lib/reconcile-due'
import { armDueTimer, replaceStaleDueTimers } from '@/lib/due-timer'

export const runtime = 'nodejs'
// Run recovery's group-turn sweep keeps generating after the answer, as the run-recovery route does.
export const maxDuration = 300
const headers = { 'cache-control': 'no-store' }

/**
 * The single safety-net sweep (#1371), called every 15 minutes by the minute
 * Worker. Coordinator wakes, schedules, run recovery, account deletion and
 * audit retention and push receipts start from their writes and their durable timers; this recovers only work already due that none of
 * them picked up (a start lost between COMMIT and its wake, a timer that
 * failed). Worst case, such work runs 15 minutes after its due time. An idle
 * call costs two statements: one on the main database, one on the workspace
 * database for the audit outbox.
 */
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  // A timer still running an older deployment's code is replaced here even when no write arms it (#1410).
  // Workflow API calls only; once per kind per process.
  await replaceStaleDueTimers()
  try {
    const { factoryLifecycleEnabled } = await import('@/lib/factory/runtime')
    const { workspacePool } = await import('@/lib/workspace-db')
    const due = await reconcileDue(pool, { factoryLifecycle: factoryLifecycleEnabled(), workspace: workspacePool })
    const counts: Record<string, unknown> = { ...due }
    if (due.wakes) counts.wakeCounts = await (await import('@/lib/coordinator/wake')).retryCoordinatorWakes()
    if (due.schedules) {
      counts.scheduleCounts = await (await import('@/lib/schedules/runtime')).sweepSchedules()
      await armDueTimer('schedules')
    }
    if (due.deletions) {
      const [{ sweepAccountDeletions }, { cleanupChatFiles }] = await Promise.all([import('@/lib/account/deletion-jobs'), import('@/lib/chat-attachments/store')])
      counts.deletionCounts = { ...await sweepAccountDeletions(), attachments: await cleanupChatFiles() }
      await armDueTimer('account-deletions')
    }
    if (due.audit) {
      const [{ deliverWorkspaceAudits }, { sweepAuditRetention }] = await Promise.all([import('@/lib/audit/delivery'), import('@/lib/audit/retention')])
      counts.auditCounts = { delivery: await deliverWorkspaceAudits(), ...await sweepAuditRetention() }
      await armDueTimer('audit-retention')
    }
    if (due.recovery) {
      counts.recoveryCounts = await withRecoveryCronAuthority(request, async () => (await import('@/lib/run-recovery')).recoverRuns(work => afterJob('cron:reconcile/group-turns', () => withRecoveryCronAuthority(request, work))))
      await armDueTimer('run-recovery')
    }
    if (due.pushReceipts) counts.pushReceiptCounts = await (await import('@/lib/mobile-push-delivery')).recoverPhonePushReceipts()
    if (due.workspaceEphemera) counts.workspaceCleanup = await (await import('@/lib/coding-workspace/retention')).cleanupWorkspaceEphemera(pool)
    return Response.json(counts, { headers })
  }
  catch { return Response.json({ error: 'reconcileFailed' }, { status: 502, headers }) }
}

export const GET = cronJob('reconcile', handleGET)
