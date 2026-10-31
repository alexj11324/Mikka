import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { SubscriptionRefusal } from '@mikka/protocol/subscription'
import { WorkerRefusal } from '../packages/daemon/src/subscription-worker-client'
import { subscriptionHTTP, subscriptionList, type SubscriptionHTTPDependencies } from './subscription-http'
import type { SubscriptionService } from './subscription-service'

const workspaceId = randomUUID(), connectionId = randomUUID()
function connect(failure: Error, oauth = true) {
  const lines: string[] = [], calls: string[] = [], removed: string[] = []
  const service = {
    capabilities: { oauth: { codex: oauth, claude: oauth } },
    repository: {
      create: async () => connectionId,
      connection: async () => ({ id: connectionId, workspaceId, provider: 'codex', epoch: '1' }),
      scope: () => ({}),
      remove: async (_owner: string, id: string) => { removed.push(id) },
    },
    worker: () => ({ call: async (method: string) => { calls.push(method); if (method === 'oauthStart') throw failure; return {} } }),
  } as unknown as SubscriptionService
  const deps: SubscriptionHTTPDependencies = {
    session: async () => ({ userId: 'user-1', sessionId: 'session-secret-value' }),
    workspace: async () => undefined,
    service: () => service,
    log: line => { lines.push(line) },
  }
  const request = new Request('https://mikka.test/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'connect', workspaceId, provider: 'codex' }) })
  return { lines, calls, removed, response: subscriptionHTTP(deps)(request) }
}

test('a refused sign-in start returns and logs the worker code, nothing secret', async () => {
  const { lines, response } = connect(new WorkerRefusal('provider_operation_failed'))
  const result = await response
  assert.equal(result.status, 409)
  assert.deepEqual(await result.json(), { error: 'provider_operation_failed' })
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), { level: 'warn', msg: 'subscription_refused', action: 'connect', provider: 'codex', code: 'provider_operation_failed', error: 'WorkerRefusal' })
  assert.doesNotMatch(lines[0], /session-secret-value|user-1|https?:/)
})

test('a refused sign-in start leaves no connection row', async () => {
  const { calls, removed, response } = connect(new WorkerRefusal('secret_store_unavailable'))
  assert.deepEqual(await (await response).json(), { error: 'secret_store_unavailable' })
  assert.deepEqual(calls, ['oauthStart', 'disconnect'])
  assert.deepEqual(removed, [connectionId])
})

test('route refusals keep their code; unknown errors stay generic but are logged by class', async () => {
  const off = connect(new Error('ignored'), false)
  assert.deepEqual(await (await off.response).json(), { error: 'backend_unavailable' })
  assert.equal(JSON.parse(off.lines[0]).error, 'SubscriptionRefusal')
  const account = connect(new SubscriptionRefusal('account_unavailable'))
  assert.deepEqual(await (await account.response).json(), { error: 'account_unavailable' })
  const unknown = connect(new TypeError('https://auth.openai.com/?token=secret'))
  assert.deepEqual(await (await unknown.response).json(), { error: 'subscription_unavailable' })
  assert.deepEqual(JSON.parse(unknown.lines[0]), { level: 'warn', msg: 'subscription_refused', action: 'connect', provider: 'codex', code: 'subscription_unavailable', error: 'TypeError' })
  const odd = connect(new WorkerRefusal('Not A Code'))
  assert.deepEqual(await (await odd.response).json(), { error: 'subscription_unavailable' })
})

test('Connect is offered only when the sign-in runtime exists, not just custody', async () => {
  const custody = {
    capabilities: { oauth: { codex: true, claude: true } },
    repository: { pool: { query: async () => ({ rows: [] }) }, connectionBots: async () => [] },
  } as unknown as SubscriptionService
  const list = (full: boolean) => subscriptionList(new Request(`https://mikka.test/api/subscriptions?workspace=${workspaceId}`), {
    session: async () => ({ userId: 'user-1', sessionId: 's' }),
    workspace: async () => undefined,
    service: custodyOnly => { if (!custodyOnly && !full) throw new SubscriptionRefusal('backend_unavailable'); return custody },
  })
  assert.deepEqual((await (await list(false)).json()).providers, [{ provider: 'codex', available: false }, { provider: 'claude', available: false }])
  assert.deepEqual((await (await list(true)).json()).providers, [{ provider: 'codex', available: true }, { provider: 'claude', available: true }])
})

test('pause reaches the repository with the owner and needs no provider call', async () => {
  const calls: unknown[][] = [], worker: string[] = []
  const service = {
    capabilities: {},
    repository: {
      connection: async () => ({ id: connectionId, workspaceId, provider: 'claude', epoch: '1' }),
      scope: () => ({}),
      setPaused: async (...args: unknown[]) => { calls.push(args) },
    },
    worker: () => ({ call: async (method: string) => { worker.push(method); return {} } }),
  } as unknown as SubscriptionService
  const http = subscriptionHTTP({ session: async () => ({ userId: 'user-1', sessionId: 's' }), workspace: async () => undefined, service: () => service, log: () => undefined })
  const send = (body: unknown) => http(new Request('https://mikka.test/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const response = await send({ action: 'pause', connectionId, paused: true })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { id: connectionId, paused: true })
  assert.deepEqual(calls, [['user-1', connectionId, true]])
  assert.deepEqual(worker, [])
  assert.notEqual((await send({ action: 'pause', connectionId, paused: 'yes' })).status, 200)
})
