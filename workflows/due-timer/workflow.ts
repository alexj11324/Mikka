import type { DueKind } from '@/lib/due-timer'
import { wakeTokens } from '@/lib/workflow-wake-tokens'
import { runDueTimer } from './loop'
import { handOffDueTimer, nextDue, runDue } from './steps'

/** How long work still due after a pass waits: schedules drain a backlog; run recovery retries what it
 * could not clear (a failed kill, an unreachable device) at the minute cadence the old sweep had. */
const OVERDUE_MS: Record<DueKind, number> = { schedules: 1_000, 'run-recovery': 60_000 }

/** The durable timer of one reconciled job (lib/due-timer.ts). */
export async function dueTimer(kind: DueKind) {
  'use workflow'
  await runDueTimer(wakeTokens.dueTimer(kind), { run: () => runDue(kind), next: () => nextDue(kind), handOff: () => handOffDueTimer(kind) }, OVERDUE_MS[kind])
}
