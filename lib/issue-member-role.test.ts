import assert from 'node:assert/strict'
import test from 'node:test'
import { mayGrantOwnerRole, mayManageMembers, mayMuteMember, maySetSubscription, type MembershipCaller } from './issue-member-role'

// The membership rules ALE-29 adds: a task role that is separate from the task's
// owner, and a subscription a member controls without leaving.
// Pure: the actions holding the transaction are covered by the database tests.

const owner = 'owner-account', peer = 'peer-account', stranger = 'stranger-account'
const OWNER_TASK = owner

const caller = (accountId: string, role: 'owner' | 'member' | null = null): MembershipCaller => ({ accountId, ownerId: OWNER_TASK, role })

test('the task owner manages members without needing a row', () => {
  assert.equal(mayManageMembers(caller(owner)), true)
})

test('a member carrying the owner role manages members too', () => {
  assert.equal(mayManageMembers(caller(peer, 'owner')), true, 'the whole point of the role')
})

test('a plain member and a non-member do not', () => {
  assert.equal(mayManageMembers(caller(peer, 'member')), false)
  assert.equal(mayManageMembers(caller(stranger)), false, 'a stranger has no row and is not the owner')
})

test('only the task owner hands out the owner role', () => {
  assert.equal(mayGrantOwnerRole(caller(owner)), true)
  assert.equal(mayGrantOwnerRole(caller(peer, 'owner')), false, 'a delegated owner cannot create more owners')
})

test('a member controls their own subscription; only the owner controls somebody else\'s', () => {
  assert.equal(maySetSubscription(caller(peer, 'member'), peer), true)
  assert.equal(maySetSubscription(caller(peer, 'member'), stranger), false)
  assert.equal(maySetSubscription(caller(owner), peer), true)
  assert.equal(maySetSubscription(caller(stranger), peer), false)
})

test('the owner\'s own subscription cannot be muted', () => {
  assert.equal(mayMuteMember(peer, OWNER_TASK), true)
  assert.equal(mayMuteMember(OWNER_TASK, OWNER_TASK), false, 'the owner has no row and could not re-add themselves')
})
