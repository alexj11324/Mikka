import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
mock.module(new URL('../billing/organization-account.ts', import.meta.url).href, { namedExports: {
  resolvePlatformBillingAccount: async (workspaceId: string) => ({ organizationId: null, accountWorkspaceId: workspaceId }),
} })

// The default model: ZeroCat first, admitted on its own route and billed from
// token usage; its Gateway route only when ZeroCat fails before the first token.
const saved = { key: process.env.ZEROCAT_API_KEY, url: process.env.ZEROCAT_BASE_URL }
const reservations: string[] = [], settlements: Array<{ cost: number | null; input?: number; output?: number; generationId?: string }> = []
const admissions: Array<{ kind: string; model: string; endpoint?: string }> = []
const zeroCatSent: Array<{ providerOptions?: Record<string, unknown>; maxOutputTokens?: number }> = [], gatewaySent: typeof zeroCatSent = []
const routes: Array<Record<string, unknown>> = []
let providerConfig: Record<string, unknown> | undefined, chatModelId: string | undefined
let zeroCatFailure: Error | undefined, zeroCatStream: (() => ReadableStream) | undefined, zeroCatDenied = false
const usage = { inputTokens: { total: 50_000, cacheRead: 40_000 }, outputTokens: { total: 400, reasoning: 150 } }
const finish = (providerMetadata?: unknown) => ({ type: 'finish', usage, finishReason: { unified: 'stop', raw: 'stop' }, ...(providerMetadata ? { providerMetadata } : {}) })
const stream = (...parts: unknown[]) => new ReadableStream({ start(c) { for (const part of parts) c.enqueue(part); c.close() } })
const gatewayMetadata = { gateway: { cost: '0.003', generationId: 'gen-fallback', routing: { modelAttempts: [{ success: true, providerAttempts: [
  { success: false, credentialType: 'byok' }, { success: true, credentialType: 'system' }] }] } } }
