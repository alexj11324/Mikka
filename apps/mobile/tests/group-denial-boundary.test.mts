import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withholdsCachedRead } from '../lib/api-read-state.ts'

// The mounted-cache behavior is exercised in api-context.test.mts. This guards the
// native GroupChat wiring that must also retire screen-local drafts and actions.
const source = readFileSync(new URL('../app/groups/[id].tsx', import.meta.url), 'utf8')

test('only a confirmed member denial hides the group; ordinary outages retain offline state', () => {
  for (const code of [403, 404]) assert.equal(withholdsCachedRead(code), true)
  assert.equal(withholdsCachedRead(401), false, 'account-wide 401 recovery is not a per-path cache eviction')
  for (const code of [0, 429, 500, 502, 503, 504]) assert.equal(withholdsCachedRead(code), false)
  assert.match(source, /const accessDenied = conversationAccessDenied\(page\.error\) \|\| conversationAccessDenied\(members\.error\)/)
  assert.match(source, /const messages = accessDenied \? \[\] : mergeGroupMessages/)
  assert.match(source, /const before = accessDenied \? null :/)
  assert.match(source, /const canSend = Boolean\(page\.data && members\.data && !accessDenied\)/)
  assert.match(source, /useConversationDelivery\(canSend \? \{ kind: 'group', id \} : null/)
})

test('a revoked group cannot expose a stale title, attachment composer, reaction or stop action', () => {
  assert.match(source, /<NavBar title=\{accessDenied \? '' : title\}/)
  assert.match(source, /\{!accessDenied \? <Composer value=\{text\}/)
  assert.match(source, /if \(accessDenied \|\| reactionPending\.current\.has\(messageId\)\) return/)
  assert.match(source, /if \(accessDenied \|\| stopPending\.current\) return/)
  for (const state of ['setText', 'setQuote', 'setSentHere', 'setReactionSnapshot', 'setReactionFailure',
    'setHistoryError', 'setLoadingHistory', 'setStopFailed', 'setStopping']) {
    const deniedEffect = source.split('if (!accessDenied) return')[1]?.split('}, [accessDenied, identity])')[0] ?? ''
    assert.match(deniedEffect, new RegExp(state + '\\('), state + ' must be cleared when access is revoked')
  }
  assert.match(source, /opened\.current = null/)
  assert.match(source, /historyRequest\.current = null/)
  assert.match(source, /reactionPending\.current\.clear\(\)/)
})
