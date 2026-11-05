import { createHook, sleep, type Hook } from 'workflow'
import type { WakePayload } from '@/lib/workflow-wake'
import { nudgeWorkflow } from '../wake'

/** A timer run hands over to a fresh run after this long, so a long-lived timer
 * picks up newly deployed code instead of replaying an old deployment's steps. */
export const DUE_TIMER_LIFETIME_MS = 6 * 60 * 60_000

export type DueTimerDeps = {
  /** Step: does the work due now; returns the epoch ms of the earliest work due later, or null when none is left. */
  run(): Promise<number | null>
  /** Step: the earliest due time without doing any work (null: none). */
  next(): Promise<number | null>
  /** Step: starts the successor run on the latest deployment. */
  handOff(): Promise<void>
  /** Step: the deployment this run is pinned to (null outside Vercel). */
  deployment(): Promise<string | null>
}

/** Takes the timer's token, or nudges whoever holds it and reports null (#1212).
 * Wrapped: a Hook is thenable, so returning it bare from an async function would wait for its first payload. */
async function take(token: string): Promise<{ hook: Hook<WakePayload | undefined> } | null> {
  const hook = createHook<WakePayload | undefined>({ token })
  const conflict = await hook.getConflict().then(run => run !== null, () => true)
  if (!conflict) return { hook }
  hook.dispose()
  await nudgeWorkflow(token)
  return null
}

/**
 * Workflow code (no directive): the one durable timer of a job whose work has a
 * persisted due time (#1212). Each pass does what is due and sleeps until the
 * next due time or until a write wakes `token` (lib/due-timer.ts), whichever is
 * first. A second run for the same token nudges the holder and ends, so writes
 * never pile up timers. With nothing left the run ends: it releases the token
 * and then checks once more, so a write that committed while it was letting go
 * (and found the token still held) is not left for the slow sweep.
 *
 * A run is pinned to the deployment that started it. A wake sent by another
 * deployment (lib/due-timer.ts) means newer code is live: the run lets go of the
 * token and starts its successor on the latest deployment before doing any work,
 * as it also does at its lifetime cap (#1410).
 */
export async function runDueTimer(token: string, deps: DueTimerDeps, overdueMs = 1_000) {
  const capAt = Date.now() + DUE_TIMER_LIFETIME_MS
  let held = await take(token)
  if (!held) return
  const deployment = await deps.deployment()
  let next = await deps.run()
  for (;;) {
    if (next === null) {
      held.hook.dispose()
      if (await deps.next() === null) return
      held = await take(token)
      if (!held) return
      next = await deps.run()
      continue
    }
    if (Date.now() >= capAt) { held.hook.dispose(); await deps.handOff(); return }
    // Work still due after a pass (a backlog, or an item this pass could not clear) waits `overdueMs`,
    // so it cannot spin; anything later waits for its own time (at least one second).
    const at = next <= Date.now() ? Date.now() + overdueMs : Math.max(next, Date.now() + 1_000)
    const woke = await Promise.race([held.hook, sleep(new Date(Math.min(at, capAt)))])
    if (deployment && woke?.deploymentId && woke.deploymentId !== deployment) { held.hook.dispose(); await deps.handOff(); return }
    next = await deps.run()
  }
}
