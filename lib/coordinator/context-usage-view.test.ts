import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { conversationUsage } from './context-usage'

// This rendering cannot run here: `react-dom/server` and `next-intl` are not
// installed in the environment this test was written in, and installing them
// is not permitted. What is checked instead is the contract the component and
// the copy must keep, so a later change cannot quietly break either.

const copy = (locale: string, key: string): string => {
  const messages = JSON.parse(readFileSync(new URL(`../../messages/${locale}.json`, import.meta.url), 'utf8'))
  const value = messages.Coordinator?.[key]
  assert.equal(typeof value, 'string', `${locale} is missing Coordinator.${key}`)
  return value as string
}

test('every string the usage panel renders exists in both locales', () => {
  for (const key of ['context', 'contextUsage', 'contextHeld', 'contextCompactAt', 'contextKeepRecent', 'contextNearFold', 'contextEstimated', 'contextNoWindow']) {
    for (const locale of ['en', 'zh-CN']) assert.ok(copy(locale, key).trim(), `${locale}.${key}`)
  }
})

test('the two locales carry the same placeholders, so neither renders a raw token', () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
  for (const key of ['contextUsage']) {
    assert.deepEqual(placeholders(copy('en', key)), placeholders(copy('zh-CN', key)), key)
  }
  // The button's own label names both figures it shows.
  assert.deepEqual(placeholders(copy('en', 'contextUsage')), ['compactAt', 'used'])
})

test('the panel never presents the figure as a measurement or a window share', () => {
  for (const locale of ['en', 'zh-CN']) {
    // A person must be able to tell this apart from a provider count.
    assert.match(copy(locale, 'contextEstimated'), /estimated|估算/i, locale)
    // And must not read a window share that Mikka cannot compute.
    assert.match(copy(locale, 'contextNoWindow'), /window|窗口/i, locale)
  }
})

test('the component reads its figures from the usage, never recomputes them', () => {
  const source = readFileSync(new URL('../../components/coordinator/coordinator-context-usage.tsx', import.meta.url), 'utf8')
  // The constants live in one place (lib/coordinator/context.ts via context-usage.ts);
  // a second copy in the view is how the two drift apart.
  assert.doesNotMatch(source, /100_000|100000/, 'the threshold must not be literalled in the view')
  assert.doesNotMatch(source, /20_000|20000/, 'the kept-recent figure must not be literalled in the view')
  // It renders the estimate it is given.
  assert.match(source, /usage\.used/)
  assert.match(source, /usage\.compactAt/)
  assert.match(source, /usage\.share/)
  assert.match(source, /usage\.compactsNextTurn/)
})

test('the view uses semantic tokens, never a raw palette class', () => {
  const source = readFileSync(new URL('../../components/coordinator/coordinator-context-usage.tsx', import.meta.url), 'utf8')
  // BoardUI rule: every colour rides a token, which is also what makes dark mode work.
  assert.doesNotMatch(source, /\b(?:text|bg|border)-(?:gray|neutral|slate|zinc|white|black)-\d+/, 'raw palette class')
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'hex literal')
})

test('the number a person sees moves the same way the fold does', () => {
  // A conversation one message short of the fold reads below 100%; the message
  // that crosses it reads 100% and says the next turn folds first.
  const short = Array.from({ length: 40 }, (_, index) => ({ position: index + 1, message: { role: 'user' as const, content: 'x'.repeat(9_000) } }))
  const long = Array.from({ length: 60 }, (_, index) => ({ position: index + 1, message: { role: 'user' as const, content: 'x'.repeat(9_000) } }))
  assert.equal(conversationUsage(null, short).compactsNextTurn, false)
  assert.equal(conversationUsage(null, long).compactsNextTurn, true)
  assert.ok(conversationUsage(null, short).share < conversationUsage(null, long).share)
})
