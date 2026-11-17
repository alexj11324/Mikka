import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const order = [{ harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: 'conn-shared' } }]
mock.module('./bot-model-choice', { namedExports: { botModelPreference: async () => ({ selected: 'binding-shared' }) } })
mock.module('./bot-model-menu-view', { namedExports: { parseCreditsOption: () => null } })
mock.module('./model-order', { namedExports: { orderCandidates: async () => order } })

test("a Bot chat on a teammate's shared subscription is followed by the new thread", async () => {
  const { mainThreadModel } = await import('./main-thread-model')
  const calls: unknown[][] = []
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push(values)
    assert.match(sql, /"workspaceId"=\$3 AND \("ownerId"=\$2 OR "consumerId"=\$4\)/)
    return { rows: values[0] === 'binding-shared' && values[2] === 'ws' && values[3] === 'bot' ? [{ connectionId: 'conn-shared', modelId: 'claude-haiku-5-5' }] : [] }
  } }
  assert.deepEqual(await mainThreadModel(pool as never, { ownerId: 'requester', workspaceId: 'ws' }, 'bot'), { harness: 'claude_code', model: 'claude-haiku-5-5' })
  assert.deepEqual(calls, [['binding-shared', 'requester', 'ws', 'bot']])
  assert.equal(await mainThreadModel(pool as never, { ownerId: 'requester', workspaceId: 'other' }, 'bot'), null)
})
