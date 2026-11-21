import {compactionCut} from '../../tests/support/legacy-compaction'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { COMPACT_AT_TOKENS, KEEP_RECENT_TOKENS, estimateTokens, promptMessages, type StoredMessage } from './context'
import { conversationUsage } from './context-usage'

const said = (position: number, text: string): StoredMessage => ({ position, message: { role: 'user', content: text } })

test('the usage measures the projection the fold measures, not the raw rows', () => {
  const messages = [said(1, 'hello'), said(2, 'x'.repeat(4_000))]
  // The fold counts the provenance-wrapped projection, so a conversation's
  // usage is measured there too: measuring the raw rows would understate it by
  // the wrapping the model actually receives.
  assert.equal(conversationUsage(null, messages).used, estimateTokens(promptMessages(null, messages)))
  assert.ok(conversationUsage(null, messages).used > estimateTokens(messages.map(row => row.message)))
})

test('an empty conversation is not due to fold', () => {
  const usage = conversationUsage(null, [])
  assert.equal(usage.compactsNextTurn, false)
  assert.equal(usage.share, 0)
  // The estimator stringifies its input, so an empty list measures the '[]' overhead
  // rather than 0; this reports the fold's own number, not a tidier one.
  assert.equal(usage.used, estimateTokens([]))
})

test('it reports the real constants rather than copies of them', () => {
  const usage = conversationUsage(null, [])
  assert.equal(usage.compactAt, COMPACT_AT_TOKENS)
  assert.equal(usage.keepRecent, KEEP_RECENT_TOKENS)
})

test('it never claims a measurement it did not take', () => {
  const usage = conversationUsage(null, [said(1, 'hi')])
  // A person comparing this with a bill must not read it as the provider's count.
  assert.equal(usage.estimated, true)
  // Mikka stores no context window anywhere, so there is no denominator to show.
  assert.equal(usage.windowTokens, null)
})

test('it agrees with compactionCut on both sides of the threshold', () => {
  // ~9k tokens of text per message, short of the 100k fold.
  const under = Array.from({ length: 40 }, (_, index) => said(index + 1, 'x'.repeat(9_000)))
  assert.equal(compactionCut(null, under), null)
  const underUsage = conversationUsage(null, under)
  assert.equal(underUsage.compactsNextTurn, false)
  assert.ok(underUsage.share > 0 && underUsage.share < 100, `share ${underUsage.share}`)

  // Past it: both the fold and the read must say so.
  const over = Array.from({ length: 60 }, (_, index) => said(index + 1, 'x'.repeat(9_000)))
  assert.notEqual(compactionCut(null, over), null)
  assert.equal(conversationUsage(null, over).compactsNextTurn, true)
})

test('the share is a whole percent that never exceeds 100', () => {
  const over = Array.from({ length: 80 }, (_, index) => said(index + 1, 'x'.repeat(9_000)))
  const usage = conversationUsage(null, over)
  assert.equal(usage.share, 100)
  assert.ok(Number.isInteger(usage.share))
})

test('a folded conversation says it has a summary', () => {
  assert.equal(conversationUsage(null, [said(1, 'hi')]).hasSummary, false)
  assert.equal(conversationUsage('what came before', [said(2, 'hi')]).hasSummary, true)
  // A blank summary is not one.
  assert.equal(conversationUsage('   ', [said(2, 'hi')]).hasSummary, false)
})
