import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
let verified = true,
  allow = true
const reservations: string[] = [],
  settlements: Array<{ id: string; cost: number | null; generationId?: string }> = [],
  generations: string[] = []
let generated = 0,
  streamed = 0,
  cost: unknown = '0.002'
let managed = false, denyAt: 'prepare' | 'send' | null = null
let beforeSettlement: ((cost: number | null) => Promise<void>) | undefined, generationFailure: Error | undefined
const modelOptions: unknown[] = []
let gatewayConfig: { baseURL?: string; fetch?: typeof fetch; apiKey?: string } | undefined
const usage = { inputTokens: { total: 12 }, outputTokens: { total: 3 } }
const model = {
  specificationVersion: 'v4',
  provider: 'fixture',
  modelId: 'fixture-model',
  supportedUrls: {},
  async doGenerate(options: unknown) {
    generated++
    modelOptions.push(options)
    return {
      content: [{ type: 'text', text: 'fixture' }],
      usage,
      finishReason: { unified: 'stop', raw: 'stop' },
      warnings: [],
      providerMetadata: { gateway: { cost } },
    }
  },
  async doStream(options: unknown) {
    streamed++
    modelOptions.push(options)
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
mock.module('ai', { namedExports: { gateway, createGateway: (options: typeof gatewayConfig) => { gatewayConfig = options; return gateway } } })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: { modelAdmission: {
  async gateway(_scope: unknown, model: string, endpoint: string, options: { auditAllowed?: boolean }) {
    if (denyAt === (options.auditAllowed === false ? 'prepare' : 'send')) throw Error('modelRouteDenied')
    return managed ? { model, endpoint, servingProviders: ['deepseek'], dataRegion: 'unknown' } : null
  },
} } })
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
      recordGeneration: async (_id: string, generationId: string) => { if (generationFailure) throw generationFailure; generations.push(generationId) },
      settle: async (id: string, cost: number | null, _input?: number, _output?: number, generationId?: string) => {
        await beforeSettlement?.(cost)
        settlements.push({ id, cost, ...(generationId ? { generationId } : {}) })
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
  generations.length = 0
  modelOptions.length = 0
  managed = false
  denyAt = null
  gatewayConfig = undefined
  beforeSettlement = undefined
  generationFailure = undefined
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

test('managed provider options replace caller fallback, credentials and provider order', async () => {
  managed = true
  const wrapped = await hostedModel('workspace', 'fixture-model', undefined, 'alice')
  await wrapped.doGenerate({ prompt: [], providerOptions: { gateway: { models: ['forbidden/model'], only: ['forbidden'],
    order: ['forbidden'], byok: { forbidden: [{ apiKey: 'synthetic-never-forward' }] } } } })
  assert.equal(generated, 1)
  assert.deepEqual((modelOptions[0] as { providerOptions: unknown }).providerOptions, {
    gateway: { only: ['deepseek'], order: ['deepseek'], models: [], user: 'workspace' },
  })
  assert.equal(gatewayConfig?.baseURL, 'https://ai-gateway.vercel.sh/v4/ai')
})
test('managed refusal precedes budget reservation; revocation during reservation precedes provider I/O', async () => {
  managed = true
  const wrapped = await hostedModel('workspace', 'fixture-model', undefined, 'alice')
  denyAt = 'prepare'
  await assert.rejects(Promise.resolve(wrapped.doGenerate({ prompt: [] })), /modelRouteDenied/)
  assert.equal(reservations.length, 0)
  assert.equal(generated + streamed, 0)
  denyAt = 'send'
  await assert.rejects(Promise.resolve(wrapped.doStream({ prompt: [] })), /modelRouteDenied/)
  assert.equal(reservations.length, 1)
  assert.equal(generated + streamed, 0)
  assert.equal(settlements[0].cost, 0)
})
test('an unverified injected transport cannot impersonate the managed Gateway endpoint', async () => {
  managed = true
  await assert.rejects(Promise.resolve((await hostedModel('workspace', 'fixture-model', { ...model } as never, 'alice')).doGenerate({ prompt: [] })), /modelRouteDenied/)
  assert.equal(reservations.length, 0)
  assert.equal(generated, 0)
})
test('a trusted custom-key Gateway remains usable under an allowed managed route',async()=>{
  managed=true
  const {createTrustedGatewayModel}=await import('./model')
  const provider=await createTrustedGatewayModel('fixture-model','synthetic-custom-key')
  const wrapped=await hostedModel('workspace','fixture-model',provider,'alice')
  await wrapped.doGenerate({prompt:[]})
  assert.equal(generated,1)
  assert.equal(gatewayConfig?.apiKey,'synthetic-custom-key')
  assert.equal(gatewayConfig?.baseURL,'https://ai-gateway.vercel.sh/v4/ai')
  denyAt='prepare'
  await assert.rejects(Promise.resolve(wrapped.doGenerate({prompt:[]})),/modelRouteDenied/)
  assert.equal(generated,1)
})

for (const ending of ['error', 'cancel', 'finish'] as const) test(`early Gateway identity survives ${ending} without invented cost`, async () => {
  let controller!: ReadableStreamDefaultController
  let cancelled = false
  const source = new ReadableStream({
    start(value) {
      controller = value
      value.enqueue({ type: 'text-delta', id: 't', delta: 'Partial', providerMetadata: { gateway: { generationId: 'synthetic-generation' } } })
    },
    cancel() { cancelled = true },
  })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const reader = (await wrapped.doStream({ prompt: [] })).stream.getReader()
  await reader.read()
  assert.deepEqual(generations, ['synthetic-generation'], 'identity is persisted before content reaches the caller')
  assert.equal(settlements.length, 0, 'the identity alone does not settle or debit money')
  if (ending === 'cancel') {
    await reader.cancel()
    assert.equal(cancelled, true)
  } else if (ending === 'error') {
    controller.error(new Error('Synthetic interrupted transport'))
    await assert.rejects(reader.read(), /interrupted transport/)
  } else {
    controller.enqueue({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' }, providerMetadata: { gateway: { cost: '0.002' } } })
    controller.close()
    while (!(await reader.read()).done) {}
  }
  assert.ok(settlements.length)
  assert.ok(settlements.every(row => row.generationId === 'synthetic-generation'))
  assert.equal(settlements.at(-1)?.cost, ending === 'finish' ? 2000 : null)
})


test('consumer cancellation stops upstream before blocked settlement and safely completes a pending read', async () => {
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const settling = new Promise<void>(resolve => { entered = resolve })
  beforeSettlement = async () => { entered(); await blocked }
  let cancelled = false
  const source = new ReadableStream({ cancel() { cancelled = true } })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const reader = (await wrapped.doStream({ prompt: [] })).stream.getReader()
  const reading = reader.read(), stopping = reader.cancel('Browser disconnected')
  try {
    await settling
    assert.equal(cancelled, true, 'accounting latency cannot leave the provider generating after cancellation')
    assert.equal((await reading).done, true)
    assert.equal(settlements.length, 0)
  } finally { release(); await stopping }
  assert.equal(settlements.length, 1, 'the cancelled pending pull must not settle a second time')
  assert.equal(settlements[0].cost, null)
})

test('cancel still stops upstream when unknown-cost settlement fails, and rejects the accounting failure', async () => {
  beforeSettlement = async () => { throw Error('Synthetic accounting database unavailable') }
  let cancelled = false
  const source = new ReadableStream({ cancel() { cancelled = true } })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const stream = (await wrapped.doStream({ prompt: [] })).stream
  await assert.rejects(stream.cancel('Browser disconnected'), /accounting database unavailable/)
  assert.equal(cancelled, true)
  assert.equal(settlements.length, 0, 'a failed accounting write is not a successful or zero-cost settlement')
})

test('a stream processing error stops upstream before waiting for its unknown-cost settlement', async () => {
  generationFailure = new Error('Synthetic generation identity persistence failed')
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const settling = new Promise<void>(resolve => { entered = resolve })
  beforeSettlement = async () => { entered(); await blocked }
  let cancelled = false
  const source = new ReadableStream({
    start(controller) { controller.enqueue({ type: 'text-delta', id: 't', delta: 'Partial', providerMetadata: { gateway: { generationId: 'synthetic-generation' } } }) },
    cancel() { cancelled = true },
  })
  const wrapped = await hostedModel('workspace', 'fixture-model', { ...model, doStream: async () => ({ stream: source }) } as never)
  const reader = (await wrapped.doStream({ prompt: [] })).stream.getReader()
  const reading = assert.rejects(reader.read(), /generation identity persistence failed/)
  try { await settling; assert.equal(cancelled, true) }
  finally { release(); await reading }
  assert.equal(settlements.at(-1)?.cost, null)
})
