import type { DueKind } from '@/lib/due-timer'
import { wakeTokens } from '@/lib/workflow-wake-tokens'
import { runDueTimer } from './loop'
import { handOffDueTimer, nextDue, runDue } from './steps'

/** The durable timer of one reconciled job (lib/due-timer.ts). */
export async function dueTimer(kind: DueKind) {
  'use workflow'
  await runDueTimer(wakeTokens.dueTimer(kind), { run: () => runDue(kind), next: () => nextDue(kind), handOff: () => handOffDueTimer(kind) })
}
