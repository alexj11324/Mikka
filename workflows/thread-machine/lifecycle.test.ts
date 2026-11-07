import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { fakeWorkflowRuntime } from '../../tests/support/fake-workflow'

// The lifecycle's wait loop on a virtual clock: maintenance runs on a wake (the
// run row changed) or at the step's next deadline, never every 30 s (#1212).
const fake = fakeWorkflowRuntime()
mock.method(Date, 'now', fake.now)
mock.module('workflow', { namedExports: fake.exports })
mock.module('workflow/api', { namedExports: { resumeHook: async (token: string) => fake.resume(token) } })

const FALLBACK = 5 * 60_000
let ended = false
let next: (now: number) => number = now => now + FALLBACK
const passes: number[] = []
const maintainThreadMachine = mock.fn(async () => { passes.push(fake.now()); return ended ? false as const : next(fake.now()) })
const pauseAtCap = mock.fn(async () => {})
const handOffThreadMachine = mock.fn(async (_actor: unknown, _runId: string, _next: number) => {})
mock.module(new URL('./steps.ts', import.meta.url).href, { namedExports: { maintainThreadMachine, pauseAtCap, handOffThreadMachine, MAINTENANCE_FALLBACK_MS: FALLBACK } })

import { wakeTokens } from '../../lib/workflow-wake-tokens'
let maintainUntilCap: typeof import('./lifecycle')['maintainUntilCap']
let THREAD_MACHINE_LIFETIME_MS: number
before(async () => ({ maintainUntilCap, THREAD_MACHINE_LIFETIME_MS } = await import('./lifecycle')))
const actor = { userId: 'owner', workspaceId: 'workspace' }

beforeEach(() => {
  ended = false
  next = now => now + FALLBACK
  passes.length = 0
  maintainThreadMachine.mock.resetCalls()
  pauseAtCap.mock.resetCalls()
  handOffThreadMachine.mock.resetCalls()
  handOffThreadMachine.mock.mockImplementation(async () => {})
})

test('an idle live machine is maintained at its deadlines: 13 passes in an hour where the 30 s loop made 120', async () => {
  const start = fake.now()
  const lifecycle = maintainUntilCap(actor, 'run-idle')
  await fake.advance(60 * 60_000)
  assert.equal(passes.length, 13, 'one at start, then one per 5 min fallback')
  assert.ok(passes.every((at, i) => i === 0 || at - passes[i - 1] === FALLBACK))
  ended = true
  await fake.advance(FALLBACK)
  await lifecycle
  assert.equal(pauseAtCap.mock.callCount(), 0)
  assert.ok(fake.now() - start < THREAD_MACHINE_LIFETIME_MS)
})

test('a run that ends wakes the lifecycle at once: the machine is ended on the wake, sooner than the old 30 s step', async () => {
  const lifecycle = maintainUntilCap(actor, 'run-ends')
  await fake.advance(2 * 60_000)
  const endedAt = fake.now()
  ended = true
  fake.resume(wakeTokens.threadMachine('run-ends'))
  await fake.settle()
  await lifecycle
  assert.equal(passes.length, 2)
  assert.equal(passes[1], endedAt, 'the ending pass ran at the wake, with no wait')
})

test('a lost wake still reaches the final state: the run that ended is noticed at the fallback deadline', async () => {
  const lifecycle = maintainUntilCap(actor, 'run-lost-wake')
  await fake.advance(60_000)
  ended = true // ...but its wake never arrives
  await fake.advance(FALLBACK)
  await lifecycle
  assert.equal(passes.length, 2)
  assert.equal(passes[1] - passes[0], FALLBACK)
})

test('a queued idle machine is paused at its own idle deadline, not up to 30 s later', async () => {
  const idleAt = fake.now() + 3 * 60_000 + 17_000
  next = now => now >= idleAt ? Number.NaN : Math.min(idleAt, now + FALLBACK)
  maintainThreadMachine.mock.mockImplementation(async () => { passes.push(fake.now()); return fake.now() >= idleAt ? false as const : next(fake.now()) })
  await Promise.all([maintainUntilCap(actor, 'run-queued'), fake.advance(10 * 60_000)])
  assert.deepEqual(passes.map(at => at - passes[0]), [0, idleAt - passes[0]])
  maintainThreadMachine.mock.mockImplementation(async () => { passes.push(fake.now()); return ended ? false as const : next(fake.now()) })
})

