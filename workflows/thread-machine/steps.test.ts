import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

class RetryableError extends Error {
  constructor(message: string, readonly options: { retryAfter: string }) { super(message) }
}
const pool = { fixture: true }
const reconcileThreadMachine = mock.fn(async (_pool: unknown, _actor: unknown, _runId: string): Promise<false | number> => 1234)
const handoffRunRecoveryTimer = mock.fn(async () => {})
mock.module('workflow', { namedExports: { RetryableError } })
mock.module(new URL('../../lib/db/index.ts', import.meta.url).href, { namedExports: { pool } })
mock.module(new URL('../../lib/cloud-computer/thread-lifecycle.ts', import.meta.url).href, { namedExports: { reconcileThreadMachine } })
mock.module(new URL('../../lib/due-timer.ts', import.meta.url).href, { namedExports: { handoffRunRecoveryTimer } })
let steps: typeof import('./steps')
before(async () => { steps = await import('./steps') })
const actor = { userId: 'owner', workspaceId: 'workspace' }
beforeEach(() => {
  reconcileThreadMachine.mock.resetCalls()
  reconcileThreadMachine.mock.mockImplementation(async () => 1234)
  handoffRunRecoveryTimer.mock.resetCalls()
  handoffRunRecoveryTimer.mock.mockImplementation(async () => {})
})

test('maintenance uses the shared scoped reconciliation and returns its persisted deadline', async () => {
  assert.equal(await steps.maintainThreadMachine(actor, 'run'), 1234)
  assert.deepEqual(reconcileThreadMachine.mock.calls[0].arguments, [pool, actor, 'run'])
})

test('a database failure retries with a sanitized Workflow error', async () => {
  reconcileThreadMachine.mock.mockImplementation(async () => { throw new Error('sensitive provider response') })
  await assert.rejects(steps.maintainThreadMachine(actor, 'run'), error => error instanceof RetryableError
    && error.message === 'thread_machine_maintenance_unavailable' && error.options.retryAfter === '1m')
  assert.equal(steps.maintainThreadMachine.maxRetries, 5)
})

test('handoff waits for the recovery owner acknowledgement', async () => {
  let release!: () => void
  handoffRunRecoveryTimer.mock.mockImplementation(() => new Promise<void>(resolve => { release = resolve }))
  let finished = false
  const handoff = steps.handOffThreadMachine(actor, 'run', 1234).then(() => { finished = true })
  while (!release) await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  release()
  await handoff
  assert.equal(finished, true)
})

test('a refused handoff retries instead of returning success', async () => {
  handoffRunRecoveryTimer.mock.mockImplementation(async () => { throw new Error('owner refused') })
  await assert.rejects(steps.handOffThreadMachine(actor, 'run', 1234), RetryableError)
  assert.equal(steps.handOffThreadMachine.maxRetries, 5)
})
