import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultPersonalPrefix, FALLBACK_PERSONAL_PREFIX, normalizePersonalPrefix, resolvePersonalPrefix, taskIdentifier } from './task-identifier'

test('the personal prefix is the first four letters of the email, skipping digits and symbols', () => {
  assert.equal(defaultPersonalPrefix('alexjiang612@gmail.com'), 'ALEX')
  assert.equal(defaultPersonalPrefix('a.l-e_9x@example.com'), 'ALEX')
  assert.equal(defaultPersonalPrefix('ab12@example.com'), null)
})

test('a chosen prefix must be four letters', () => {
  assert.equal(normalizePersonalPrefix(' mine '), 'MINE')
  assert.equal(normalizePersonalPrefix('ab1c'), null)
  assert.equal(normalizePersonalPrefix('abcde'), null)
})

test('a prefix that equals a connected Linear team key is not used', () => {
  assert.equal(resolvePersonalPrefix({ email: 'alexjiang612@gmail.com', linearTeamKeys: ['MIK'] }), 'ALEX')
  assert.equal(resolvePersonalPrefix({ email: 'alexjiang612@gmail.com', linearTeamKeys: ['alex'] }), FALLBACK_PERSONAL_PREFIX)
  assert.equal(resolvePersonalPrefix({ saved: 'MINE', email: 'ab@x.com', linearTeamKeys: ['MIK'] }), 'MINE')
})

test('workspace tasks show their team key and number, personal tasks their prefix', () => {
  assert.equal(taskIdentifier({ scope: 'workspace', number: 3, team: { key: 'AL', number: 46 } }), 'AL-46')
  assert.equal(taskIdentifier({ scope: 'workspace', number: 3 }), null)
  assert.equal(taskIdentifier({ scope: 'personal', number: 12, personalPrefix: 'ALEX', team: { key: 'AL', number: 1 } }), 'ALEX-12')
  assert.equal(taskIdentifier({ scope: 'personal' }), null)
})

test('an owner with no usable prefix still gets one', () => {
  assert.equal(resolvePersonalPrefix({ email: 'ab12@example.com', linearTeamKeys: [] }), FALLBACK_PERSONAL_PREFIX)
  assert.equal(taskIdentifier({ scope: 'personal', number: 7, personalPrefix: resolvePersonalPrefix({ email: 'x@y.z', linearTeamKeys: [] }) }), 'TASK-7')
})

test('a workspace task without a local team keeps its owner number', () => {
  assert.equal(taskIdentifier({ scope: 'workspace', number: 12, personalPrefix: 'MINE' }), 'MINE-12')
  assert.equal(taskIdentifier({ scope: 'workspace', number: 12, personalPrefix: 'MINE', team: { key: 'AL', number: 4 } }), 'AL-4')
  assert.equal(taskIdentifier({ scope: 'workspace', number: 12, personalPrefix: 'MINE', team: null }), 'MINE-12')
})

test('an issued identifier survives team moves, team renames and prefix changes', () => {
  for (const scope of ['workspace', 'personal'] as const) {
    assert.equal(taskIdentifier({ scope, issuedIdentifier: 'OLD-19', number: 7, personalPrefix: 'NEWP', team: { key: 'NEWTEAM', number: 4 } }), 'OLD-19')
    assert.equal(taskIdentifier({ scope, issuedIdentifier: 'OLD-19' }), 'OLD-19')
  }
})
