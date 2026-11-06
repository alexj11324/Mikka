import assert from 'node:assert/strict'
import { test } from 'node:test'
import { awaitTurnHolder } from './turn-holder'

function harness(states: { holder: string | null; waiting: boolean }[], listener: 'ok' | 'fail' = 'ok') {
  const log: string[] = []
  let clock = 0
  return { log, deps: {
    read: async () => { log.push('read'); return states.shift() ?? { holder: null, waiting: true } },
    listen: async () => { log.push('listen'); if (listener === 'fail') throw new Error('no direct session'); return { consume: () => log.push('consume'), close: async () => { log.push('close') } } },
    next: async (_listener: unknown, botId: string, ms: number) => { log.push(`next:${botId}:${ms}`); clock += 1_000 },
    now: () => clock,
  } }
}

test('a turn already holding the chat is returned at once, without listening', async () => {
  const { log, deps } = harness([{ holder: 'wrun_1', waiting: true }])
  assert.equal(await awaitTurnHolder('bot', 10_000, deps), 'wrun_1')
  assert.deepEqual(log, ['read'])
})

test('a message waiting for its turn: listen, read again, then read only when the turn takes the chat', async () => {
  const { log, deps } = harness([{ holder: null, waiting: true }, { holder: null, waiting: true }, { holder: 'wrun_2', waiting: true }])
  assert.equal(await awaitTurnHolder('bot', 10_000, deps), 'wrun_2')
  assert.deepEqual(log, ['read', 'listen', 'consume', 'read', 'next:bot:10000', 'consume', 'read', 'close'])
})

test('nothing waiting, no listener or the deadline: no stream, and no read on a timer', async () => {
  assert.equal(await awaitTurnHolder('bot', 10_000, harness([{ holder: null, waiting: false }]).deps), null)
  const failed = harness([{ holder: null, waiting: true }], 'fail')
  assert.equal(await awaitTurnHolder('bot', 10_000, failed.deps), null)
  assert.deepEqual(failed.log, ['read', 'listen', 'read'])
  const late = harness([])
  assert.equal(await awaitTurnHolder('bot', 2_000, late.deps), null)
  assert.equal(late.log.filter(entry => entry === 'read').length, 4)
  assert.equal(late.log.at(-1), 'close')
})
