import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { HostedUsageStore } from './store'

const target = process.env.E2E_DATABASE_URL
if (target) {
  assertE2eTarget(target)
  assert.equal(process.env.MIKKA_DATABASE_URL, target)
  assert.equal(process.env.DATABASE_URL, target)
}
if (!target && process.env.REQUIRE_DB === '1') throw Error('An isolated model accounting database is required')
let store: HostedUsageStore
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  canUseMikkaPaid: (workspaceId: string) => store.canUseMikkaPaid(workspaceId),
  hostedUsage: {
    reserve: (...args: Parameters<HostedUsageStore['reserve']>) => store.reserve(...args),
    settle: (...args: Parameters<HostedUsageStore['settle']>) => store.settle(...args),
  },
} })
// Existing callers may still read pricing during rollout. The price is much
// higher than the initial balance; it must not authorize or freeze money.
const gateway = Object.assign(() => { throw Error('Only the loopback provider is allowed') }, {
  getAvailableModels: async () => ({ models: [{ id: 'postpay-fixture', pricing: { input: '0.000001', output: '0.000001' } }] }),
})
mock.module('ai', { namedExports: { gateway, createGateway: () => gateway } })
mock.module(new URL('./alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

test('hosted calls check positive balance, debit only after receipts, and resume after credit', { skip: !target }, async t => {
  const pool = new Pool({ connectionString: target })
  store = new HostedUsageStore(pool)
  let providerCalls = 0, cost = '0.000002', releaseFirst = () => {}, signalArrival = () => {}
  const arrived = new Promise<void>(resolve => { signalArrival = resolve })
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve })
  const server = createServer(async (_request, response) => {
    providerCalls++
    if (providerCalls === 1) { signalArrival(); await firstResponse }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      content: [{ type: 'text', text: 'Synthetic provider receipt' }],
      usage: { inputTokens: { total: 0 }, outputTokens: { total: 1 } },
      finishReason: { unified: 'stop', raw: 'stop' }, warnings: [], providerMetadata: { gateway: { cost } },
    }))
  })
  t.after(async () => {
    releaseFirst()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await pool.end()
    await (await import('../db')).pool.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  const receive = async () => (await fetch(`http://127.0.0.1:${address.port}`, { method: 'POST' })).json()
  const provider = {
    specificationVersion: 'v4' as const, provider: 'loopback-fixture', modelId: 'postpay-fixture', supportedUrls: {},
    doGenerate: receive,
    async doStream() {
      const receipt = await receive()
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'finish', usage: receipt.usage, finishReason: receipt.finishReason, providerMetadata: receipt.providerMetadata })
        controller.close()
      } }) }
    },
  }
  const workspace = randomUUID()
  await store.verify(workspace, 'cus_synthetic_postpay', `synthetic-${workspace}`)
  await pool.query('UPDATE hosted_allowances SET remaining=1 WHERE "workspaceId"=$1', [workspace])
  const { hostedModel } = await import('./model')
  const model = await hostedModel(workspace, 'postpay-fixture', provider)
  const firstCall = model.doGenerate({ prompt: [] })
  await Promise.race([arrived, firstCall.then(() => { throw Error('Provider responded before the held receipt') })])
  try {
    assert.equal(providerCalls, 1, 'a positive balance is sufficient even below the old estimated maximum')
    assert.deepEqual(await store.balance(workspace), { verified: true, free: 1, purchased: 0 })
    const row = (await pool.query('SELECT "reservedFree","reservedPurchased","reservedUnpaid","costMicroUsd" FROM hosted_usage WHERE "workspaceId"=$1', [workspace])).rows[0]
    assert.deepEqual(Object.values(row).map(value => value === null ? null : Number(value)), [0, 0, 0, null])
  } finally { releaseFirst(); await firstCall }
  assert.deepEqual(await store.balance(workspace), { verified: true, free: 0, purchased: 0 })
  const receipt = (await store.recent(workspace))[0]
  assert.equal(Number(receipt.costMicroUsd), 2)
  assert.equal(Number(receipt.freeMicroUsd), 1)
  assert.equal(Number(receipt.purchasedMicroUsd), 1, 'actual overrun is retained as debt')
  const denied = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => index % 2 ? model.doGenerate({ prompt: [] }) : model.doStream({ prompt: [] })))
  assert.equal(denied.filter(result => result.status === 'fulfilled').length, 0)
  assert.equal(providerCalls, 1, 'exhausted balance never reaches provider transport')

  async function credit() {
    await pool.query('INSERT INTO workspace_credit_grants (id,"workspaceId",bucket,points,reason,"externalId") VALUES ($1,$2,\'purchased\',1,\'Synthetic test credit\',$3)', [randomUUID(), workspace, randomUUID()])
  }
  await credit()
  assert.equal((await store.balance(workspace)).purchased, 9_999)
  cost = '0.009999'
  await model.doGenerate({ prompt: [] })
  assert.equal(providerCalls, 2)
  const paid = (await store.recent(workspace))[0], settled = await store.balance(workspace)
  await Promise.all([store.settle(paid.id, 9_999), store.settle(paid.id, 9_999)])
  assert.deepEqual(await store.balance(workspace), settled)
  assert.equal(settled.purchased, 0)
  await assert.rejects(Promise.resolve(model.doStream({ prompt: [] })), /free_allowance_used/)
  assert.equal(providerCalls, 2)
  await credit()
  cost = '0.01'
  const { stream } = await model.doStream({ prompt: [] })
  const reader = stream.getReader()
  try {
    for (;;) { if ((await reader.read()).done) break }
  } finally { reader.releaseLock() }
  assert.equal(providerCalls, 3)
  assert.equal((await store.balance(workspace)).purchased, 0)
})
