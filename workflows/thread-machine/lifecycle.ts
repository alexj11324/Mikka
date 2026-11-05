import { maintainThreadMachine, pauseAtCap } from './steps'
import { workflowWakes } from '../wake'
import { wakeTokens } from '@/lib/workflow-wake-tokens'

/** 12 hours, the maximum lifetime GitHub Codespaces also enforces. The spend
 * guard counts wall-clock hours, so this bounds one machine's cost. */
export const THREAD_MACHINE_LIFETIME_MS = 12 * 60 * 60_000

/**
 * Workflow code (no directive): maintains a cloud run's thread machine until
 * its run ends, it is paused, `stillOwns` says no, or the 12-hour cap. A pass
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
  // Past the cap the machine is paused on purpose, never left to the provider's timeout.
  await pauseAtCap(actor, runId)
}
