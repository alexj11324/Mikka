import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

const order = [{ harness: 'codex', model: 'gpt-6-luna', source: { kind: 'subscription', connectionId: 'conn-own' } }]
mock.module('./bot-model-choice', { namedExports: { botModelPreference: async () => ({ selected: 'binding-chat' }) } })
mock.module('./bot-model-menu-view', { namedExports: { parseCreditsOption: () => null } })
mock.module('./model-order', { namedExports: { orderCandidates: async () => order } })

test("a new thread follows the Bot chat's model only on the person's own subscription", async () => {
  const { mainThreadModel } = await import('./main-thread-model')
  const calls: unknown[][] = []
  const pool = { query: async (sql: string, values: unknown[]) => {
    calls.push(values)
    assert.match(sql, /WHERE id=\$1 AND "ownerId"=\$2$/)
    return { rows: values[1] === 'owner' ? [{ connectionId: 'conn-own', modelId: 'gpt-6-luna' }] : [] }
  } }
  assert.deepEqual(await mainThreadModel(pool as never, { ownerId: 'owner', workspaceId: 'ws' }, 'bot'), { harness: 'codex', model: 'gpt-6-luna' })
  assert.deepEqual(calls, [['binding-chat', 'owner']])
  assert.equal(await mainThreadModel(pool as never, { ownerId: 'teammate', workspaceId: 'ws' }, 'bot'), null, "a teammate's binding is never followed")
})
