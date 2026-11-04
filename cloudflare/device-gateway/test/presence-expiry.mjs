import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { connect, event, status } from './runtime.test.mjs'

// Optional wall-clock acceptance probe, deliberately separate from the fast
// CI suite. Run: node --test cloudflare/device-gateway/test/presence-expiry.mjs
test('an open socket expires after 90 seconds without pings and recovers on auto-pong', { timeout: 105_000 }, async () => {
  const socket = connect()
  await event(socket, 'open')
  const initial = await status()
  assert.equal(initial.online, true)

  await delay(95_000)
  assert.equal(socket.readyState, WebSocket.OPEN)
  const expired = await status()
  assert.equal(expired.online, false)
  assert.equal(expired.lastSeenAt, initial.lastSeenAt)

  const pong = event(socket, 'message')
  socket.send('ping')
  assert.equal((await pong).data, 'pong')
  const restored = await status()
  assert.equal(restored.online, true)
  assert.ok(Date.parse(restored.lastSeenAt) > Date.parse(initial.lastSeenAt))

  const closed = event(socket, 'close')
  socket.close()
  assert.equal((await closed).wasClean, true)
})
