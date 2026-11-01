import assert from 'node:assert/strict'
import test from 'node:test'

import { CARD_LINE, chatLine } from '../lib/chat-line.ts'

test('a group row reads an OpenUI message as its words, never its source', () => {
  const line = chatLine({ group: { lastMessage: { body: 'root = Stack([intro])\nintro = TextContent("发版前有两个阻塞。")' } } })
  assert.equal(line, '发版前有两个阻塞。')
  assert.equal(chatLine({ group: { lastMessage: { body: 'root = LineChart(["10/25"], [{name: "失败率", values: [0]}], "%")' } } }), CARD_LINE)
  assert.equal(chatLine({ group: { lastMessage: { body: '大家同步一下阻塞' } } }), '大家同步一下阻塞')
  assert.equal(chatLine({ group: { lastMessage: null } }), null)
})

test('a bot row keeps the server line; an empty one is a card', () => {
  assert.equal(chatLine({ bot: { line: '好的' } }), '好的')
  assert.equal(chatLine({ bot: { line: '' } }), CARD_LINE)
  assert.equal(chatLine({ bot: { line: null } }), null)
})
