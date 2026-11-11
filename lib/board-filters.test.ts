import assert from 'node:assert/strict'
import test from 'node:test'
import { personFilters } from './board-filters'

const me = 'user-me'
const myAgent = 'agent-mine'
const task = (ownerId: string, assignee: { kind: 'member' | 'agent'; id: string } | null) => ({ ownerId, metadata: { assignee } })
const mine = (heldByMyBot = false) => ({ agents: new Set([myAgent]), heldByMyBot })

test('负责人 我 is the human assignee, independent of my bot or Agent', () => {
  assert.equal(personFilters(task('user-other', { kind: 'member', id: me }), me, mine()).assignee, true, 'assigned to me')
  assert.equal(personFilters(task('user-other', null), me, mine(true)).assignee, false, 'held by my bot')
  assert.equal(personFilters(task('user-other', { kind: 'agent', id: myAgent }), me, mine()).assignee, false, 'held by my Agent')
})

test('following uses an explicit subscription and does not become responsibility', () => {
  const followed = { ownerId: 'other', metadata: { assignee: null, subscriberUserIds: [me] } }
  assert.equal(personFilters(followed, me, mine()).following, true)
  assert.equal(personFilters(followed, me, mine()).assignee, false)
  assert.equal(personFilters(task(me, null), me, mine(true)).following, false)
})

test('负责人 我 never matches a task I only created, or someone else\'s', () => {
  assert.equal(personFilters(task(me, null), me, mine()).assignee, false, 'created by me only')
  assert.equal(personFilters(task(me, { kind: 'member', id: 'user-other' }), me, mine()).assignee, false, 'created by me, assigned to someone else')
  assert.equal(personFilters(task('user-other', { kind: 'member', id: 'user-other' }), me, mine()).assignee, false, 'someone else\'s')
  assert.equal(personFilters(task('user-other', { kind: 'agent', id: 'agent-theirs' }), me, mine()).assignee, false, 'someone else\'s Agent')
})

test('我创建的 matches the tasks I created, whoever holds them', () => {
  assert.equal(personFilters(task(me, null), me, mine()).creator, true)
  assert.equal(personFilters(task(me, { kind: 'member', id: 'user-other' }), me, mine()).creator, true)
  assert.equal(personFilters(task('user-other', { kind: 'member', id: me }), me, mine(true)).creator, false)
})
