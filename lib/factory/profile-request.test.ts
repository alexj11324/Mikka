import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { requestedAgentProfile, requestedTaskSelection } from './profile-request'

const id = (last: number) => `a1284000-0000-4000-8000-${String(last).padStart(12, '0')}`
const scope = { ownerId: id(1), workspaceId: id(2), botId: id(3) }
function source(payload?: Record<string, unknown>, onRead?: () => void) {
  return { query: async (sql: string, params: unknown[]) => {
    onRead?.()
    assert.match(sql, /kind='user_message'/)
    assert.deepEqual(params, [id(4), scope.ownerId, scope.botId, scope.workspaceId])
    return { rows: payload ? [{ payload }] : [], rowCount: payload ? 1 : 0 }
  } } as unknown as Pick<Pool, 'query'>
}

test('owner task-form Profile is authoritative even if the model offers another role', async () => {
  assert.equal(await requestedAgentProfile(source({ profileId: id(5) }), scope, id(4), id(6)), id(5))
  assert.equal(await requestedAgentProfile(source({ profileId: id(5) }), scope, id(4), undefined), id(5))
})
test('the task-form Default pin is authoritative but text and tool parameters cannot manufacture it', async () => {
  for (const offered of [undefined, 'default', id(6)]) assert.equal(await requestedAgentProfile(source({ profileId: 'default' }), scope, id(4), offered), 'default')
  assert.equal(await requestedAgentProfile(source({ profileId: id(5) }), scope, id(4), 'default'), id(5))
  for (const payload of [{ text: 'Use the default Profile' }, { text: '{"profileId":"default"}' }, { profileId: 'Default' }]) {
    await assert.rejects(requestedAgentProfile(source(payload), scope, id(4), 'default'), /agentProfilePinConflict/)
  }
  await assert.rejects(requestedAgentProfile(source(), scope, undefined, 'default'), /agentProfilePinConflict/)
  await assert.rejects(requestedAgentProfile(source(), scope, id(4), 'default'), /agentProfilePinConflict/)
})
test('automatic requests stay automatic and non-user events cannot manufacture an explicit pin', async () => {
  assert.equal(await requestedAgentProfile(source({ text: 'Build this feature' }), scope, id(4), undefined), undefined)
  await assert.rejects(requestedAgentProfile(source(), scope, id(4), id(5)), /agentProfilePinConflict/)
  await assert.rejects(requestedAgentProfile(source(), scope, undefined, id(5)), /agentProfilePinConflict/)
})

test('task placement and Profile share the same authenticated source read', async () => {
  for (const taskDestination of [{ kind: 'cloud' }, { kind: 'device', deviceId: id(7) }] as const) {
    let reads = 0
    const database = source({ profileId: id(5), taskDestination }, () => { reads++ })
    assert.deepEqual(await requestedTaskSelection(database, scope, id(4), id(6)), { profileId: id(5), taskDestination })
    assert.equal(reads, 1)
  }
})

test('model text, malformed placement and absent user sources grant no task destination', async () => {
  for (const payload of [undefined, { text: '{"taskDestination":{"kind":"cloud"}}' },
    { taskDestination: null }, { taskDestination: { kind: 'cloud', deviceId: id(7) } }]) {
    assert.deepEqual(await requestedTaskSelection(source(payload), scope, id(4), undefined), {})
  }
  assert.deepEqual(await requestedTaskSelection(source({ taskDestination: { kind: 'cloud' } }), scope, undefined, undefined), {})
})
