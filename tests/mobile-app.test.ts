import assert from 'node:assert/strict'
import { test } from 'node:test'
import { outgoingKey, personalMessage, submissionBody, type Outgoing } from '../apps/mobile/lib/outbox'
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

test('a failed message stays with its words and photos until authorized readback', async () => {
  const { Window } = await import('happy-dom')
  const browser = new Window()
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { act, createElement, useState } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { useChatDeliveryState } = await import('../lib/hooks/chat-delivery-state')
  let delivery!: ReturnType<typeof useChatDeliveryState<Outgoing>>
  function Probe() {
    const [messages, setMessages] = useState<Outgoing[]>([])
    delivery = useChatDeliveryState(messages, setMessages, 'unconfirmed')
    return null
  }
  const root = createRoot(document.body)
  const scope = { botId: null, chatKey: 'coordinator', context: 1 }
  const photo = { uri: 'file:///photo.jpg', dataUrl: 'data:image/jpeg;base64,/9j/' }
  const first = personalMessage(outgoingKey(), '你好', [], scope)
  const second = personalMessage(outgoingKey(), '', [photo], scope)
  assert.notEqual(first.id, second.id)
  try {
    await act(async () => { root.render(createElement(Probe)) })
    await act(async () => {
      assert.equal(delivery.begin(first), true)
      assert.equal(delivery.begin(second), true)
    })
    assert.deepEqual(delivery.rows.map(row => row.phase), ['sending', 'sending'])
    await act(async () => {
      delivery.finish(first.id, { error: 'offline' })
      delivery.finish(second.id, { error: 'offline' })
    })
    assert.deepEqual(delivery.rows.map(row => [row.text, row.phase]), [['你好', 'failed'], ['', 'failed']])
    assert.deepEqual(delivery.rows[1].images, [photo])
    assert.deepEqual(submissionBody(delivery.rows[1]).images, [{ dataUrl: photo.dataUrl }])
    await act(async () => {
      assert.equal(delivery.begin(first), true)
      delivery.finish(first.id, { storedId: first.id })
    })
    assert.deepEqual(delivery.rows.map(row => row.phase), ['accepted', 'failed'])
    await act(async () => { delivery.setRows(current => current.filter(row => row.storedId !== first.id)) })
    assert.deepEqual(delivery.rows.map(row => row.id), [second.id])
  } finally {
    await act(async () => { root.unmount() })
    await browser.happyDOM.close()
  }
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
