import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SUGGESTION_ACTIONS, SUGGESTION_SOURCES } from '@/lib/db/schema'
import { chatItems } from '@/lib/coordinator/context'
import { withQuote } from '@/lib/artifacts/quote'
import { CARD_ACTIONS, CARD_LIMITS, CARD_SOURCES, cardExtras, cardParts, splitSuggestion, suggestionMessage, type SuggestionCard } from './card'

const at = new Date('2026-10-28T00:00:00Z')
const card: SuggestionCard = { source: 'gmail', action: 'reply', title: 'Re: 周四的会 <urgent> & "now"', actionTitle: '回复 Kevin 的 Gmail 邮件：周四的会改到周三', actor: 'Kevin', url: 'https://mail.example/1' }

test('the card lists match the schema', () => {
  assert.deepEqual([...CARD_SOURCES], [...SUGGESTION_SOURCES])
  assert.deepEqual([...CARD_ACTIONS], [...SUGGESTION_ACTIONS])
})

test('the message is the card alone and comes back out whole', () => {
  const text = suggestionMessage(card)
  assert.match(text, /^<suggestion source="gmail" action="reply" title="「Re: 周四的会 &lt;urgent> &amp; &quot;now&quot;」" actor="「Kevin」" url="「https:\/\/mail.example\/1」">「回复 Kevin 的 Gmail 邮件：周四的会改到周三」<\/suggestion>$/)
  assert.deepEqual(splitSuggestion(text), { suggestion: card, text: '' })
  assert.deepEqual(splitSuggestion(suggestionMessage({ ...card, actionTitle: null, actor: null, url: null })).suggestion, { ...card, actionTitle: null, actor: null, url: null })
})

test('source values are one line, cut to length, with their own 「」 taken out', () => {
  const long = { ...card, title: `a\n「b」${'x'.repeat(400)}`, actor: 'K\r\nim', url: 'javascript:alert(1)' }
  const parsed = splitSuggestion(suggestionMessage(long)).suggestion!
  assert.equal(parsed.title.length, CARD_LIMITS.title)
  assert.ok(parsed.title.startsWith('a b x'))
  assert.equal(parsed.actor, 'K im')
  assert.equal(parsed.url, null)
})

test('anything else is left as written', () => {
  for (const message of ['plain', '<suggestion source="mail" action="reply" title="「t」"></suggestion>', '<suggestion source="gmail" action="reply">x</suggestion>', '<suggestion source="gmail" action="reply" title="t"></suggestion>', '<suggestion source="gmail" action="reply" title="「t」">unquoted</suggestion>', 'hi <suggestion source="gmail" action="reply" title="「t」"></suggestion>']) {
    assert.deepEqual(splitSuggestion(message), { suggestion: null, text: message })
  }
})

test('the chat shows the card as the person\'s message, with nothing else in it', () => {
  const items = chatItems([
    { position: 1, createdAt: at, message: { role: 'user', content: suggestionMessage(card) } },
    { position: 2, createdAt: at, message: { role: 'user', content: withQuote(suggestionMessage(card), { artifactId: '0b6f7c1e-3a54-4a4e-9d55-2f1f0d4f7a10', version: 1, kind: 'text', text: '首页' }) } },
    { position: 3, createdAt: at, message: { role: 'user', content: '普通消息' } },
  ])
  assert.deepEqual(items.map(item => [item.text, item.suggestion ?? null]), [['', card], ['', card], ['普通消息', null]])
  assert.equal(items[1].quote?.text, '首页')
})

test('the bubble under a sent card adds only the source\'s own words and the link', () => {
  assert.deepEqual(cardExtras(card), { original: card.title, url: card.url })
  assert.deepEqual(cardExtras({ ...card, actionTitle: null, url: null }), { original: null, url: null })
})

test('a Chinese action line gives its verb to the chip and names the app inline', () => {
  assert.deepEqual(cardParts(card, '回复'), { verb: '回复', parts: [{ kind: 'text', text: 'Kevin 的 ' }, { kind: 'source', source: 'gmail' }, { kind: 'text', text: ' 邮件：周四的会改到周三' }] })
})

test('a Chinese line without a space after its verb still gets one verb chip', () => {
  assert.deepEqual(cardParts({ source: 'linear', title: 'x', actionTitle: '处理分配给你的任务：登录死循环' }, '处理'), { verb: '处理', parts: [{ kind: 'source', source: 'linear' }, { kind: 'text', text: '分配给你的任务：登录死循环' }] })
  assert.deepEqual(cardParts({ source: 'notion', title: 'x', actionTitle: '核对路线图草稿的新评论' }, '查看'), { verb: '查看', parts: [{ kind: 'source', source: 'notion' }, { kind: 'text', text: '核对路线图草稿的新评论' }] })
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

test('a GitHub card stored with raw markup is sent and shown as readable words, never the markup or a bot\'s metadata', () => {
  // Made-up hidden metadata in the shape a deploy bot leaves, as an older row stored it (one line).
  const metadata = `[pv]: #${'QUJDREVGR0hJSktMTU5PUA'.repeat(6)}=:${'eyJmYWtlIjp0cnVlfQ'.repeat(6)}`
  const raw: SuggestionCard = { source: 'github', action: 'reply', title: metadata, actionTitle: null, actor: 'deploy-preview[bot]', url: 'https://github.com/a/b/pull/1#issuecomment-2' }
  const message = suggestionMessage(raw)
  assert.ok(!message.includes('QUJDREVG') && !message.includes('[pv]'))
  const { suggestion } = splitSuggestion(message)
  assert.equal(suggestion?.title, 'https://github.com/a/b/pull/1#issuecomment-2')
  assert.deepEqual(cardExtras(raw), { original: null, url: raw.url })
  assert.deepEqual(cardParts(raw, '回复').parts, [{ kind: 'source', source: 'github' }])

  const heading: SuggestionCard = { ...raw, title: '#### ⚠️ Scanner found **1** secret <!-- state -->', actionTitle: '修复 PR #345 中泄露的密钥', url: null }
  assert.equal(splitSuggestion(suggestionMessage(heading)).suggestion?.title, '⚠️ Scanner found 1 secret')
  assert.equal(cardExtras(heading).original, '⚠️ Scanner found 1 secret')
  assert.deepEqual(cardParts({ ...heading, actionTitle: null }, '回复').parts.at(-1), { kind: 'text', text: '⚠️ Scanner found 1 secret' })
  // A metadata-only card with no link is named by its app.
  assert.equal(splitSuggestion(suggestionMessage({ ...raw, url: null })).suggestion?.title, 'GitHub')
})
