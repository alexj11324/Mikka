import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

const actor = { userId: 'owner', workspaceId: 'workspace' }
const calls: Record<string, unknown>[] = []
const updates: unknown[][] = []
class FakeStore {
  async get() { return { status: 'running', epoch: 7 } }
  async action(_actor: unknown, _bot: string, _id: string, action: Record<string, unknown>) {
    calls.push(action)
    return action.action === 'inspectMutation' ? { loaderId: 'document', origin: 'https://example.test' } : { accepted: true }
  }
  async update(...args: unknown[]) { updates.push(args) }
}
mock.module(new URL('./subagents.ts', import.meta.url).href, { namedExports: { SubagentStore: FakeStore } })
let browserAction: typeof import('./action-reviews').browserAction
before(async () => { browserAction = (await import('./action-reviews')).browserAction })
const queries: { sql: string; args: unknown[] }[] = []
const pool = { async query(sql: string, args: unknown[]) { queries.push({ sql, args }); return { rows: [] } } } as unknown as Parameters<typeof browserAction>[0]
beforeEach(() => { calls.length = 0; updates.length = 0; queries.length = 0 })

test('model-selected ordinary action executes without a metadata business classifier', async () => {
  const mutation = { action: 'click' as const, selector: '#continue' }
  const result = await browserAction(pool, actor, 'bot', 'subagent', mutation, 'Continue', false)
  assert.equal(result.state, 'running')
  assert.deepEqual(calls, [mutation])
  assert.equal(queries.length, 0)
})

test('model-selected confirmation binds the exact action, document and origin', async () => {
  const mutation = { action: 'click' as const, selector: '#confirm' }
  const result = await browserAction(pool, actor, 'bot', 'subagent', mutation, 'Confirm task', true)
  assert.equal(result.state, 'needs_you')
  assert.deepEqual(calls, [{ action: 'inspectMutation', mutation }])
  assert.equal(queries.length, 1)
  const input = JSON.parse(queries[0].args[2] as string)
  assert.equal(input.loaderId, 'document')
  assert.equal(input.origin, 'https://example.test')
  assert.deepEqual(input.mutation, mutation)
  assert.equal(input.actionId, result.actionId)
  assert.equal(updates.length, 1)
})
