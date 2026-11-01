import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delivered, inFlight, marked, outgoingKey, queued } from '../apps/mobile/lib/outbox'
import { pushTarget } from '../apps/mobile/lib/push-route'

const BOT = '12345678-1234-1234-1234-123456789abc'
const ACTION = '22345678-1234-1234-1234-123456789abc'
const RUN = '32345678-1234-1234-1234-123456789abc'

test('a push opens the chat it came from', () => {
  assert.equal(pushTarget({ botId: null }), '/bots/coordinator')
  assert.equal(pushTarget({ botId: BOT }), `/bots/${BOT}`)
  assert.equal(pushTarget(undefined), '/bots/coordinator')
})

test('a push about a proposal opens its chat at the card', () => {
  assert.equal(pushTarget({ botId: null, pendingActionId: ACTION }), `/bots/coordinator?action=${ACTION}`)
  assert.equal(pushTarget({ botId: BOT, pendingActionId: ACTION, runId: RUN }), `/bots/${BOT}?action=${ACTION}`)
})

test('a push about a finished thread opens the thread', () => {
  assert.equal(pushTarget({ botId: null, runId: RUN.toUpperCase() }), `/thread/${RUN}`)
})

test('ids that are not uuids are ignored', () => {
  assert.equal(pushTarget({ botId: '../settings', pendingActionId: 'x', runId: 42 }), '/bots/coordinator')
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

test('a sent message that quotes another shows the quote apart from its words', async () => {
  const { splitQuoted } = await import('../apps/mobile/lib/quote')
  assert.deepEqual(splitQuoted('> 关于你\n> 第二行\n\n好的'), { quoted: '关于你\n第二行', words: '好的' })
  assert.deepEqual(splitQuoted('没有引用'), { quoted: '', words: '没有引用' })
})

test('复制 copies a reply as words: Markdown marks, links and card source dropped', async () => {
  const { plainText } = await import('../apps/mobile/lib/quote')
  assert.equal(plainText('**故宫**和[天坛](https://x.dev)'), '故宫和天坛')
  assert.equal(plainText('看这几处。\nroot = Stack([TextContent("中轴线一天")])'), '看这几处。\n中轴线一天')
})
