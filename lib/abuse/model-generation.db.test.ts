// Actual installed LiteLLM streaming parser + loopback HTTP + isolated PG.
// The provider receipts are synthetic; no external inference or cost is claimed.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type ServerResponse } from 'node:http'
import { mock, test } from 'node:test'
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
  modelAdmission: { litellm: async () => null }, // Unmanaged transport fixture; policy has its own PG suite.
} })
mock.module(new URL('./alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

test('early LiteLLM lookup identity is durable after interrupted/cancelled HTTP streams', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  store = new HostedUsageStore(pool)
  let response!: ServerResponse
  let generation = ''
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
  const server = createServer((_request, next) => {
    response = next
    next.writeHead(200, { 'content-type': 'text/event-stream', 'x-litellm-call-id': generation, 'x-litellm-response-cost': '0.000003' })
    next.write(frame({ id: generation, object: 'chat.completion.chunk', created: 1, model: 'mikka-default',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic partial content' }, finish_reason: null }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await pool.end()
  })
  const address = server.address() as { port: number }
  const previous = { url: process.env.MIKKA_LITELLM_URL, key: process.env.MIKKA_LITELLM_MASTER_KEY }
  process.env.MIKKA_LITELLM_URL = `http://127.0.0.1:${address.port}`
  process.env.MIKKA_LITELLM_MASTER_KEY = 'synthetic-loopback-only'
  t.after(() => {
    for (const [key, value] of [['MIKKA_LITELLM_URL', previous.url], ['MIKKA_LITELLM_MASTER_KEY', previous.key]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value
  })
  const { hostedModel } = await import('./model')
  for (const ending of ['error', 'cancel', 'finish'] as const) await t.test(ending, async () => {
    const workspace = randomUUID()
    generation = `synthetic-${randomUUID()}`
    await store.verify(workspace, 'synthetic-generation-customer', `synthetic-${workspace}`)
    // An allowance granted before 2026-11-15; new verifications grant none.
    await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,1000000) ON CONFLICT DO NOTHING', [workspace])
    const model = await hostedModel(workspace, 'mikka-default')
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
      response.end(frame({ id: generation, object: 'chat.completion.chunk', created: 1, model: 'mikka-default',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } }) + 'data: [DONE]\n\n')
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
