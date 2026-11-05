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
      pool: { query: async () => ({ rows: [] }) },
      acquire: async () => ({ connectionId, created: true }),
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

test('the account list projects chat selections only from the authorized workspace', async () => {
  const botId = randomUUID(), calls: unknown[][] = []
  const service = {
    capabilities: { oauth: { claude: true } },
    repository: {
      pool: { query: async (sql: string) => ({ rows: sql.startsWith('select id,') ? [{ id: connectionId, provider: 'claude', state: 'connected', epoch: '1', accountLabel: 'Account' }] : [] }) },
      connectionBots: async (...args: unknown[]) => { calls.push(args); return [
        { connectionId, id: botId, workspaceId, name: 'Coordinator', color: 'encre', shape: 'cercle' },
        { connectionId, id: randomUUID(), workspaceId: randomUUID(), name: 'Other workspace', color: 'encre', shape: 'cercle' },
      ] },
    },
  } as unknown as SubscriptionService
  const response = await subscriptionList(new Request(`https://mikka.test/api/subscriptions?workspace=${workspaceId}`), {
    session: async () => ({ userId: 'alice', sessionId: 's' }),
    workspace: async (owner, workspace) => { calls.push(['authorize', owner, workspace]) },
    service: () => service,
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls, [['authorize', 'alice', workspaceId], ['alice', workspaceId]])
  assert.deepEqual((await response.json()).connections[0].bots, [{ id: botId, workspaceId, name: 'Coordinator', color: 'encre', shape: 'cercle' }])
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

const authorization = { flow: 'device', state: 's'.repeat(43), authorizationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', interval: 5, expiresAt: '2099-01-01T00:00:00Z', revision: 2 }
function lifecycle() {
  const calls: { method: string; params: Record<string, unknown>; signal?: AbortSignal }[] = [], lines: string[] = []
  const row = { id: connectionId, ownerId: 'alice', workspaceId, provider: 'codex' as const, state: 'pending', epoch: '2', quota: null }
  let acquireCount = 0, removed = false
  let invoke = async (method: string, _params: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> => {
    if (method === 'disconnect') { row.state = 'disconnected'; row.epoch = '3'; return { state: row.state, revision: 3 } }
    return authorization
  }
  const service = {
    capabilities: { oauth: { codex: true, claude: true } },
    repository: {
      pool: { query: async (sql: string) => ({ rows: sql.startsWith('select id,') ? [row] : [] }) },
      acquire: async () => { acquireCount++; return { connectionId, created: false } },
      connection: async (owner: string, id: string) => { assert.equal(owner, 'alice'); assert.equal(id, connectionId); return row },
      scope: () => ({ ownerId: row.ownerId, workspaceId, connectionId, provider: row.provider }),
      connectionBots: async () => [],
      remove: async () => { removed = true },
    },
    worker: () => ({ call: async (method: string, params: Record<string, unknown>, signal?: AbortSignal) => { calls.push({ method, params, signal }); return invoke(method, params, signal) } }),
    status: async (_owner: string, _id: string, signal?: AbortSignal) => { assert.equal(signal?.aborted, false); return { id: connectionId, state: row.state, revision: Number(row.epoch) } },
  } as unknown as SubscriptionService
  const deps: SubscriptionHTTPDependencies = {
    session: async () => ({ userId: 'alice', sessionId: 'owner-session' }), workspace: async () => undefined, service: () => service, log: line => { lines.push(line) },
  }
  return { calls, lines, row, deps, service, acquisitions: () => acquireCount, removed: () => removed, invoke: (call: typeof invoke) => { invoke = call },
    send: (body: unknown, signal?: AbortSignal) => subscriptionHTTP(deps)(new Request('https://mikka.test/api/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })),
  }
}

test('pending account without credentials is listed with its owner-session recovery presentation', async () => {
  const fixture = lifecycle()
  const result = await subscriptionList(new Request(`https://mikka.test/api/subscriptions?workspace=${workspaceId}`), fixture.deps)
  assert.equal(result.status, 200)
  const row = (await result.json()).connections[0]
  assert.equal(row.state, 'pending')
  assert.deepEqual(row.activeAttempt, { connectionId, ...authorization })
  assert.deepEqual(fixture.calls.map(call => [call.method, call.params]), [['oauthResume', { sessionId: 'owner-session' }]])
  assert.equal(fixture.acquisitions(), 0)
  assert.doesNotMatch(JSON.stringify(row), /owner-session|secretName|verifier|device_auth_id/)
})

test('expired account remains visible with its reconnect reason and no new provider call', async () => {
  const fixture = lifecycle()
  Object.assign(fixture.row, { state: 'reconnect_required', lastErrorCode: 'acquire_expired' })
  const response = await subscriptionList(new Request(`https://mikka.test/api/subscriptions?workspace=${workspaceId}`), fixture.deps)
  const row = (await response.json()).connections[0]
  assert.equal(row.lastErrorCode, 'acquire_expired')
  assert.equal(row.activeAttempt, null)
  assert.equal(fixture.calls.length, 0)
})

test('a concurrent start cannot attach a newer attempt to an older list revision', async () => {
  const fixture = lifecycle()
  fixture.row.epoch = '1'
  const response = await subscriptionList(new Request(`https://mikka.test/api/subscriptions?workspace=${workspaceId}`), fixture.deps)
  assert.equal(response.status, 200)
  const row = (await response.json()).connections[0]
  assert.equal(row.revision, 1)
  assert.equal(row.activeAttempt, null)
})

test('resume and repeated Connect use the existing pending connection', async () => {
  const fixture = lifecycle()
  const resumed = await fixture.send({ action: 'resume', connectionId })
  assert.deepEqual(await resumed.json(), { connectionId, ...authorization })
  const connected = await fixture.send({ action: 'connect', workspaceId, provider: 'codex' })
  assert.deepEqual(await connected.json(), { connectionId, ...authorization })
  assert.deepEqual(fixture.calls.map(call => call.method), ['oauthResume', 'oauthStart'])
  assert.equal(fixture.acquisitions(), 1)
  assert.equal(fixture.removed(), false)
})

test('leaving during start, device poll, callback or Cancel does not abort a claimed server operation', async () => {
  for (const body of [
    { action: 'connect', workspaceId, provider: 'codex' },
    { action: 'poll', connectionId, state: authorization.state },
    { action: 'callback', connectionId, state: authorization.state, callbackUrl: 'http://localhost:54545/callback?code=private-code&state=' + authorization.state },
    { action: 'disconnect', connectionId, revision: 2 },
  ]) {
    const fixture = lifecycle(), browser = new AbortController()
    fixture.invoke(async (_method, _params, signal) => {
      assert.ok(signal)
      assert.notEqual(signal, browser.signal)
      browser.abort()
      await Promise.resolve()
      assert.equal(signal.aborted, false, 'browser cancellation reached the claimed grant')
      return authorization
    })
    const response = await fixture.send(body, browser.signal)
    assert.equal(response.status, 200)
    assert.equal(fixture.removed(), false)
    assert.equal(fixture.lines.length, 0)
  }
})

test('stale poll and callback refusals are logged once without state, session or provider callback data', async () => {
  for (const action of ['poll', 'callback']) {
    const fixture = lifecycle()
    fixture.invoke(async () => { throw new WorkerRefusal('stale_operation') })
    const response = await fixture.send({ action, connectionId, state: authorization.state, ...(action === 'callback' ? { callbackUrl: 'http://localhost:54545/callback?code=private-code&state=' + authorization.state } : {}) })
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { error: 'stale_operation' })
    assert.equal(fixture.lines.length, 1)
    assert.deepEqual(JSON.parse(fixture.lines[0]), { level: 'warn', msg: 'subscription_refused', action, provider: 'codex', code: 'stale_operation', error: 'WorkerRefusal' })
    assert.doesNotMatch(fixture.lines[0], /owner-session|private-code|localhost|ssssssss|ABCD/)
  }
})

test('explicit Cancel disconnects the pending revision without starting another attempt', async () => {
  const fixture = lifecycle()
  const response = await fixture.send({ action: 'disconnect', connectionId, revision: 2 })
  assert.equal(response.status, 200)
  assert.deepEqual(fixture.calls.map(call => [call.method, call.params]), [['disconnect', { revision: 2 }]])
  assert.equal(fixture.row.state, 'disconnected')
  assert.equal(fixture.acquisitions(), 0)
})

test('explicit reconnect fences a legacy or previous-session pending attempt before starting a new one', async () => {
  const fixture = lifecycle()
  const response = await fixture.send({ action: 'reconnect', connectionId, revision: 2 })
  assert.equal(response.status, 200)
  assert.deepEqual(fixture.calls.map(call => [call.method, call.params]), [['disconnect', { revision: 2 }], ['oauthStart', { revision: 3, sessionId: 'owner-session' }]])
  assert.deepEqual(await response.json(), { connectionId, ...authorization })
})

test('an overlapping or uncertain start remains available instead of being disconnected by error cleanup', async () => {
  const fixture = lifecycle()
  fixture.service.repository.acquire = async () => ({ connectionId, created: true })
  fixture.invoke(async () => { throw new WorkerRefusal('credential_busy') })
  const response = await fixture.send({ action: 'connect', workspaceId, provider: 'codex' })
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'credential_busy' })
  assert.equal(fixture.row.state, 'pending')
  assert.deepEqual(fixture.calls.map(call => call.method), ['oauthStart'])
  assert.equal(fixture.removed(), false)
})
