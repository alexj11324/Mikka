import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultPersonalPrefix, normalizePersonalPrefix, resolvePersonalPrefix, taskIdentifier } from './task-identifier'

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
  assert.equal(resolvePersonalPrefix({ email: 'alexjiang612@gmail.com', linearTeamKeys: ['alex'] }), null)
  assert.equal(resolvePersonalPrefix({ saved: 'MINE', email: 'ab@x.com', linearTeamKeys: ['MIK'] }), 'MINE')
})

test('workspace tasks show their Linear id, personal tasks their prefix', () => {
  assert.equal(taskIdentifier({ scope: 'workspace', number: 3, linearIdentifier: 'MIK-46' }), 'MIK-46')
  assert.equal(taskIdentifier({ scope: 'workspace', number: 3 }), null)
  assert.equal(taskIdentifier({ scope: 'personal', number: 12, personalPrefix: 'ALEX', linearIdentifier: 'MIK-1' }), 'ALEX-12')
  assert.equal(taskIdentifier({ scope: 'personal', number: 12, personalPrefix: null }), '#12')
  assert.equal(taskIdentifier({ scope: 'personal' }), null)
})
