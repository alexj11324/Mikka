import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { currentCiSubscriptionAuthorized } from './ci-subscription-authority'

test('CI subscription requires current connected binding and fails closed', async () => {
  const prior = process.env.MIKKA_BYOS_ENABLED
  process.env.MIKKA_BYOS_ENABLED = '1'
  try {
    const calls: unknown[][] = []
    const tx = { query: async (_sql: string, params: unknown[]) => { calls.push(params); return { rows: [{ id: 'binding' }] } } } as never
    const definition = { subscription: { bindingId: 'binding', route: 'codex_cli', modelId: 'model' } } as never
    assert.equal(await currentCiSubscriptionAuthorized(tx, 'owner', 'agent', definition), true)
    assert.deepEqual(calls[0], ['binding','owner','agent','codex_cli','model'])
    assert.equal(await currentCiSubscriptionAuthorized({ query: async () => ({ rows: [] }) } as never, 'owner', 'agent', definition), false)
    assert.equal(await currentCiSubscriptionAuthorized(tx, 'owner', null, definition), false)
    process.env.MIKKA_BYOS_ENABLED = '0'
    assert.equal(await currentCiSubscriptionAuthorized(tx, 'owner', 'agent', definition), false)
    assert.equal(await currentCiSubscriptionAuthorized(tx, 'owner', 'agent', null), true)
  } finally { if (prior === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = prior }
})
