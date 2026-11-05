import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Pool } from 'pg'
import { requestedAgentProfile } from './profile-request'

const id = (last: number) => `a1284000-0000-4000-8000-${String(last).padStart(12, '0')}`
const scope = { ownerId: id(1), workspaceId: id(2), botId: id(3) }
function source(payload?: Record<string, unknown>) {
  return { query: async (sql: string, params: unknown[]) => {
    assert.match(sql, /kind='user_message'/)
    assert.deepEqual(params, [id(4), scope.ownerId, scope.botId])
    return { rows: payload ? [{ payload }] : [], rowCount: payload ? 1 : 0 }
  } } as unknown as Pick<Pool, 'query'>
}

test('owner task-form Profile is authoritative even if the model offers another role', async () => {
  assert.equal(await requestedAgentProfile(source({ profileId: id(5) }), scope, id(4), id(6)), id(5))
  assert.equal(await requestedAgentProfile(source({ profileId: id(5) }), scope, id(4), undefined), id(5))
})
test('automatic requests stay automatic and non-user events cannot manufacture an explicit pin', async () => {
  assert.equal(await requestedAgentProfile(source({ text: 'Build this feature' }), scope, id(4), undefined), undefined)
  await assert.rejects(requestedAgentProfile(source(), scope, id(4), id(5)), /agentProfilePinConflict/)
  await assert.rejects(requestedAgentProfile(source(), scope, undefined, id(5)), /agentProfilePinConflict/)
})
