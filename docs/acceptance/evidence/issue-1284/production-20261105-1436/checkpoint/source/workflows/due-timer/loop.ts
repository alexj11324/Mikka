import { createHook, sleep, type Hook } from 'workflow'
import { HookForceClaimedError } from 'workflow/errors'
import type { DueTimerClaim } from '@/lib/due-timer-deployment'
import { nudgeWorkflow } from '../wake'

/** Active timers rotate after this long. An idle timer waits for a real write,
 * then rotates before doing work when its lifetime has elapsed. */
export const DUE_TIMER_LIFETIME_MS = 6 * 60 * 60_000

export type DueTimerDeps = {
  /** Host steps: re-read the actual deployment/holder and retire a displaced Workflow. */
  prepareClaim(): Promise<DueTimerClaim>
  completeClaim(previousRunId?: string): Promise<void>
  /** Step: does due work, returning the earliest later due time, or null when idle. */
  run(): Promise<number | null>
  /** Step: starts a latest successor with the real predecessor identity. */
  handOff(): Promise<void>
}

/** Serialize new candidates while they inspect and claim the global hook.
 * Existing old timers do not know this election token, so force still uses
 * the SDK's atomic takeover and records the actual displaced owner. */
async function take(token: string, deps: DueTimerDeps): Promise<{ hook: Hook<unknown> } | null> {
  const election = createHook<unknown>({ token: `${token}:claim` })
  let wake = false
  try {
    if (await election.getConflict()) return null
    const claim = await deps.prepareClaim()
    if (claim.mode === 'yield') {
      wake = Boolean(claim.wake)
      return null
    }
    const hook = createHook<unknown>({ token, ...(claim.force ? { experimental_force: true } : {}) })
    try {
      if (await hook.getConflict()) { hook.dispose(); return null }
      await deps.completeClaim(claim.previousRunId)
      return { hook }
    } catch (error) { hook.dispose(); throw error }
  } finally {
    election.dispose()
    // A lifetime child may have lost this election. Wake its holder only after
    // releasing it, so the holder can start another legitimate successor.
    if (wake) await nudgeWorkflow(token)
  }
}

/** One durable timer per job. Keep its global hook while idle and throughout
 * a lifetime handoff: an old in-flight step or caller can still commit a wake,
 * but cannot reclaim an empty token and revive an old deployment. */
export async function runDueTimer(token: string, deps: DueTimerDeps, overdueMs = 1_000) {
  const capAt = Date.now() + DUE_TIMER_LIFETIME_MS
  const held = await take(token, deps)
  if (!held) return
  try {
    let next = await deps.run()
    for (;;) {
      if (Date.now() >= capAt) {
        // A child can lose a concurrent election. A real wake retries the
        // handoff while we retain the token; it is never a takeover ACK.
        // Only successor force (or Workflow cancellation) ends this wait.
        for (;;) { await deps.handOff(); await held.hook }
      }
      if (next === null) await held.hook
      else {
        // Retain each job's existing overdue cadence; no idle polling is added.
        const at = next <= Date.now() ? Date.now() + overdueMs : Math.max(next, Date.now() + 1_000)
        await Promise.race([held.hook, sleep(new Date(Math.min(at, capAt)))])
      }
      if (Date.now() < capAt) next = await deps.run()
    }
  } catch (error) {
    if (!HookForceClaimedError.is(error)) throw error
  } finally { held.hook.dispose() }
}
