// Actual installed Gateway streaming parser + loopback HTTP + isolated PG.
// The provider receipts are synthetic; no external inference or cost is claimed.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mock, test } from 'node:test'
import { createGateway } from 'ai'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { HostedUsageStore } from './store'
const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.DATABASE_URL, target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('Isolated accounting target required')
let store: HostedUsageStore
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  canUseMikkaPaid: (workspace: string) => store.canUseMikkaPaid(workspace),
  hostedUsage: {
    reserve: (...args: Parameters<HostedUsageStore['reserve']>) => store.reserve(...args),
    recordGeneration: (...args: Parameters<HostedUsageStore['recordGeneration']>) => store.recordGeneration(...args),
    settle: (...args: Parameters<HostedUsageStore['settle']>) => store.settle(...args),
  },
} })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: {
  modelAdmission: { gateway: async () => null }, // Unmanaged transport fixture; policy has its own PG suite.
} })
mock.module(new URL('./alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

test('early Gateway lookup identity is durable after interrupted/cancelled HTTP streams', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  store = new HostedUsageStore(pool)
  let response!: ServerResponse
  let generation = ''
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const server = createServer((_request, next) => {
    response = next
    next.writeHead(200, { 'content-type': 'text/event-stream' })
    next.write(frame({ type: 'stream-start', warnings: [] }))
    next.write(frame({ type: 'text-start', id: 'text' }))
    next.write(frame({ type: 'text-delta', id: 'text', delta: 'Synthetic partial content', providerMetadata: { gateway: { generationId: generation } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await pool.end()
  })
  const address = server.address() as { port: number }
  const gateway = createGateway({ baseURL: `http://127.0.0.1:${address.port}`, apiKey: 'synthetic-loopback-only' })
  const { hostedModel } = await import('./model')
  for (const ending of ['error', 'cancel', 'finish'] as const) await t.test(ending, async () => {
    const workspace = randomUUID()
    generation = `synthetic-${randomUUID()}`
    await store.verify(workspace, 'synthetic-generation-customer', `synthetic-${workspace}`)
    const model = await hostedModel(workspace, 'synthetic/gateway-stream', gateway('synthetic/gateway-stream'))
    const reader = (await model.doStream({ prompt: [] })).stream.getReader()
    for (;;) {
      const part = await reader.read()
      assert.equal(part.done, false)
      if (part.value.type === 'text-delta') break
    }
    const row = async () => (await pool.query('SELECT id,state,"generationId","costMicroUsd","reservedFree","reservedPurchased" FROM hosted_usage WHERE "workspaceId"=$1', [workspace])).rows[0]
    const pending = await row()
    assert.equal(pending.state, 'pending')
    assert.equal(pending.generationId, generation)
    assert.equal(pending.costMicroUsd, null)
    assert.equal(Number(pending.reservedFree) + Number(pending.reservedPurchased), 0)
    await assert.rejects(store.recordGeneration(pending.id, 'synthetic-different-generation'), /usage_cost_unavailable/)
    if (ending === 'error') {
      response.destroy()
      await assert.rejects(reader.read())
    } else if (ending === 'cancel') await reader.cancel()
    else {
      // The final receipt omits its ID: the early, persisted identity must survive.
      response.end(frame({ type: 'finish', usage: { inputTokens: { total: 2 }, outputTokens: { total: 1 } }, finishReason: { unified: 'stop', raw: 'stop' }, providerMetadata: { gateway: { cost: '0.000003' } } }))
      while (!(await reader.read()).done) {}
    }
    assert.equal((await row()).generationId, generation)
    if (ending !== 'finish') {
      assert.equal((await row()).state, 'unknown')
      assert.equal((await row()).costMicroUsd, null)
      assert.equal((await store.balance(workspace)).free, 1_000_000)
      // A newly constructed store can reconcile the exact known receipt; no balance estimate.
      const recovered = new HostedUsageStore(pool)
      await assert.rejects(recovered.settle(pending.id, 3, 2, 1, 'synthetic-wrong-generation'), /usage_generation_mismatch/)
      await recovered.settle(pending.id, 3, 2, 1)
    }
    const settled = await row()
    assert.equal(settled.state, 'settled')
    assert.equal(Number(settled.costMicroUsd), 3)
    await store.settle(pending.id, 3, 2, 1, generation)
    assert.equal((await store.balance(workspace)).free, 999_997)
  })
})