test('wakes that land during a pass are kept: the next wait returns at once', async () => {
  const token = wakeTokens.threadMachine('run-busy')
  let wakeDuring = false
  maintainThreadMachine.mock.mockImplementation(async () => {
    passes.push(fake.now())
    if (wakeDuring) { wakeDuring = false; fake.resume(token) }
    return ended ? false as const : fake.now() + FALLBACK
  })
  const lifecycle = maintainUntilCap(actor, 'run-busy')
  await fake.settle()
  wakeDuring = true
  fake.resume(token) // second pass, during which the row changes again
  await fake.settle()
  assert.equal(passes.length, 3, 'the wake from inside the second pass ran a third at once')
  ended = true
  fake.resume(token)
  await fake.settle()
  await lifecycle
  assert.ok(passes.every(at => at === passes[0]), 'no pass waited for a timer')
  maintainThreadMachine.mock.mockImplementation(async () => { passes.push(fake.now()); return ended ? false as const : next(fake.now()) })
})

test('a second execution for the same run nudges the holder; the 12-hour cap hands the final maintenance deadline to recovery', async () => {
  const holder = maintainUntilCap(actor, 'run-twice')
  await fake.settle()
  let ownsSecond = true
  const second = maintainUntilCap(actor, 'run-twice', async () => ownsSecond)
  for (let i = 0; i < 5; i++) await fake.settle()
  // The nudge goes through a step's dynamic import; give it real time to land.
  for (let i = 0; i < 200 && passes.length < 3; i++) { await new Promise(resolve => setTimeout(resolve, 10)); await fake.settle() }
  const firstPasses = passes.length
  assert.ok(firstPasses >= 3, 'the holder was nudged into a fresh pass by the second execution')
  ownsSecond = false
  await fake.advance(FALLBACK)
  await second
  ended = true
  fake.resume(wakeTokens.threadMachine('run-twice'))
  await fake.settle()
  await holder

  ended = false
  passes.length = 0
  const capped = maintainUntilCap(actor, 'run-capped')
  await fake.advance(THREAD_MACHINE_LIFETIME_MS + FALLBACK)
  await capped
  assert.equal(pauseAtCap.mock.callCount(), 0)
  assert.equal(handOffThreadMachine.mock.callCount(), 1)
  assert.equal(passes.length, THREAD_MACHINE_LIFETIME_MS / FALLBACK + 1, '144 ordinary passes and one final reconciliation at the cap')
})

test('#957: a terminal transition during the last wait is reconciled before the cap exits', async () => {
  const capAt = fake.now() + THREAD_MACHINE_LIFETIME_MS
  next = () => capAt
  const lifecycle = maintainUntilCap(actor, 'run-terminal-at-cap')
  await fake.settle()
  ended = true
  await fake.advance(THREAD_MACHINE_LIFETIME_MS)
  await lifecycle
  assert.deepEqual(passes, [capAt - THREAD_MACHINE_LIFETIME_MS, capAt])
  assert.equal(handOffThreadMachine.mock.callCount(), 0, 'the final maintenance pass completed the run')
  assert.equal(pauseAtCap.mock.callCount(), 0)
})

test('#957: an active machine at the cap is handed to durable recovery with its next deadline', async () => {
  const capAt = fake.now() + THREAD_MACHINE_LIFETIME_MS
  next = now => now === capAt ? capAt + FALLBACK : capAt
  const lifecycle = maintainUntilCap(actor, 'run-active-at-cap')
  await fake.advance(THREAD_MACHINE_LIFETIME_MS)
  await lifecycle
  assert.equal(passes.at(-1), capAt)
  assert.deepEqual(handOffThreadMachine.mock.calls[0]?.arguments, [actor, 'run-active-at-cap', capAt + FALLBACK])
  assert.equal(pauseAtCap.mock.callCount(), 0, 'a monitor lifetime never authorizes pausing a live CLI')
})

test('#957: a refused handoff fails the step instead of silently completing the lifecycle', async () => {
  const capAt = fake.now() + THREAD_MACHINE_LIFETIME_MS
  next = () => capAt + FALLBACK
  handOffThreadMachine.mock.mockImplementation(async () => { throw new Error('owner unavailable') })
  const failure = assert.rejects(maintainUntilCap(actor, 'run-handoff-refused'), /owner unavailable/)
  await fake.advance(THREAD_MACHINE_LIFETIME_MS)
  await failure
  assert.equal(handOffThreadMachine.mock.callCount(), 1)
})

test('ownership lost during the final wait cannot reconcile or hand off a replacement owner', async () => {
  let owns = true
  next = () => fake.now() + THREAD_MACHINE_LIFETIME_MS
  const lifecycle = maintainUntilCap(actor, 'run-stale-at-cap', async () => owns)
  await fake.settle()
  owns = false
  await fake.advance(THREAD_MACHINE_LIFETIME_MS)
  await lifecycle
  assert.equal(passes.length, 1)
  assert.equal(handOffThreadMachine.mock.callCount(), 0)
  assert.equal(pauseAtCap.mock.callCount(), 0)
})
