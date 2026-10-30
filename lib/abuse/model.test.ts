import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
let verified = true,
  allow = true
const reservations: string[] = [],
  settlements: Array<{ id: string; cost: number | null }> = []
let generated = 0,
  streamed = 0,
  cost: unknown = '0.002'
const usage = { inputTokens: { total: 12 }, outputTokens: { total: 3 } }
const model = {
  specificationVersion: 'v4',
  provider: 'fixture',
  modelId: 'fixture-model',
  supportedUrls: {},
  async doGenerate() {
    generated++
    return {
      content: [{ type: 'text', text: 'fixture' }],
      usage,
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
      providerMetadata: { gateway: { cost } },
    }
  },
  async doStream() {
    streamed++
    return {
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-delta', id: 't', delta: 'fixture' })
          c.enqueue({
            type: 'finish',
            usage,
            finishReason: { unified: 'stop', raw: 'stop' },
            providerMetadata: { gateway: { cost } },
          })
          c.close()
        },
      }),
    }
  },
}
const gateway = Object.assign(() => model, {
  getAvailableModels: async () => ({
    models: [
      {
        id: 'fixture-model',
        pricing: { input: '0.000001', output: '0.000001' },
      },
    ],
  }),
})
mock.module('ai', { namedExports: { gateway } })
mock.module(new URL('./runtime.ts', import.meta.url).href, {
  namedExports: {
    canUseMikkaPaid: async () => {
      if (!verified) throw Error('verification_required')
    },
    hostedUsage: {
      reserve: async (_ws: string, _model: string, id: string) => {
        if (!allow) throw Error('points_exhausted')
        reservations.push(id)
      },
      settle: async (id: string, cost: number | null) => {
        settlements.push({ id, cost })
      },
    },
  },
})
mock.module(new URL('./alerts.ts', import.meta.url).href, {
  namedExports: { checkAbuseAlerts: async () => {} },
})
let hostedModel: (typeof import('./model'))['hostedModel']
before(async () => {
  ;({ hostedModel } = await import('./model'))
})
beforeEach(() => {
  verified = true
  allow = true
  cost = '0.002'
  generated = 0
  streamed = 0
  reservations.length = 0
  settlements.length = 0
})
test('verification and zero balance prevent provider I/O, including another tool step', async () => {
  verified = false
  await assert.rejects(
    hostedModel('workspace', 'fixture-model'),
    /verification_required/,
  )
  assert.equal(generated + streamed, 0)
  verified = true
  const wrapped = await hostedModel('workspace', 'fixture-model')
  await wrapped.doGenerate({ prompt: [] })
  allow = false
  await assert.rejects(
    Promise.resolve(wrapped.doGenerate({ prompt: [] })),
    /points_exhausted/,
  )
  assert.equal(generated, 1)
  assert.equal(settlements[0].cost, 2000)
})
test('stream finish settles before delivery; every call has its own ledger identity', async () => {
  const wrapped = await hostedModel('workspace', 'fixture-model')
  const result = await wrapped.doStream({ prompt: [] })
  const reader = result.stream.getReader()
  while (!(await reader.read()).done) {}
  await wrapped.doGenerate({ prompt: [] })
  assert.equal(streamed, 1)
  assert.equal(generated, 1)
  assert.equal(new Set(reservations).size, 2)
  assert.deepEqual(
    settlements.map((row) => row.cost),
    [2000, 2000],
  )
})
test('missing provider cost is held for reconciliation, never silently free', async () => {
  cost = undefined
  await assert.rejects(
    Promise.resolve(
      (await hostedModel('workspace', 'fixture-model')).doGenerate({
        prompt: [],
      }),
    ),
    /usage_cost_unavailable/,
  )
  assert.equal(settlements[0].cost, null)
})
