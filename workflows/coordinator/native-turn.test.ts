import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { fakeWorkflowRuntime } from '../../tests/support/fake-workflow'

// The native turn's wait on a virtual Workflow clock: it re-reads when the
// device writes (the route resumes its hook), not every second (#1212).
const fake = fakeWorkflowRuntime()
mock.method(Date, 'now', fake.now)
mock.module('workflow', { namedExports: fake.exports })

let reply: string | null = null
const polls: number[] = []
const poll = mock.fn(async () => { polls.push(fake.now()); return reply === null ? { status: 'running', reply: null, calls: [] } : { status: 'completed', reply, calls: [] } })
const close = mock.fn(async () => {})
mock.module(new URL('./native-steps.ts', import.meta.url).href, { namedExports: { enqueue: async () => 'turn-1', poll, finishTool: async () => {}, close } })

import { nativeTurnToken } from './native-wake'
let turn: typeof import('./native-turn')
before(async () => { turn = await import('./native-turn') })
beforeEach(() => { reply = null; polls.length = 0; poll.mock.resetCalls(); close.mock.resetCalls() })
const run = (signal?: AbortSignal) => turn.nativeCoordinatorTurn('owner', 'holder', 0, { harness: 'codex', deviceId: 'device' } as never, () => ({}), 'bot', undefined, signal)

test('the device\'s reply is read on its wake, with no wait', async () => {
  const answer = run()
  await fake.advance(4_000)
  reply = 'Done.'
  const repliedAt = fake.now()
  fake.resume(nativeTurnToken('turn-1'))
  await fake.settle()
  assert.equal((await answer).text, 'Done.')
  assert.equal(polls.at(-1), repliedAt)
  assert.equal(polls.length, 2, 'one read at the start, one on the wake (the 1 s loop read 5 times by now)')
  assert.equal(close.mock.callCount(), 1)
})

test('a lost wake is covered by the 15 s re-read; an idle 3-minute turn reads 13 times, not 180, then times out', async () => {
  const lost = run()
  await fake.advance(2_000)
  reply = 'Late but there.'
  await fake.advance(turn.NATIVE_TURN_FALLBACK_MS)
  assert.equal((await lost).text, 'Late but there.')

  reply = null
  polls.length = 0
  const idle = run().then(() => assert.fail('an idle turn cannot succeed'), (error: Error) => error)
  await fake.advance(200_000)
  assert.match((await idle).message, /nativeCoordinatorTimedOut/)
  assert.equal(polls.length, 13)
})

test('停止 ends the wait at once', async () => {
  const stop = new AbortController()
  const answer = run(stop.signal)
  await fake.advance(3_000)
  stop.abort()
  await fake.settle()
  assert.equal((await answer).finishReason, 'stop')
  assert.equal(polls.length, 1)
})
