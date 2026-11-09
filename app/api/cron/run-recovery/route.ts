import { withRecoveryCronAuthority } from '@/lib/enterprise/execution-authority'
import { cronUnauthorized } from '@/lib/cron-auth'
import { afterJob, cronJob } from '@/lib/background'
import { recoverRuns } from '@/lib/run-recovery'
import { armDueTimer } from '@/lib/due-timer'
import { runRecoveryNextDue } from '@/lib/run-recovery-due'

export const runtime = 'nodejs'
// The group-turn sweep keeps generating after the answer, as a message request does.
export const maxDuration = 300
const headers = { 'cache-control': 'no-store' }

/** The cron Worker calls this every 15 minutes (#1212): the run-recovery due timer (lib/due-timer.ts) does the
 * work at its due time; this sweep recovers a timer start that was lost, and re-arms it. */
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try {
    const counts = await withRecoveryCronAuthority(request, () => recoverRuns(work => afterJob('cron:run-recovery/group-turns', () => withRecoveryCronAuthority(request, work))))
    if (await runRecoveryNextDue().catch(() => 0) !== null) await armDueTimer('run-recovery')
    return Response.json(counts, { headers })
  }
  catch { return Response.json({ error: 'runRecoverySweepFailed' }, { status: 502, headers }) }
}

export const GET = cronJob('run-recovery', handleGET)
