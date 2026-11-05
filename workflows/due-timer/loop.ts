import { createHook, sleep, type Hook } from 'workflow'
import { nudgeWorkflow } from '../wake'
import type { RecoveryTimerClaim, RecoveryTimerState } from '@/lib/due-timer-owner'
import { DUE_TIMER_LIFETIME_MS } from '@/lib/workflow-wake-tokens'

/** A timer run hands over to a fresh run after this long, so a long-lived timer
 * picks up newly deployed code instead of replaying an old deployment's steps. */
export { DUE_TIMER_LIFETIME_MS }

export type DueTimerDeps = {
  /** Step: does the work due now; returns the epoch ms of the earliest work due later, or null when none is left. */
  run(): Promise<number | null>
  /** Step: the earliest due time without doing any work (null: none). */
  next(): Promise<number | null>
  /** Step: starts the successor run. */
  handOff(): Promise<void>
}

/** Takes the timer's token, or nudges whoever holds it and reports null (#1212).
 * Wrapped: a Hook is thenable, so returning it bare from an async function would wait for its first payload. */
async function take(token: string): Promise<{ hook: Hook<unknown> } | null> {
  const hook = createHook<unknown>({ token })
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
 */
export async function runDueTimer(token: string, deps: DueTimerDeps, overdueMs = 1_000) {
  const capAt = Date.now() + DUE_TIMER_LIFETIME_MS
  let held = await take(token)
  if (!held) return
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
    await Promise.race([held.hook, sleep(new Date(Math.min(at, capAt)))])
    next = await deps.run()
  }
}

type CurrentDueTimerDeps = {
  prepare(): Promise<RecoveryTimerClaim>
  retire(claim: RecoveryTimerClaim): Promise<RecoveryTimerState>
  current(): Promise<RecoveryTimerState>
  run(): Promise<number | null>
  handOff(claim: RecoveryTimerClaim): Promise<void>
  redirect(): Promise<void>
}

/** Production run recovery keeps an idle hook, not an idle polling loop. Real
 * wakes/deadlines check both the current deployment and the existing lifetime;
 * a successor atomically takes the global token before the old run lets go. */
export async function runCurrentDueTimer(token: string, electionToken: string, deps: CurrentDueTimerDeps, overdueMs: number) {
  const election = createHook<unknown>({ token: electionToken })
  let held: Hook<unknown> | undefined
  try {
    // Same-deployment candidates never force one another. The elected run's
    // first pass reads all writes committed before these candidate starts.
    // Do not nudge the global token here: it may still belong to old code.
    if (await election.getConflict()) return
    const claim = await deps.prepare()
    if (claim.state === 'handoff') { await deps.redirect(); return }
    if (claim.state === 'existing') {
      // The wake may start the retiring holder's successor before it returns.
      // Let that child take the election instead of losing its only wake.
      election.dispose()
      await nudgeWorkflow(token); return
    }
    held = createHook<unknown>({ token, experimental_force: true })
    if (await held.getConflict()) return
    let state = await deps.retire(claim)
    const events = held[Symbol.asyncIterator]()
    let notification: Promise<IteratorResult<unknown>> | undefined
    const notified = () => notification ??= events.next()
    for (;;) {
      if (state === 'lost') return
      if (state === 'handoff') {
        // A same-deployment successor needs the election token. Keep the
        // global token until it atomically takes over, including if starting
        // it fails: a cancelled old step may still run its afterCommit arm.
        election.dispose()
        for (;;) {
          try { await deps.handOff(claim) }
          catch {
            // error-cause: the step already exhausted its bounded SDK retries
            // with a closed error. Retain ownership; only a real later write
            // or cron wake retries handoff, without adding an idle poll.
          }
          await notified(); notification = undefined
        }
      }
      const next = await deps.run()
      if (next === null) {
        // No next()/database read, deadline or restart while idle.
        await notified(); notification = undefined
      } else {
        const at = next <= Date.now() ? Date.now() + overdueMs : Math.max(next, Date.now() + 1_000)
        const woke = await Promise.race([notified().then(() => true), sleep(new Date(at)).then(() => false)])
        if (woke) notification = undefined
      }
      state = await deps.current()
    }
  } catch (error) {
    // A hook takeover is a normal retirement, not a failed business pass.
    // Scope the SDK's cross-realm name check to our own two exact tokens.
    if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'HookForceClaimedError' &&
        'token' in error && (error.token === token || error.token === electionToken)) return
    throw error
  } finally { held?.dispose(); election.dispose() }
}
