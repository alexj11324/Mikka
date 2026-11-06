import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'

// The default model goes straight to ZeroCat: admitted on its own route, billed
// from token usage, never through AI Gateway, refused when unconfigured.
const saved = { key: process.env.ZEROCAT_API_KEY, url: process.env.ZEROCAT_BASE_URL }
const reservations: string[] = [], settlements: Array<{ cost: number | null; input?: number; output?: number }> = []
const admissions: Array<{ kind: string; model: string; endpoint?: string }> = []
const sent: Array<{ providerOptions?: Record<string, unknown>; maxOutputTokens?: number }> = []
let providerConfig: Record<string, unknown> | undefined, chatModelId: string | undefined
const usage = { inputTokens: { total: 50_000, cacheRead: 40_000 }, outputTokens: { total: 400, reasoning: 150 } }
const model = {
  specificationVersion: 'v4', provider: 'zerocat.chat', modelId: 'deepseek-v4.1-flash', supportedUrls: {},
  async doGenerate(options: (typeof sent)[number]) {
    sent.push(options)
    return { content: [{ type: 'text', text: 'hi' }], usage, finishReason: { unified: 'stop', raw: 'stop' }, warnings: [] }
  },
  async doStream(options: (typeof sent)[number]) {
    sent.push(options)
    return { stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'text-delta', id: 't', delta: 'hi' })
      c.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' } })
      c.close()
    } }) }
  },
}
const gateway = () => { throw Error('AI Gateway must not be used for the default model') }
mock.module('ai', { namedExports: { gateway, createGateway: gateway } })
mock.module('@ai-sdk/openai-compatible', { namedExports: { createOpenAICompatible: (config: Record<string, unknown>) => {
  providerConfig = config
  return { chatModel: (id: string) => { chatModelId = id; return model } }
} } })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: { modelAdmission: {
  async gateway(_scope: unknown, model: string) { admissions.push({ kind: 'gateway', model }); return null },
  async zeroCat(_scope: unknown, model: string, endpoint: string) { admissions.push({ kind: 'zerocat', model, endpoint }); return null },
} } })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  canUseMikkaPaid: async () => {},
  hostedUsage: {
    reserve: async (_ws: string, _model: string, id: string) => { reservations.push(id) },
    recordGeneration: async () => {},
    settle: async (_id: string, cost: number | null, input?: number, output?: number) => { settlements.push({ cost, input, output }) },
  },
} })
mock.module(new URL('./alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

let hostedModel: (typeof import('./model'))['hostedModel']
let zeroCatCost: (typeof import('./zerocat'))['zeroCatCost']
const DEFAULT = 'deepseek/deepseek-v4.1-flash'
before(async () => {
  ;({ hostedModel } = await import('./model'))
  ;({ zeroCatCost } = await import('./zerocat'))
})
beforeEach(() => {
  process.env.ZEROCAT_API_KEY = 'synthetic-zerocat-key'
  process.env.ZEROCAT_BASE_URL = 'https://zero.cat/v1/'
  reservations.length = settlements.length = admissions.length = sent.length = 0
  providerConfig = chatModelId = undefined
})
after(() => {
  for (const [name, value] of [['ZEROCAT_API_KEY', saved.key], ['ZEROCAT_BASE_URL', saved.url]] as const)
    if (value === undefined) delete process.env[name]; else process.env[name] = value
})

test('the default model calls ZeroCat with the configured key and its own model id', async () => {
  const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  const result = await wrapped.doGenerate({ prompt: [], providerOptions: { gateway: { order: ['other'] }, zerocat: { user: 'x' } } } as never)
  assert.equal(chatModelId, 'deepseek-v4.1-flash')
  assert.equal(providerConfig?.baseURL, 'https://zero.cat/v1')
  assert.equal(providerConfig?.apiKey, 'synthetic-zerocat-key')
  assert.equal(providerConfig?.includeUsage, true)
  assert.deepEqual(admissions, [
    { kind: 'zerocat', model: DEFAULT, endpoint: 'https://zero.cat/v1' },
    { kind: 'zerocat', model: DEFAULT, endpoint: 'https://zero.cat/v1' },
  ])
  // Gateway routing options never reach ZeroCat; the output cap still holds.
  assert.deepEqual(sent[0].providerOptions, { zerocat: { user: 'x' } })
  assert.equal(sent[0].maxOutputTokens, 4096)
  assert.equal(result.usage.outputTokens.total, 400)
  // 10k uncached + 40k cached input and 400 output tokens at the list price.
  assert.deepEqual(settlements, [{ cost: Math.ceil(10_000 * 0.12 + 40_000 * 0.012 + 400 * 1), input: 50_000, output: 400 }])
})

test('a streamed default-model turn settles its cost from the finish usage', async () => {
  const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  const { stream } = await wrapped.doStream({ prompt: [] } as never)
  const reader = stream.getReader()
  while (!(await reader.read()).done) { /* drain */ }
  assert.equal(reservations.length, 1)
  assert.deepEqual(settlements.map(s => s.cost), [2080])
})

test('without both ZeroCat variables the default model refuses as temporarily unavailable, before any reservation', async () => {
  for (const name of ['ZEROCAT_API_KEY', 'ZEROCAT_BASE_URL'] as const) {
    beforeEachReset()
    delete process.env[name]
    await assert.rejects(hostedModel('workspace', DEFAULT, undefined, 'alice'), (error: Error & { code?: string; detail?: string }) =>
      error.code === 'usage_cost_unavailable' && error.detail === 'zerocat_unconfigured')
    assert.equal(reservations.length, 0)
    assert.equal(providerConfig, undefined)
  }
})

test('another endpoint in ZEROCAT_BASE_URL is refused rather than called', async () => {
  process.env.ZEROCAT_BASE_URL = 'https://example.invalid/v1'
  await assert.rejects(hostedModel('workspace', DEFAULT, undefined, 'alice'), /zerocat_endpoint_unexpected/)
})

test('a caller-supplied provider cannot stand in for the ZeroCat transport', async () => {
  await assert.rejects(hostedModel('workspace', DEFAULT, model as never, 'alice'), /modelRouteDenied/)
})

test('missing token counts leave the cost unknown, never free', () => {
  assert.equal(zeroCatCost(undefined), null)
  assert.equal(zeroCatCost({ inputTokens: { total: undefined }, outputTokens: { total: 3 } }), null)
  assert.equal(zeroCatCost({ inputTokens: { total: 0 }, outputTokens: { total: 0 } }), 0)
})

function beforeEachReset() {
  process.env.ZEROCAT_API_KEY = 'synthetic-zerocat-key'
  process.env.ZEROCAT_BASE_URL = 'https://zero.cat/v1'
}
