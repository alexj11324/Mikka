import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

// Controlled Workflow hook queues: a wake is consumed once; force rejects every
// later await. No real Workflow world or clock sleep is used.
const trace: string[] = []
let conflict = false
let wakeNow = false
let active: TestHook | undefined
class Forced extends Error { static is(error: unknown) { return error instanceof Forced } }
class TestHook {
  private pending: Array<{ resolve(value: unknown): void; reject(error: unknown): void }> = []
  private payloads = 0
  private forced = false
  private inFlight: Promise<unknown> | undefined
  constructor(readonly token: string) {
    if (!token.endsWith(':claim')) {
      if (wakeNow) { wakeNow = false; this.payloads++ }
    }
  }
  async getConflict() { return null }
  dispose() { if (!this.token.endsWith(':claim')) trace.push('dispose') }
  wake() { const next = this.pending.shift(); if (next) next.resolve({}); else this.payloads++ }
  stop() { this.forced = true; for (const next of this.pending.splice(0)) next.reject(new Forced()) }
  // oxlint-disable-next-line unicorn/no-thenable -- Workflow Hooks deliberately consume one queued event per await.
  then<T>(resolve: (value: unknown) => T, reject: (error: unknown) => T) {
    if (!this.inFlight) {
      const value = this.forced ? Promise.reject(new Forced()) : this.payloads ? (this.payloads--, trace.push('woken'), Promise.resolve({})) : new Promise((yes, no) => { this.pending.push({ resolve: yes, reject: no }) })
      this.inFlight = value
      void value.then(() => { if (this.inFlight === value) this.inFlight = undefined }, () => { if (this.inFlight === value) this.inFlight = undefined })
    }
    return this.inFlight.then(resolve, reject)
  }
}
mock.module('workflow', { namedExports: {
  createHook: ({ token }: { token: string }) => { const hook = new TestHook(token); if (!token.endsWith(':claim')) active = hook; return hook },
  sleep: async (at: Date) => { trace.push(`sleep:${at.getTime()}`) },
} })
mock.module('workflow/errors', { namedExports: { HookForceClaimedError: Forced } })
mock.module(new URL('../wake.ts', import.meta.url).href, { namedExports: { nudgeWorkflow: async (token: string) => { trace.push(`nudge:${token}`) } } })

let runDueTimer: typeof import('./loop').runDueTimer, DUE_TIMER_LIFETIME_MS: number
before(async () => { ({ runDueTimer, DUE_TIMER_LIFETIME_MS } = await import('./loop')) })
const T0 = Date.UTC(2030, 0, 1)
const flush = () => new Promise<void>(resolve => setImmediate(resolve))
beforeEach(() => { trace.length = 0; conflict = false; wakeNow = false; active = undefined; mock.timers.reset() })
function deps(runs: Array<number | null>) {
  return {
    prepareClaim: async () => conflict ? { mode: 'yield' as const, wake: true } : { mode: 'acquire' as const },
    completeClaim: async () => {},
    run: async () => { const value = runs.shift() ?? null; trace.push(`run->${value}`); return value },
    handOff: async () => { trace.push('handOff') },
  }
}
async function finish(done: Promise<unknown>) { active?.stop(); await done }

test('does the due work, sleeps exactly until the next due time, and retains the idle hook', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  const done = runDueTimer('due-timer:test', deps([T0 + 60_000, T0 + 3_600_000, null]))
  try {
    await flush()
    assert.deepEqual(trace, [`run->${T0 + 60_000}`, `sleep:${T0 + 60_000}`, `run->${T0 + 3_600_000}`, `sleep:${T0 + 3_600_000}`, 'run->null'])
  } finally { await finish(done) }
})

test('a write while idle wakes the retained hook without a release/re-take window', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  const done = runDueTimer('due-timer:test', deps([null, T0 + 5_000, null]))
  try {
    await flush()
    assert.deepEqual(trace, ['run->null'])
    active!.wake()
    await flush()
    assert.deepEqual(trace, ['run->null', `run->${T0 + 5_000}`, `sleep:${T0 + 5_000}`, 'run->null'])
  } finally { await finish(done) }
})

test('a second run for the same current token nudges the holder and ends without doing work', async () => {
  conflict = true
  await runDueTimer('due-timer:test', deps([T0]))
  assert.deepEqual(trace, ['nudge:due-timer:test'])
})

test('work already overdue (a backlog) waits at least one second, so it cannot spin', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  const done = runDueTimer('due-timer:test', deps([T0 - 10_000, null]))
  try { await flush(); assert.deepEqual(trace.slice(0, 2), [`run->${T0 - 10_000}`, `sleep:${T0 + 1_000}`]) }
  finally { await finish(done) }
})

test('a write that wakes the hook ends the wait before the timer', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  wakeNow = true
  const done = runDueTimer('due-timer:test', deps([T0 + 3_600_000, null]))
  try { await flush(); assert.ok(trace.includes('woken')) }
  finally { await finish(done) }
})

test('a long-lived timer starts its successor at the cap while keeping the global hook', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  const next = T0 + DUE_TIMER_LIFETIME_MS + 60_000
  const runs = [next, next]
  const done = runDueTimer('due-timer:test', { ...deps(runs), run: async () => { const value = runs.shift() ?? null; trace.push(`run->${value}`); mock.timers.tick(DUE_TIMER_LIFETIME_MS / 2 + 1); return value } })
  try {
    await flush()
    assert.deepEqual(trace, [`run->${next}`, `sleep:${T0 + DUE_TIMER_LIFETIME_MS}`, `run->${next}`, 'handOff'])
    active!.wake()
    await flush()
    assert.equal(trace.filter(item => item === 'handOff').length, 2, 'a real wake retries a lost handoff without releasing the global token')
    assert.equal(trace.includes('dispose'), false)
  } finally { await finish(done) }
})

test("work a pass could not clear waits the job's overdue interval, not one second", async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 })
  const done = runDueTimer('due-timer:test', deps([T0 - 1, T0 + 30_000, null]), 60_000)
  try { await flush(); assert.deepEqual(trace.slice(0, 4), [`run->${T0 - 1}`, `sleep:${T0 + 60_000}`, `run->${T0 + 30_000}`, `sleep:${T0 + 30_000}`]) }
  finally { await finish(done) }
})
