import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { withholdsCachedRead } from '../lib/api-read-state.ts'
import { clearHeldMessageForScope, heldMessage, holdMessage, subscribeHeldMessage } from '../lib/message-actions.ts'
import { clearHeldMessage, heldMessage, holdMessage, subscribeHeldMessage } from '../lib/message-actions.ts'

// The mounted-cache behavior is exercised in api-context.test.mts. This guards the
// native GroupChat wiring that must also retire screen-local drafts and actions.
const source = readFileSync(new URL('../app/groups/[id].tsx', import.meta.url), 'utf8')

test('the open selection loses the denied group’s text and actions without clearing another group', () => {
  const first = { scope: 'group-a:1', text: 'A', onQuote() {} }
  const second = { scope: 'group-b:1', text: 'B', onQuote() {} }
  const seen: Array<string | null> = []
  const unsubscribe = subscribeHeldMessage(() => seen.push(heldMessage()?.text ?? null))
  try {
    holdMessage(first)
    clearHeldMessage(second.scope)
    assert.equal(heldMessage(), first)
    clearHeldMessage(first.scope)
    assert.equal(heldMessage(), null)
    holdMessage(second)
    clearHeldMessage(first.scope)
    assert.equal(heldMessage(), second)
    assert.deepEqual(seen, ['A', null, 'B'])
  } finally {
    unsubscribe()
    clearHeldMessage(second.scope)
  }
})

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

test('an in-place group or account transition does not reuse the previous draft and quote', () => {
  assert.match(source, /const identity = `\$\{id\}:\$\{apiContext\}`/)
  assert.match(source, /const draftMatches = !accessDenied && composerDraft\.identity === identity/)
  assert.match(source, /const text = draftMatches \? composerDraft\.text : ''/)
  assert.match(source, /const quote = draftMatches \? composerDraft\.quote : null/)
  assert.match(source, /const setText = \(value: string\) => setComposerDraft\(current => \(\{/)
  assert.match(source, /identity, text: value, quote: current\.identity === identity \? current\.quote : null/)
  assert.match(source, /const setQuote = \(value: string \| null\) => setComposerDraft\(current => \(\{/)
  assert.match(source, /identity, text: current\.identity === identity \? current\.text : '', quote: value/)
})


test('revoking a selected group message removes its text and actions without clearing another selection', () => {
  const original = { sourceScope: 'group:alpha:1', text: 'private group message', onQuote: () => {} }
  const other = { sourceScope: 'group:beta:1', text: 'other group', onQuote: () => {} }
  let changes = 0
  const unsubscribe = subscribeHeldMessage(() => { changes++ })
  try {
    holdMessage(original)
    assert.equal(heldMessage(), original)
    clearHeldMessageForScope('group:beta:1')
    assert.equal(heldMessage(), original, 'revoking a different group must not erase a valid selection')
    clearHeldMessageForScope('group:alpha:1')
    assert.equal(heldMessage(), null, 'a revoked group must not remain copyable in the selection route')
    holdMessage(other)
    clearHeldMessageForScope('group:alpha:1')
    assert.equal(heldMessage(), other)
    assert.equal(changes, 3, 'only actual selection changes notify an open native action sheet')
  } finally {
    unsubscribe()
    clearHeldMessageForScope('group:alpha:1')
    clearHeldMessageForScope('group:beta:1')
  }
  assert.match(source, /clearHeldMessageForScope\\(`group:\\$\\{identity\\}`\\)/)
  assert.match(source, /sourceScope: `group:\\$\\{identity\\}`/)
})
