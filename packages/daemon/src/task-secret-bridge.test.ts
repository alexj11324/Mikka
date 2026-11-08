import { randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type RequestOptions, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { taskSecretAccessSchema, type TaskSecretAccess } from '@mikka/protocol/task-secrets'
import { startTaskSecretBridge, TASK_SECRET_DUMMY_KEY } from './task-secret-bridge'

interface EgressMessage {
  capability: string
  method: string
  path: string
  headers: Array<[string, string]>
  bodyBase64?: string
}

interface EgressCall {
  message: EgressMessage
  method: string | undefined
  path: string | undefined
  headers: IncomingHttpHeaders
}

const cleanups: Array<() => void | Promise<void>> = []
const fixtureErrors: unknown[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  expect(fixtureErrors.splice(0)).toEqual([])
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function bytes(request: IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const server = createServer((request, response) => {
    void Promise.resolve().then(() => handler(request, response)).catch(error => {
      fixtureErrors.push(error)
      response.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

function envelope(response: ServerResponse, body = Buffer.from('ok'), status = 200, headers: Record<string, string> = {}) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ status, headers, bodyBase64: body.toString('base64') }))
}

async function fixture(
  respond: (message: EgressMessage, response: ServerResponse, canary: string) => void | Promise<void> = (_message, response) => envelope(response),
  options: { expiresAt?: string; unavailable?: string[] } = {},
) {
  // The opaque handle is random and unrelated to the synthetic plaintext.
  // Only the trusted HTTP fixture receives the latter; it is never in a grant.
  const canary = `secret-canary-${randomBytes(24).toString('hex')}`
  const capability = `opaque-lease-${randomBytes(32).toString('base64url')}`
  const authorized = new Map([[capability, canary]])
  const calls: EgressCall[] = []
  const egress = await serve(async (request, response) => {
    const message = JSON.parse((await bytes(request)).toString('utf8')) as EgressMessage
    calls.push({ message, method: request.method, path: request.url, headers: request.headers })
    const secret = authorized.get(message.capability)
    if (!secret) { response.writeHead(401); response.end(); return }
    await respond(message, response, secret)
  })
  const current: { access: TaskSecretAccess | undefined } = { access: taskSecretAccessSchema.parse({
    version: 1,
    endpoint: `${egress}/invoke`,
    grants: [{ name: 'SERVICE_API_KEY', capability, origin: 'https://third-party.invalid',
      expiresAt: options.expiresAt ?? new Date(Date.now() + 300_000).toISOString() }],
    unavailable: options.unavailable ?? [],
  }) }
  const controller = new AbortController()
  const bridge = await startTaskSecretBridge({ current: () => current.access, signal: controller.signal })
  if (!bridge) throw new Error('Expected a task Secret bridge')
  cleanups.push(() => bridge.close())
  const endpoint = (JSON.parse(bridge.env.MIKKA_SECRET_ENDPOINTS) as Record<string, string>).SERVICE_API_KEY
  return { bridge, endpoint, controller, current, calls, capability, canary, authorized }
}

function localRequest(url: string, options: { method?: string; headers?: RequestOptions['headers']; body?: string } = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const request = httpRequest(url, { method: options.method ?? 'GET', headers: options.headers }, response => {
      void bytes(response).then(body => resolve({ status: response.statusCode!, headers: response.headers, body }), reject)
    })
    request.once('error', reject)
    request.end(options.body)
  })
}

describe('task Secret bridge over real loopback HTTP', () => {
  it('accepts an ordinary SDK-style fetch with a dummy key; only trusted egress injects the plaintext', async () => {
    const providerCalls: Array<{ path: string; authorization: string | undefined; body: string }> = []
    const provider = await serve(async (request, response) => {
      providerCalls.push({ path: request.url!, authorization: request.headers.authorization, body: (await bytes(request)).toString('utf8') })
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'created-by-protected-sdk' }))
    })
    const state = await fixture(async (message, response, canary) => {
      const result = await fetch(`${provider}${message.path}`, {
        method: message.method,
        headers: { ...Object.fromEntries(message.headers), authorization: `Bearer ${canary}` },
        body: message.bodyBase64 ? Buffer.from(message.bodyBase64, 'base64').toString('utf8') : undefined,
      })
      envelope(response, Buffer.from(await result.arrayBuffer()), result.status, { 'content-type': result.headers.get('content-type')! })
    })
    const requestBody = JSON.stringify({ label: 'SDK request', count: 2 })
    const response = await fetch(`${state.endpoint}/v1/widgets?limit=2`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TASK_SECRET_DUMMY_KEY}`, 'content-type': 'application/json', 'idempotency-key': 'synthetic-request-1' },
      body: requestBody,
    })
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 'created-by-protected-sdk' })
    expect(providerCalls).toEqual([{ path: '/v1/widgets?limit=2', authorization: `Bearer ${state.canary}`, body: requestBody }])
    expect(state.calls).toHaveLength(1)
    const call = state.calls[0]
    expect(call).toMatchObject({ method: 'POST', path: '/invoke', message: { capability: state.capability, method: 'POST', path: '/v1/widgets?limit=2' } })
    expect(call.message.headers).toEqual(expect.arrayContaining([['content-type', 'application/json'], ['idempotency-key', 'synthetic-request-1']]))
    expect(call.message.headers.some(([name]) => name === 'authorization')).toBe(false)
    expect(call.headers.authorization).toBeUndefined()
    expect(Buffer.from(call.message.bodyBase64!, 'base64').toString('utf8')).toBe(requestBody)
    expect(JSON.stringify(call)).not.toContain(state.canary)
    expect(JSON.stringify(state.current.access)).not.toContain(state.canary)
    for (const hidden of [state.canary, state.capability]) {
      expect(JSON.stringify(state.bridge.env)).not.toContain(hidden)
      expect(state.bridge.instructions).not.toContain(hidden)
    }
  })

  it.each([201, 429, 503])('preserves provider status %i and exact bytes, with only safe response headers', async status => {
    const body = Buffer.from([0, 1, 255, 128, 10, 65])
    const state = await fixture((_message, response, canary) => envelope(response, body, status, {
      'content-type': 'application/octet-stream', 'retry-after': '7',
      'set-cookie': `session=${canary}`, authorization: `Bearer ${canary}`, location: 'https://unapproved.invalid',
    }))
    const response = await localRequest(`${state.endpoint}/v1/download`, { headers: { 'x-api-key': TASK_SECRET_DUMMY_KEY } })
    expect(response.status).toBe(status)
    expect(response.body).toEqual(body)
    expect(response.headers).toMatchObject({ 'content-type': 'application/octet-stream', 'retry-after': '7', 'cache-control': 'no-store' })
    for (const name of ['set-cookie', 'authorization', 'location']) expect(response.headers[name]).toBeUndefined()
  })

  it.each([
    ['Host', { host: 'attacker.invalid' }],
    ['Origin', { origin: 'https://attacker.invalid' }],
    ['browser fetch site', { 'sec-fetch-site': 'cross-site' }],
    ['non-dummy authorization', { authorization: 'Bearer synthetic-exfiltration-attempt' }],
    ['non-dummy API key', { 'x-api-key': 'synthetic-exfiltration-attempt' }],
    ['cookie', { cookie: 'session=synthetic-browser-session' }],
    ['caller-selected destination', { 'x-forwarded-host': 'attacker.invalid' }],
    ['unapproved arbitrary header', { 'x-arbitrary-header': 'unexpected' }],
  ] as const)('rejects %s before contacting egress', async (_label, headers) => {
    const state = await fixture()
    const response = await localRequest(`${state.endpoint}/v1/widgets`, { headers })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ code: 'task_secret_unavailable', detail: 'invalid_request' })
    expect(state.calls).toHaveLength(0)
  })

  it('rejects a wrong nonce without reaching the opaque grant', async () => {
    const state = await fixture()
    const url = new URL(state.endpoint)
    url.pathname = '/wrong-nonce/SERVICE_API_KEY/v1/widgets'
    const response = await localRequest(url.toString())
    expect(response.status).toBe(404)
    expect(state.calls).toHaveLength(0)
  })

  it('rejects duplicate caller authentication headers instead of merging them', async () => {
    const state = await fixture()
    const response = await localRequest(`${state.endpoint}/v1/widgets`, { headers: [
      'Host', new URL(state.endpoint).host,
      'X-Api-Key', TASK_SECRET_DUMMY_KEY,
      'x-api-key', TASK_SECRET_DUMMY_KEY,
    ] })
    expect(response.status).toBe(403)
    expect(state.calls).toHaveLength(0)
  })

  it('refuses an expired grant before issuing an egress request', async () => {
    const state = await fixture(undefined, { expiresAt: new Date(Date.now() - 1_000).toISOString() })
    const response = await localRequest(`${state.endpoint}/v1/widgets`)
    expect(response.status).toBe(410)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ code: 'task_secret_unavailable', detail: 'expired_capability' })
    expect(state.calls).toHaveLength(0)
  })

  it('does not release an upstream body after its grant expires in flight', async () => {
    const arrived = deferred<ServerResponse>()
    const expires = Date.now() + 300_000
    const state = await fixture((_message, response) => { arrived.resolve(response) }, { expiresAt: new Date(expires).toISOString() })
    const pending = localRequest(`${state.endpoint}/v1/widgets`)
    const upstream = await arrived.promise
    vi.spyOn(Date, 'now').mockReturnValue(expires)
    envelope(upstream, Buffer.from('expired-provider-response'))
    const response = await pending
    expect(response.status).toBe(410)
    expect(response.body.toString('utf8')).not.toContain('expired-provider-response')
  })

  it('uses each heartbeat replacement token without restarting the SDK endpoint', async () => {
    const state = await fixture()
    expect((await localRequest(`${state.endpoint}/v1/first`)).status).toBe(200)
    const renewed = `renewed-opaque-lease-${randomBytes(32).toString('base64url')}`
    const initial = state.current.access!
    state.authorized.delete(state.capability)
    state.authorized.set(renewed, state.canary)
    state.current.access = taskSecretAccessSchema.parse({ ...initial,
      grants: [{ ...initial.grants[0], capability: renewed, expiresAt: new Date(Date.now() + 600_000).toISOString() }],
    })
    expect((await localRequest(`${state.endpoint}/v1/second`)).status).toBe(200)
    expect(state.calls.map(call => call.message.capability)).toEqual([state.capability, renewed])
    expect(JSON.parse(state.bridge.env.MIKKA_SECRET_ENDPOINTS)).toEqual({ SERVICE_API_KEY: state.endpoint })
    expect(JSON.stringify(state.bridge.env)).not.toContain(renewed)
    state.current.access = { ...state.current.access, grants: [] }
    expect((await localRequest(`${state.endpoint}/v1/removed`)).status).toBe(409)
    expect(state.calls).toHaveLength(2)
  })

  it.each(['run abort', 'explicit close'] as const)('%s cancels an in-flight egress request and closes the listening endpoint', async action => {
    const arrived = deferred<ServerResponse>()
    const upstreamClosed = deferred<void>()
    const state = await fixture((_message, response) => {
      response.once('close', () => { upstreamClosed.resolve() })
      arrived.resolve(response)
    })
    const outcome = localRequest(`${state.endpoint}/v1/slow`).then(() => 'response', () => 'disconnected')
    await arrived.promise
    if (action === 'run abort') state.controller.abort()
    else state.bridge.close()
    expect(await outcome).toBe('disconnected')
    await upstreamClosed.promise
    await expect(localRequest(`${state.endpoint}/v1/after-close`)).rejects.toThrow()
    expect(state.calls).toHaveLength(1)
    expect(() => state.bridge.close()).not.toThrow()
  })

  it.each([401, 410, 500])('sanitizes an egress HTTP %i failure instead of returning its raw body', async status => {
    const state = await fixture((_message, response, canary) => {
      response.writeHead(status, { 'content-type': 'text/plain' })
      response.end(`egress diagnostic contains ${canary}`)
    })
    const response = await localRequest(`${state.endpoint}/v1/widgets`)
    expect(response.status).toBe(status === 500 ? 502 : 410)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ code: 'task_secret_unavailable', detail: status === 500 ? 'invalid_request' : 'expired_capability' })
    expect(response.body.toString('utf8')).not.toContain(state.canary)
  })

  it('reports unavailable names without manufacturing keys or an implicit direct-exposure fallback', async () => {
    const state = await fixture(undefined, { unavailable: ['PRIVATE_NPM_TOKEN', 'DATABASE_URL'] })
    expect(Object.keys(state.bridge.env).sort()).toEqual(['MIKKA_SECRET_ENDPOINTS', 'MIKKA_SECRET_UNAVAILABLE'])
    expect(JSON.parse(state.bridge.env.MIKKA_SECRET_UNAVAILABLE)).toEqual(['PRIVATE_NPM_TOKEN', 'DATABASE_URL'])
    expect(state.bridge.instructions).toContain('PRIVATE_NPM_TOKEN')
    expect(state.bridge.instructions).toContain('DATABASE_URL')
    const url = new URL(state.endpoint)
    url.pathname = url.pathname.replace('/SERVICE_API_KEY', '/PRIVATE_NPM_TOKEN/v1/packages')
    const response = await localRequest(url.toString())
    expect(response.status).toBe(409)
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ code: 'task_secret_unavailable', detail: 'configuration' })
    expect(state.calls).toHaveLength(0)
  })

  it('leaves tasks with no protected metadata alone and supports unavailable-only assignments', async () => {
    const signal = new AbortController().signal
    expect(await startTaskSecretBridge({ current: () => undefined, signal })).toBeUndefined()
    const access = taskSecretAccessSchema.parse({ version: 1, endpoint: 'https://egress.invalid/invoke', grants: [], unavailable: [] })
    expect(await startTaskSecretBridge({ current: () => access, signal })).toBeUndefined()
    const bridge = await startTaskSecretBridge({ current: () => ({ ...access, unavailable: ['SERVICE_API_KEY'] }), signal })
    expect(bridge).toBeDefined()
    cleanups.push(() => bridge!.close())
    expect(JSON.parse(bridge!.env.MIKKA_SECRET_ENDPOINTS)).toEqual({})
    expect(JSON.parse(bridge!.env.MIKKA_SECRET_UNAVAILABLE)).toEqual(['SERVICE_API_KEY'])
  })

  it('preserves process.env and ordinary native provider/Git requests', async () => {
    const nativeValues = {
      ANTHROPIC_API_KEY: 'synthetic-native-anthropic', OPENAI_API_KEY: 'synthetic-native-openai',
      CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-native-claude-subscription',
      GH_TOKEN: 'synthetic-native-github', GITHUB_TOKEN: 'synthetic-native-github',
    }
    for (const [name, value] of Object.entries(nativeValues)) vi.stubEnv(name, value)
    const before = { ...process.env }
    const nativeCalls: Array<{ path: string; authorization: string | undefined }> = []
    const native = await serve((request, response) => {
      nativeCalls.push({ path: request.url!, authorization: request.headers.authorization })
      response.end('native-direct')
    })
    const state = await fixture()
    for (const [path, token] of [['/v1/messages', nativeValues.CLAUDE_CODE_OAUTH_TOKEN], ['/git/info/refs', nativeValues.GH_TOKEN]]) {
      const response = await fetch(`${native}${path}`, { headers: { authorization: `Bearer ${token}` } })
      expect(await response.text()).toBe('native-direct')
    }
    expect(nativeCalls).toEqual([
      { path: '/v1/messages', authorization: `Bearer ${nativeValues.CLAUDE_CODE_OAUTH_TOKEN}` },
      { path: '/git/info/refs', authorization: `Bearer ${nativeValues.GH_TOKEN}` },
    ])
    expect(state.calls).toHaveLength(0)
    expect(Object.keys(state.bridge.env)).toEqual(['MIKKA_SECRET_ENDPOINTS'])
    state.bridge.close()
    expect(Object.keys(process.env).sort()).toEqual(Object.keys(before).sort())
    // Boolean assertions avoid printing any inherited environment value.
    for (const name of Object.keys(before)) expect(process.env[name] === before[name], `process.env changed: ${name}`).toBe(true)
  })
})