const statusError = (statusCode: number) => Object.assign(new Error('zerocat failed'), { name: 'AI_APICallError', statusCode })
const zeroCatModel = {
  specificationVersion: 'v4', provider: 'zerocat.chat', modelId: 'deepseek-v4.1-flash', supportedUrls: {},
  async doGenerate(options: (typeof zeroCatSent)[number]) {
    zeroCatSent.push(options)
    if (zeroCatFailure) throw zeroCatFailure
    return { content: [{ type: 'text', text: 'hi' }], usage, finishReason: { unified: 'stop', raw: 'stop' }, warnings: [] }
  },
  async doStream(options: (typeof zeroCatSent)[number]) {
    zeroCatSent.push(options)
    if (zeroCatFailure) throw zeroCatFailure
    return { stream: zeroCatStream?.() ?? stream({ type: 'stream-start', warnings: [] }, { type: 'text-delta', id: 't', delta: 'hi' }, finish()) }
  },
}
const gatewayModel = {
  specificationVersion: 'v4', provider: 'gateway', modelId: 'deepseek/deepseek-v4.1-flash', supportedUrls: {},
  async doGenerate(options: (typeof gatewaySent)[number]) {
    gatewaySent.push(options)
    return { content: [{ type: 'text', text: 'from gateway' }], usage, finishReason: { unified: 'stop', raw: 'stop' }, warnings: [], providerMetadata: gatewayMetadata }
  },
  async doStream(options: (typeof gatewaySent)[number]) {
    gatewaySent.push(options)
    return { stream: stream({ type: 'text-delta', id: 't', delta: 'from gateway' }, finish(gatewayMetadata)) }
  },
}
mock.module('ai', { namedExports: { gateway: () => gatewayModel, createGateway: () => () => ({ ...gatewayModel }) } })
mock.module('@ai-sdk/openai-compatible', { namedExports: { createOpenAICompatible: (config: Record<string, unknown>) => {
  providerConfig = config
  return { chatModel: (id: string) => { chatModelId = id; return zeroCatModel } }
} } })
mock.module(new URL('../model-admission/runtime.ts', import.meta.url).href, { namedExports: { modelAdmission: {
  async gateway(_scope: unknown, model: string) { admissions.push({ kind: 'gateway', model }); return null },
  async zeroCat(_scope: unknown, model: string, endpoint: string) {
    admissions.push({ kind: 'zerocat', model, endpoint })
    if (zeroCatDenied) throw new ModelAdmissionError('modelRouteDenied')
    return null
  },
} } })
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  canUseMikkaPaid: async () => {},
  hostedUsage: {
    reserve: async (_ws: string, _model: string, id: string) => { reservations.push(id) },
    recordGeneration: async () => {},
    settle: async (_id: string, cost: number | null, input?: number, output?: number, generationId?: string) => {
      settlements.push({ cost, input, output, ...(generationId ? { generationId } : {}) })
    },
  },
} })
mock.module(new URL('./alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

let hostedModel: (typeof import('./model'))['hostedModel']
let createTrustedGatewayModel: (typeof import('./model'))['createTrustedGatewayModel']
let zeroCat: typeof import('./zerocat')
let ModelAdmissionError: (typeof import('../model-admission/contract'))['ModelAdmissionError']
const DEFAULT = 'deepseek/deepseek-v4.1-flash'
const ZEROCAT_COST = Math.ceil(10_000 * 0.12 + 40_000 * 0.012 + 400 * 1)
const drain = async (readable: ReadableStream) => {
  const parts: Array<{ type: string; delta?: string }> = []
  const reader = readable.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) parts.push(next.value)
  return parts
}
before(async () => {
  ;({ hostedModel, createTrustedGatewayModel } = await import('./model'))
  zeroCat = await import('./zerocat')
  ;({ ModelAdmissionError } = await import('../model-admission/contract'))
})
beforeEach(t => {
  if (!('mock' in t)) return
  process.env.ZEROCAT_API_KEY = 'synthetic-zerocat-key'
  process.env.ZEROCAT_BASE_URL = 'https://zero.cat/v1/'
  reservations.length = settlements.length = admissions.length = zeroCatSent.length = gatewaySent.length = routes.length = 0
  providerConfig = chatModelId = zeroCatFailure = zeroCatStream = undefined
  zeroCatDenied = false
  zeroCat?.resumeZeroCat()
  t.mock.method(console, 'info', (line: string) => { const value = JSON.parse(line); if (value.event === 'default_model_route') routes.push(value) })
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
  assert.deepEqual(admissions.map(a => a.kind), ['zerocat', 'zerocat'])
  assert.equal(admissions[0].endpoint, 'https://zero.cat/v1')
  // Gateway routing options never reach ZeroCat; the output cap still holds.
  assert.deepEqual(zeroCatSent[0].providerOptions, { zerocat: { user: 'x' } })
  assert.equal(zeroCatSent[0].maxOutputTokens, 4096)
  assert.equal(gatewaySent.length, 0)
  assert.equal(result.usage.outputTokens.total, 400)
  // 10k uncached + 40k cached input and 400 output tokens at the list price.
  assert.deepEqual(settlements, [{ cost: ZEROCAT_COST, input: 50_000, output: 400 }])
  const { 'mikka.model.zerocat_ms': ms, ...route } = routes[0]
  assert.equal(typeof ms, 'number')
  assert.deepEqual(route, { event: 'default_model_route', 'mikka.model.id': DEFAULT, 'mikka.model.route': 'zerocat' })
})

test('a streamed default-model turn settles its cost from the finish usage', async () => {
  const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  const parts = await drain((await wrapped.doStream({ prompt: [] } as never)).stream)
  assert.deepEqual(parts.map(part => part.type), ['stream-start', 'text-delta', 'finish'])
  assert.equal(reservations.length, 1)
  assert.deepEqual(settlements.map(s => s.cost), [ZEROCAT_COST])
  assert.equal(gatewaySent.length, 0)
  assert.equal(routes[0]['mikka.model.route'], 'zerocat')
})

for (const [status, reason] of [[500, 'server_error'], [503, 'server_error'], [429, 'rate_limited'], [402, 'quota']] as const)
  test(`a ZeroCat ${status} goes to the Gateway route, billed by Gateway's receipt`, async () => {
    zeroCatFailure = statusError(status)
    const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
    const result = await wrapped.doGenerate({ prompt: [], providerOptions: { gateway: { order: ['other'] } } } as never)
    assert.deepEqual(result.content, [{ type: 'text', text: 'from gateway' }])
    assert.deepEqual(admissions.map(a => a.kind), ['zerocat', 'zerocat', 'gateway'])
    assert.deepEqual(gatewaySent[0].providerOptions, { gateway: { order: ['other'], user: 'workspace' } })
    assert.deepEqual(settlements, [{ cost: 3000, input: 50_000, output: 400, generationId: 'gen-fallback' }])
    const { 'mikka.model.zerocat_ms': ms, ...route } = routes[0]
    assert.equal(typeof ms, 'number')
    assert.deepEqual(route, { event: 'default_model_route', 'mikka.model.id': DEFAULT, 'mikka.model.route': 'gateway',
      'mikka.model.fallback_reason': reason, 'mikka.model.zerocat_status': status, 'mikka.model.gateway_credential': 'system',
      'mikka.model.zerocat_error': 'AI_APICallError' })
  })

test('a network failure or timeout before ZeroCat answers goes to Gateway', async () => {
  for (const [failure, reason] of [[new TypeError('fetch failed'), 'network'], [new DOMException('slow', 'TimeoutError'), 'timeout']] as const) {
    routes.length = 0; zeroCatFailure = failure; zeroCat.resumeZeroCat()
    const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
    const parts = await drain((await wrapped.doStream({ prompt: [] } as never)).stream)
    assert.deepEqual(parts.map(part => part.delta).filter(Boolean), ['from gateway'])
    assert.equal(routes[0]['mikka.model.fallback_reason'], reason)
  }
})

test('missing ZeroCat variables or another base URL use the Gateway route, before any ZeroCat request', async () => {
  for (const [change, reason] of [[() => delete process.env.ZEROCAT_API_KEY, 'unconfigured'], [() => delete process.env.ZEROCAT_BASE_URL, 'unconfigured'],
    [() => { process.env.ZEROCAT_BASE_URL = 'https://example.invalid/v1' }, 'endpoint_unexpected']] as const) {
    process.env.ZEROCAT_API_KEY = 'synthetic-zerocat-key'; process.env.ZEROCAT_BASE_URL = 'https://zero.cat/v1'
    routes.length = admissions.length = 0
    change()
    const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
    assert.deepEqual((await wrapped.doGenerate({ prompt: [] } as never)).content, [{ type: 'text', text: 'from gateway' }])
    assert.equal(zeroCatSent.length, 0)
    assert.deepEqual(admissions.map(a => a.kind), ['gateway', 'gateway'])
    assert.equal(routes[0]['mikka.model.fallback_reason'], reason)
  }
})

test('a workspace rule that admits only the Gateway route sends the default model there', async () => {
  zeroCatDenied = true
  const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  assert.deepEqual((await wrapped.doGenerate({ prompt: [] } as never)).content, [{ type: 'text', text: 'from gateway' }])
  assert.equal(zeroCatSent.length, 0)
  assert.equal(routes[0]['mikka.model.fallback_reason'], 'route_denied')
})

test('a stream error before the first token goes to Gateway; after it the stream fails as is', async () => {
  zeroCatStream = () => stream({ type: 'stream-start', warnings: [] }, { type: 'error', error: statusError(503) })
  let wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  assert.deepEqual((await drain((await wrapped.doStream({ prompt: [] } as never)).stream)).map(part => part.delta).filter(Boolean), ['from gateway'])
  assert.equal(routes[0]['mikka.model.fallback_reason'], 'server_error')

  routes.length = gatewaySent.length = 0
  zeroCat.resumeZeroCat()
  zeroCatStream = () => { let pulls = 0; return new ReadableStream({ pull(c) {
    if (pulls++ === 0) c.enqueue({ type: 'text-delta', id: 't', delta: 'half' }); else c.error(new Error('connection reset'))
  } }) }
  wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  const reader = (await wrapped.doStream({ prompt: [] } as never)).stream.getReader()
  assert.equal(((await reader.read()).value as { delta?: string }).delta, 'half')
  await assert.rejects(reader.read(), /connection reset/)
  assert.equal(gatewaySent.length, 0, 'no provider switch once the reply has started')
  assert.equal(routes[0]['mikka.model.route'], 'zerocat')
})

test('a cancelled call never falls back', async () => {
  const controller = new AbortController()
  zeroCatFailure = new DOMException('stopped', 'AbortError')
  const wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  const pending = wrapped.doGenerate({ prompt: [], abortSignal: controller.signal } as never)
  controller.abort(new DOMException('stopped', 'AbortError'))
  await assert.rejects(Promise.resolve(pending))
  assert.equal(gatewaySent.length, 0)
})

test('only the trusted Gateway transport may be handed in for the default model, and only as its fallback', async () => {
  await assert.rejects(hostedModel('workspace', DEFAULT, zeroCatModel as never, 'alice'), /modelRouteDenied/)
  const trusted = await createTrustedGatewayModel(DEFAULT)
  const wrapped = await hostedModel('workspace', DEFAULT, trusted, 'alice')
  await wrapped.doGenerate({ prompt: [] } as never)
  assert.equal(zeroCatSent.length, 1)
  assert.equal(gatewaySent.length, 0)
})

test('missing token counts leave the cost unknown, never free', () => {
  assert.equal(zeroCat.zeroCatCost(undefined), null)
  assert.equal(zeroCat.zeroCatCost({ inputTokens: { total: undefined }, outputTokens: { total: 3 } }), null)
  assert.equal(zeroCat.zeroCatCost({ inputTokens: { total: 0 }, outputTokens: { total: 0 } }), 0)
})

test('failure reasons come from a closed set', () => {
  assert.equal(zeroCat.zeroCatFailureReason(new Error('x'), true), 'timeout')
  assert.equal(zeroCat.zeroCatFailureReason(statusError(400)), 'request_rejected')
  assert.equal(zeroCat.zeroCatFailureReason(Object.assign(new Error('x'), { name: 'AI_APICallError' })), 'network')
  assert.equal(zeroCat.zeroCatFailureReason(new Error('bad chunk')), 'stream_error')
  assert.equal(zeroCat.gatewayCredential(undefined), undefined)
  assert.equal(zeroCat.gatewayCredential(gatewayMetadata), 'system')
})

test('the route span keeps every attribute through the tracing privacy filter', async () => {
  const { sanitizeAttributes } = await import('../tracing/sanitize')
  zeroCat.recordModelRoute({ model: DEFAULT, route: 'gateway', reason: 'quota', status: 402, credential: 'system' })
  const { event: _event, ...attributes } = routes[0]
  assert.deepEqual(sanitizeAttributes(attributes as never), attributes)
  assert.deepEqual(Object.keys(attributes).sort(), ['mikka.model.fallback_reason', 'mikka.model.gateway_credential', 'mikka.model.id', 'mikka.model.route', 'mikka.model.zerocat_status'])
})

test('a refused redirect is named, the failure is logged by names and code only, and later calls skip ZeroCat for a while', async () => {
  const redirect = Object.assign(new Error('Cannot connect to API: fetch failed https://zero.cat/v1?key=secret'), { name: 'AI_APICallError',
    cause: Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') }) })
  zeroCatFailure = redirect
  let wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  await wrapped.doGenerate({ prompt: [] } as never)
  assert.equal(routes[0]['mikka.model.fallback_reason'], 'redirect')
  assert.equal(routes[0]['mikka.model.zerocat_error'], 'AI_APICallError>TypeError>Error')
  assert.ok(!JSON.stringify(routes).includes('secret'), 'no error message reaches the log')

  // The next call does not wait on ZeroCat again.
  zeroCatFailure = undefined; routes.length = 0; zeroCatSent.length = 0
  wrapped = await hostedModel('workspace', DEFAULT, undefined, 'alice')
  await wrapped.doGenerate({ prompt: [] } as never)
  assert.equal(zeroCatSent.length, 0)
  assert.equal(routes[0]['mikka.model.fallback_reason'], 'paused')
  // After the pause it is tried again.
  assert.equal(zeroCat.zeroCatPaused(Date.now() + zeroCat.ZEROCAT_PAUSE_MS + 1), false)
})

test('a connection error keeps its system code', () => {
  const error = Object.assign(new Error('x'), { name: 'AI_APICallError', cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) }) })
  assert.deepEqual(zeroCat.zeroCatFailureDetail(error), { error: 'AI_APICallError>TypeError>Error', code: 'ECONNRESET' })
  assert.equal(zeroCat.zeroCatFailureReason(error), 'network')
})
