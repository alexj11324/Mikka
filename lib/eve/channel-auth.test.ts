import assert from 'node:assert/strict'
import { beforeEach, mock, test } from 'node:test'
import { eveChannel } from 'eve/channels/eve'
import type { RouteHandlerArgs, HttpRouteDefinition } from 'eve/channels'

const botId = '11111111-1111-4111-8111-111111111111'
const workspaceId = '22222222-2222-4222-8222-222222222222'
const sessionId = 'wrun_fixture'
let sessionReads = 0
let revoked = false
let sendFails = false
let scopeReadFailure: Error | undefined
let pauseAuthentication: Promise<void> | undefined
let forwarded: Request
let nativeAuth: (request: Request) => unknown
const admittedOwners: string[] = []

mock.module('eve/channels/eve', { namedExports: {
  eveChannel(config: Parameters<typeof eveChannel>[0]) {
    nativeAuth = config.auth as typeof nativeAuth
    return eveChannel(config)
  },
} })
mock.module(new URL('../api-auth.ts', import.meta.url).href, { namedExports: { auth: { api: {
  async getSession({ headers }: { headers: Headers }) {
    sessionReads++
    await pauseAuthentication
    if (revoked) return null
    const bearer = headers.get('authorization')
    const owner = headers.get('cookie')?.replace('owner=', '') ?? (bearer === 'Bearer alice' ? 'alice' : bearer === 'Bearer bob' ? 'bob' : undefined)
    return owner ? { user: { id: owner }, session: { id: 'human-' + owner } } : null
  },
} } } })
mock.module(new URL('./auth-bot.ts', import.meta.url).href, { namedExports: {
  resolveEveRequestBot: async () => ({ botId, workspaceId }),
} })
mock.module(new URL('../task-workspace.ts', import.meta.url).href, { namedExports: {
  requireTaskWorkspace: async () => ({ id: workspaceId }),
} })
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool: {
  async query(sql: string, values: string[]) {
    if (scopeReadFailure && sql.includes('FROM eve_sessions')) throw scopeReadFailure
    const matches = sql.includes('FROM eve_sessions')
      ? values[0] === sessionId && values[1] === 'alice' && values[2] === botId && values[3] === workspaceId && values[4] === 'web'
      : true
    return { rowCount: matches ? 1 : 0, rows: [] }
  },
} } })
mock.module(new URL('./history.ts', import.meta.url).href, { namedExports: { priorHistory: async () => [] } })
mock.module(new URL('./submission.ts', import.meta.url).href, { namedExports: {
  async acceptEveMessage(scope: { ownerId: string }, _message: unknown, _context: unknown, request: Request) {
    forwarded = request
    admittedOwners.push(scope.ownerId)
    return { eventId: 'fixture-event', context: [] }
  },
  commitEveIngress: async () => {},
} })
mock.module(new URL('../credentials/chat-guard.ts', import.meta.url).href, { namedExports: { credentialChatFingerprints: async () => [] } })
mock.module(new URL('./stream-mask.ts', import.meta.url).href, { namedExports: { maskEveStream: () => new TransformStream() } })

const { mikkaEveChannel } = await import('./channel')
const routes = mikkaEveChannel().routes
const route = (method: string, path: string) => routes.find(value => value.transport !== 'websocket' && value.method === method && value.path === path) as HttpRouteDefinition
const args = {
  params: { sessionId },
  from: () => ({ create: async () => ({ session: { id: sessionId } }) }),
  attachSession: () => ({
    id: sessionId,
    async send() {
      if (sendFails) throw new Error('fixture admission failure')
      return { sessionId, deliveryId: 'fixture-delivery' }
    },
    getLineStream: async () => new ReadableStream({ start(controller) { controller.close() } }),
  }),
} as unknown as RouteHandlerArgs
const sendRoute = route('POST', '/eve/v1/session/:sessionId')
function request(path = sessionId, headers: Record<string, string> = {}) {
  return new Request('https://app.test/eve/v1/session/' + path, {
    method: 'POST', headers: { origin: 'https://app.test', cookie: 'owner=alice', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ message: 'Hello' }),
  })
}

beforeEach(() => {
  mock.property(process, 'env', { ...process.env, MIKKA_API_INGRESS: '', MIKKA_EVE_HOST: '', BETTER_AUTH_URL: 'https://app.test' })
  sessionReads = 0
  revoked = sendFails = false
  scopeReadFailure = undefined
  pauseAuthentication = undefined
  admittedOwners.length = 0
})

test('native existing and create-message routes authenticate once, including submission rewrites', async () => {
  for (const current of [sendRoute, route('POST', '/eve/v1/session')]) {
    sessionReads = 0
    const response = await current.handler(request(sessionId, { 'x-mikka-submission-id': '33333333-3333-4333-8333-333333333333' }), args)
    assert.equal(response.status, 202)
    assert.equal(sessionReads, 1)
    assert.equal(forwarded.headers.get('cookie'), 'owner=alice')
    assert.deepEqual(admittedOwners.at(-1), 'alice')
    revoked = true
    assert.equal(await nativeAuth(forwarded), null, 'verified identity expires when native dispatch returns')
    revoked = false
  }
})

test('native stream rewrites authenticate once and keep session ownership checks', async () => {
  const streamRoute = route('GET', '/eve/v1/session/:sessionId/stream')
  const original = new Request('https://app.test/eve/v1/session/' + sessionId + '/stream?startIndex=4', { headers: { cookie: 'owner=alice' } })
  const response = await streamRoute.handler(original, args)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /stream.ended/)
  assert.equal(sessionReads, 1)
  assert.equal((await streamRoute.handler(new Request(original, { headers: { cookie: 'owner=bob' } }), args)).status, 404)
})

test('separate requests and failed native dispatch recheck authentication', async () => {
  assert.equal((await sendRoute.handler(request(), args)).status, 202)
  sendFails = true
  assert.equal((await sendRoute.handler(request(), args)).status, 500)
  assert.equal(sessionReads, 2)
  revoked = true
  assert.equal(await nativeAuth(forwarded), null, 'failed dispatch also clears the verified Request')
  assert.equal((await sendRoute.handler(request(), args)).status, 401)
  assert.equal(sessionReads, 4)
})

test('concurrent requests retain their own credentials and forged scope headers cannot lend identity', async () => {
  const gate = Promise.withResolvers<void>()
  pauseAuthentication = gate.promise
  const owner = sendRoute.handler(request(), args)
  const foreign = sendRoute.handler(request(sessionId, { cookie: 'owner=bob', 'x-mikka-eve-scope': JSON.stringify({ ownerId: 'alice', botId, workspaceId }) }), args)
  gate.resolve()
  const responses = await Promise.all([owner, foreign])
  assert.deepEqual(responses.map(response => response.status), [202, 404])
  assert.equal(sessionReads, 2)
  assert.deepEqual(admittedOwners, ['alice'])
  assert.equal((await sendRoute.handler(request(sessionId, { authorization: 'Bearer invalid' }), args)).status, 401)
  assert.equal((await sendRoute.handler(request(sessionId, { origin: 'https://other.test' }), args)).status, 401)
})

test('session lookup failures reach Eve error handling without admitting the message', async () => {
  const outage = new Error('fixture database unavailable')
  scopeReadFailure = outage
  await assert.rejects(async () => sendRoute.handler(request(), args), error => error === outage)
  assert.deepEqual(admittedOwners, [])
})
