import assert from 'node:assert/strict'
import test from 'node:test'
import { activityActorView } from './activity-actor-view'
const people = [{ id: 'member', name: 'Member', avatarUrl: '/photo' }]
const agents = [{ id: 'agent', name: 'Agent', avatarUrl: null }]
test('history projects user, agent and system identities, not the issue owner', () => {
  assert.deepEqual(activityActorView({ actorType: 'user', actorId: 'member' }, people, agents), { type: 'user', id: 'member', name: 'Member', avatarUrl: '/photo' })
  assert.deepEqual(activityActorView({ actorType: 'agent', actorId: 'agent' }, people, agents), { type: 'agent', id: 'agent', name: 'Agent', avatarUrl: null })
  assert.deepEqual(activityActorView({ actorType: 'system', actorId: 'linear' }, people, agents), { type: 'system', id: 'linear', name: null, avatarUrl: null })
})
test('legacy nulls and deleted identities never become a fabricated user', () => {
  assert.equal(activityActorView({ actorType: null, actorId: null }, people, agents), null)
  assert.deepEqual(activityActorView({ actorType: 'user', actorId: 'deleted' }, people, agents), { type: 'user', id: 'deleted', name: null, avatarUrl: null })
})
