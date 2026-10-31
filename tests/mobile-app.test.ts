import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delivered, inFlight, marked, outgoingKey, queued } from '../apps/mobile/lib/outbox'
import { pushTarget } from '../apps/mobile/lib/push-route'

const BOT = '12345678-1234-1234-1234-123456789abc'
const ACTION = '22345678-1234-1234-1234-123456789abc'
const RUN = '32345678-1234-1234-1234-123456789abc'

test('a push opens the chat it came from', () => {
  assert.equal(pushTarget({ botId: null }), '/')
  assert.equal(pushTarget({ botId: BOT }), `/bots/${BOT}`)
  assert.equal(pushTarget(undefined), '/')
})

test('a push about a proposal opens its chat at the card', () => {
  assert.equal(pushTarget({ botId: null, pendingActionId: ACTION }), `/?action=${ACTION}`)
  assert.equal(pushTarget({ botId: BOT, pendingActionId: ACTION, runId: RUN }), `/bots/${BOT}?action=${ACTION}`)
})

test('a push about a finished thread opens the thread', () => {
  assert.equal(pushTarget({ botId: null, runId: RUN.toUpperCase() }), `/threads/${RUN}`)
})

test('ids that are not uuids are ignored', () => {
  assert.equal(pushTarget({ botId: '../settings', pendingActionId: 'x', runId: 42 }), '/')
})

test('a failed message stays with its words until it is delivered', () => {
  const a = outgoingKey()
  const b = outgoingKey()
  assert.notEqual(a, b)
  let list = queued(queued([], a, '你好'), b, '在吗')
  assert.equal(inFlight(list), true)
  list = marked(marked(list, a, 'failed'), b, 'failed')
  assert.deepEqual(list.map(item => [item.text, item.state]), [['你好', 'failed'], ['在吗', 'failed']])
  assert.equal(inFlight(list), false)
  list = delivered(marked(list, a, 'sending'), a)
  assert.deepEqual(list.map(item => item.text), ['在吗'])
})

test('a message with photos keeps them while it goes and after it fails', () => {
  const key = outgoingKey()
  const photo = { uri: 'file:///photo.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }
  let list = queued([], key, '', [photo])
  list = marked(list, key, 'failed')
  assert.deepEqual(list[0].images, [photo])
  assert.equal(list[0].text, '')
})
