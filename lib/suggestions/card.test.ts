import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUGGESTION_ACTIONS, SUGGESTION_SOURCES } from '@/lib/db/schema'
import { chatItems } from '@/lib/coordinator/context'
import { withQuote } from '@/lib/artifacts/quote'
import { CARD_ACTIONS, CARD_SOURCES, cardParts, splitSuggestion, withSuggestion, type SuggestionCard } from './card'

const at = new Date('2026-10-28T00:00:00Z')
const card: SuggestionCard = { source: 'gmail', action: 'reply', title: 'Re: 周四的会 <urgent> & "now"', actionTitle: '回复 Kevin 的 Gmail 邮件：周四的会改到周三' }

test('the card lists match the schema', () => {
  assert.deepEqual([...CARD_SOURCES], [...SUGGESTION_SOURCES])
  assert.deepEqual([...CARD_ACTIONS], [...SUGGESTION_ACTIONS])
})

test('a card rides at the head of the message and comes back out whole', () => {
  const text = withSuggestion('回复 Kevin…\n不可撤销的操作前先问我。', card)
  assert.match(text, /^<suggestion source="gmail" action="reply" /)
  assert.deepEqual(splitSuggestion(text), { suggestion: card, text: '回复 Kevin…\n不可撤销的操作前先问我。' })
  assert.deepEqual(splitSuggestion(withSuggestion('x', { ...card, actionTitle: null })).suggestion, { ...card, actionTitle: null })
})

test('anything else is left as written', () => {
  for (const message of ['plain', '<suggestion source="mail" action="reply" title="t">x</suggestion>\nrest', '<suggestion source="gmail" action="reply">x</suggestion>\nrest', 'hi <suggestion source="gmail" action="reply" title="t"></suggestion>']) {
    assert.deepEqual(splitSuggestion(message), { suggestion: null, text: message })
  }
})

test('the chat shows the card on the person\'s message, above the instruction', () => {
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'user', content: withSuggestion('完整指令', card) } },
    { position: 2, createdAt: at, message: { role: 'user', content: withQuote(withSuggestion('改一下', card), { artifactId: '0b6f7c1e-3a54-4a4e-9d55-2f1f0d4f7a10', version: 1, kind: 'text', text: '首页' }) } },
    { position: 3, createdAt: at, message: { role: 'user', content: '普通消息' } },
  ])
  assert.deepEqual(items.map(item => [item.text, item.suggestion ?? null]), [['完整指令', card], ['改一下', card], ['普通消息', null]])
  assert.equal(items[1].quote?.text, '首页')
})

test('a Chinese action line gives its verb to the chip and names the app inline', () => {
  assert.deepEqual(cardParts(card, '回复'), { verb: '回复', parts: [{ kind: 'text', text: 'Kevin 的 ' }, { kind: 'source', source: 'gmail' }, { kind: 'text', text: ' 邮件：周四的会改到周三' }] })
})

test('an app the sentence does not name goes in front', () => {
  assert.deepEqual(cardParts({ source: 'github', title: 'x', actionTitle: '修复 PR #212 的类型检查' }, '处理'), { verb: '修复', parts: [{ kind: 'source', source: 'github' }, { kind: 'text', text: 'PR #212 的类型检查' }] })
})

test('without an action line the chip is the kind and the words are the source\'s title', () => {
  assert.deepEqual(cardParts({ source: 'slack', title: 'deploy question', actionTitle: null }, '查看'), { verb: '查看', parts: [{ kind: 'source', source: 'slack' }, { kind: 'text', text: 'deploy question' }] })
})

test('an English action line keeps its verb in the sentence', () => {
  assert.deepEqual(cardParts({ source: 'github', title: 'x', actionTitle: 'Fix the type check on GitHub PR #212' }, 'Handle'), { verb: null, parts: [{ kind: 'text', text: 'Fix the type check on ' }, { kind: 'source', source: 'github' }, { kind: 'text', text: ' PR #212' }] })
})
