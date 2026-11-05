import type { DueKind } from '@/lib/due-timer'
import { wakeTokens } from '@/lib/workflow-wake-tokens'
import { runDueTimer } from './loop'
import { completeDueTimerClaim, handOffDueTimer, prepareDueTimerClaim, runDue } from './steps'

/** How long work still due after a pass waits: schedules drain a backlog; run recovery retries what it
 * could not clear (a failed kill, an unreachable device) at the minute cadence the old sweep had; account
 * deletion retries a step another holder still has locked, or a failed object delete, and audit retention a
 * delivery the main store refused or a workspace under an active export, every 15 minutes. */
const OVERDUE_MS: Record<DueKind, number> = { schedules: 1_000, 'run-recovery': 60_000, 'account-deletions': 15 * 60_000, 'audit-retention': 15 * 60_000 }

/** The durable timer of one reconciled job (lib/due-timer.ts). */
export async function dueTimer(kind: DueKind, predecessorRunId?: string) {
  'use workflow'
  await runDueTimer(wakeTokens.dueTimer(kind), {
    prepareClaim: () => prepareDueTimerClaim(kind, predecessorRunId),
    completeClaim: previousRunId => completeDueTimerClaim(kind, previousRunId),
    run: () => runDue(kind),
    handOff: () => handOffDueTimer(kind),
  }, OVERDUE_MS[kind])
}
