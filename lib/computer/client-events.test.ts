import assert from 'node:assert/strict'
import { test } from 'node:test'

test('a real bot computer opens no event stream: the server never sends computer.* events', async () => {
  let opened = 0
  const global = globalThis as { EventSource?: unknown }
  const previous = global.EventSource
  global.EventSource = class { static CLOSED = 2; readyState = 0; constructor() { opened++ } addEventListener() {} removeEventListener() {} close() {} }
  try {
    const { subscribeComputerEvents } = await import('./client')
    const stop = subscribeComputerEvents(() => assert.fail('no real push exists'), false)
    stop()
    assert.equal(opened, 0)
  } finally { global.EventSource = previous }
})
