import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// The Workflow runtime is replaced by a recorder: sleeps resolve at once and are
// logged with their target, hooks report a configurable conflict.
const trace: string[] = []
let conflict = false
let wakeNow = false
mock.module('workflow', { namedExports: {
  // A real Promise stands for the Hook's payload: it settles only when a write woke the token.
  createHook: () => Object.assign(new Promise(resolve => { if (wakeNow) { wakeNow = false; trace.push('woken'); resolve({}) } }),
    { getConflict: async () => (conflict ? { runId: 'holder' } : null), dispose: () => { trace.push('dispose') } }),
  sleep: async (at: Date) => { trace.push(`sleep:${at.getTime()}`) },
} })
mock.module(new URL('../wake.ts', import.meta.url).href, { namedExports: { nudgeWorkflow: async (token: string) => { trace.push(`nudge:${token}`) } } })

let runDueTimer: typeof import('./loop').runDueTimer, DUE_TIMER_LIFETIME_MS: number
before(async () => { ({ runDueTimer, DUE_TIMER_LIFETIME_MS } = await import('./loop')) })
const T0 = Date.UTC(2030, 0, 1)
beforeEach(() => { trace.length = 0; conflict = false; wakeNow = false; mock.timers.reset() })

function deps(runs: Array<number | null>, nexts: Array<number | null> = []) {
  return {
    run: async () => { const value = runs.shift() ?? null; trace.push(`run->${value}`); return value },
    next: async () => { const value = nexts.shift() ?? null; trace.push(`next->${value}`); return value },
    handOff: async () => { trace.push('handOff') },
  }
}

test('does the due work, sleeps exactly until the next due time, and ends when nothing is left', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  await runDueTimer('due-timer:test', deps([T0 + 60_000, T0 + 3_600_000, null]))
  assert.deepEqual(trace, [`run->${T0 + 60_000}`, `sleep:${T0 + 60_000}`, `run->${T0 + 3_600_000}`, `sleep:${T0 + 3_600_000}`, 'run->null', 'dispose', 'next->null'])
})

test('a write that committed while the timer let go is picked up, not left for the slow sweep', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  await runDueTimer('due-timer:test', deps([null, T0 + 5_000, null], [T0 + 5_000, null]))
  assert.deepEqual(trace, ['run->null', 'dispose', `next->${T0 + 5_000}`, `run->${T0 + 5_000}`, `sleep:${T0 + 5_000}`, 'run->null', 'dispose', 'next->null'])
})

test('a second run for the same token nudges the holder and ends without doing work', async () => {
  conflict = true
  await runDueTimer('due-timer:test', deps([T0]))
  assert.deepEqual(trace, ['dispose', 'nudge:due-timer:test'])
})

test('work already overdue (a backlog) waits at least one second, so it cannot spin', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  await runDueTimer('due-timer:test', deps([T0 - 10_000, null]))
  assert.deepEqual(trace.slice(0, 2), [`run->${T0 - 10_000}`, `sleep:${T0 + 1_000}`])
})

test('a write that wakes the hook ends the wait before the timer', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  wakeNow = true
  await runDueTimer('due-timer:test', deps([T0 + 3_600_000, null]))
  assert.ok(trace.includes('woken'))
})

test('a long-lived timer hands over to a fresh run at its lifetime cap', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  const next = T0 + DUE_TIMER_LIFETIME_MS + 60_000
  const runs = [next, next]
  await runDueTimer('due-timer:test', { ...deps(runs), run: async () => { const value = runs.shift() ?? null; trace.push(`run->${value}`); mock.timers.tick(DUE_TIMER_LIFETIME_MS / 2 + 1); return value } })
  // The first wait is capped at the lifetime, never past it; then the run hands over.
  assert.deepEqual(trace, [`run->${next}`, `sleep:${T0 + DUE_TIMER_LIFETIME_MS}`, `run->${next}`, 'dispose', 'handOff'])
})

test('work a pass could not clear waits the job\'s overdue interval, not one second', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  await runDueTimer('due-timer:test', deps([T0 - 1, T0 + 30_000, null]), 60_000)
  assert.deepEqual(trace.slice(0, 4), [`run->${T0 - 1}`, `sleep:${T0 + 60_000}`, `run->${T0 + 30_000}`, `sleep:${T0 + 30_000}`])
})
