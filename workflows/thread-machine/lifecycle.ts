import { maintainThreadMachine, handOffThreadMachine } from './steps'
import { workflowWakes } from '../wake'
import { wakeTokens } from '@/lib/workflow-wake-tokens'

/** Bounds this Workflow execution, not ownership of the persisted machine.
 * Execution spend and retention have separate persisted deadlines. */
export const THREAD_MACHINE_LIFETIME_MS = 12 * 60 * 60_000

/**
 * Workflow code (no directive): maintains a cloud run's thread machine until
 * its run ends, `stillOwns` says no, or ownership is handed to recovery. A pass
 * runs when the run changes (lib/live/panels.ts runChanged wakes the hook) or
 * at the machine's next real deadline, not every 30 s (#1212). The Workflow
 * clock is durable event time, so the cap survives replays.
 */
export async function maintainUntilCap(actor: { userId: string; workspaceId: string }, runId: string, stillOwns?: () => Promise<boolean>) {
  const capAt = Date.now() + THREAD_MACHINE_LIFETIME_MS
  const until = workflowWakes(wakeTokens.threadMachine(runId))
  while (Date.now() < capAt) {
    if (stillOwns && !await stillOwns()) return
    const next = await maintainThreadMachine(actor, runId)
    if (next === false) return
    await until(Math.min(next, capAt))
  }
  // A terminal change can land during the last wait (#957). Reconcile it
  // before retiring, and never let an old holder operate on its successor.
  if (stillOwns && !await stillOwns()) return
  const next = await maintainThreadMachine(actor, runId)
  if (next !== false) await handOffThreadMachine(actor, runId, next)
}
