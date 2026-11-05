import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { fakeWorkflowRuntime } from '../../tests/support/fake-workflow'

// Publication retries on a virtual Workflow clock: the first retry is as soon
// as before (30 s), later ones back off to a 10-minute cap (#1212).
const fake = fakeWorkflowRuntime()
mock.method(Date, 'now', fake.now)
mock.module('workflow', { namedExports: fake.exports })

let publishDoneAfter = 1, failDoneAfter = 1, publishThrows = false
const attempts: number[] = []
const publishResult = mock.fn(async () => {
  attempts.push(fake.now())
  if (publishThrows) throw new Error('publication step exhausted its retries')
  return { done: attempts.length >= publishDoneAfter }
})
const failResult = mock.fn(async () => { attempts.push(fake.now()); return { done: attempts.length >= failDoneAfter } })
const deliverResult = mock.fn(async () => {})
mock.module(new URL('./steps.ts', import.meta.url).href, { namedExports: { publishResult, failResult, deliverResult } })

let workflow: typeof import('./workflow')
before(async () => { workflow = await import('./workflow') })
beforeEach(() => {
  attempts.length = 0
  publishDoneAfter = 1; failDoneAfter = 1; publishThrows = false
  publishResult.mock.resetCalls(); failResult.mock.resetCalls(); deliverResult.mock.resetCalls()
})
const gaps = () => attempts.slice(1).map((at, i) => (at - attempts[i]) / 1000)

test('a publication that lands first time is delivered with no wait', async () => {
  await workflow.runPublication('run-1')
  assert.equal(publishResult.mock.callCount(), 1)
  assert.equal(deliverResult.mock.callCount(), 1)
  assert.equal(fake.pendingTimers(), 0)
})

test('the first retry is 30 s, as before; later retries double up to 10 minutes', async () => {
  publishDoneAfter = 8
  await Promise.all([workflow.runPublication('run-2'), fake.advance(60 * 60_000)])
  assert.deepEqual(gaps(), [30, 60, 120, 240, 480, 600, 600])
  assert.equal(deliverResult.mock.callCount(), 1)
})

test('a publication still not done after an hour has asked 10 times, where the 30 s loop asked 120 times', async () => {
  publishDoneAfter = Number.POSITIVE_INFINITY
  const running = workflow.runPublication('run-3')
  const start = fake.now()
  await fake.advance(60 * 60_000 - 1)
  assert.equal(attempts.filter(at => at - start < 60 * 60_000).length, 10)
  publishDoneAfter = 0
  await fake.advance(10 * 60_000)
  await running
})

test('when publishing gives up, failing the result backs off the same way and the result is still delivered', async () => {
  publishThrows = true
  failDoneAfter = 4
  await Promise.all([workflow.runPublication('run-4'), fake.advance(60 * 60_000)])
  assert.equal(publishResult.mock.callCount(), 1)
  assert.equal(failResult.mock.callCount(), 3)
  assert.deepEqual(gaps(), [0, 30, 60])
  assert.equal(deliverResult.mock.callCount(), 1)
})
