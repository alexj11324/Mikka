import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, mock, test } from 'node:test'
import { recordCredentialAction } from './credential-action-ledger'

let stopped = 0, current: Record<string, unknown> = {}
class FakeStore {
  async get() { return current }
  async stop() { stopped++ }
}
mock.module(new URL('./subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: FakeStore } })
mock.module(new URL('../subscription-runtime.ts', import.meta.url).href, { namedExports: { authorizeSubscriptionWorkspace: async () => {} } })
let dispatch: typeof import('./action-reviews').executeApprovedBrowserAction
before(async () => { dispatch = (await import('./action-reviews')).executeApprovedBrowserAction })

test('existing browser approval dispatch binds owner and receipt; denial stops and approval fails closed', async () => {
  const pool = { async query() { return { rowCount: 1, rows: [] } } } as never
  const id = randomUUID(), subagentId = randomUUID()
  const binding = { userId: 'owner', workspaceId: randomUUID(), botId: randomUUID(), subagentId, runId: subagentId, epoch: 1, policyVersion: 2, targetId: 'target', origin: 'https://example.test', loaderId: 'loader', backendNodeId: 7, role: 'password' as const, expiresAt: Date.now() + 60_000 }
  const { action } = await recordCredentialAction(pool, binding, 'ask', false, id)
  current = { status: 'needs_you', epoch: 1, targetId: 'target', needs: { kind: 'approval', actionId: id } }
  assert.deepEqual(await dispatch(pool, 'other', action, true, id), { error: 'browserActionChanged' })
  assert.deepEqual(await dispatch(pool, 'owner', action, true, randomUUID()), { error: 'browserActionChanged' })
  assert.deepEqual(await dispatch(pool, 'owner', action, true, id), { error: 'browserCredentialServiceUnavailable' })
  assert.deepEqual(await dispatch(pool, 'owner', action, false, id), { data: {} })
  assert.equal(stopped, 1)
})
