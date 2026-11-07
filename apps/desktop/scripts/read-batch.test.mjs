import assert from 'node:assert/strict'
import test from 'node:test'
import { browserModule } from '../../frontend/scripts/test-module.mjs'

async function fixture(callback) {
  const saved = new Map(['window', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const window = { location: new URL('mikka://app/mikka/en'), dispatchEvent() {} }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: window })
  const api = await browserModule(`
    export * from './apps/desktop/src/renderer/rpc.ts'
    export { getTransportState } from './apps/desktop/src/renderer/transport-state.ts'
    export { encode, decode } from './lib/desktop-rpc/wire.ts'
    export { waitForCacheHydration, PersistentReadCache } from './lib/swr/persistent-cache.ts'
  `)
  const requests = []
  const packet = result => Response.json({ version: 1, ok: true, result: api.encode(result) })
  const fetchWith = respond => { globalThis.fetch = async (path, init) => {
    const envelope = JSON.parse(init.body)
    const request = { path, init, action: envelope.action, args: api.decode(envelope.args) }
    requests.push(request)
    return respond(request)
  } }
  const echo = request => packet(request.action === 'desktop.readBatch'
    ? request.args[0].map(call => ({ ok: true, result: { action: call.action, args: call.args } }))
    : { action: request.action, args: request.args })
  fetchWith(echo)
  try { await callback({ api, window, requests, packet, fetchWith, echo }) }
  finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
  }
}

test('Native coalesces allowed reads in one turn with one codec pass and ordered results', () => fixture(async ({ api, requests }) => {
  const at = new Date('2026-11-07T01:02:03.000Z')
  const literalTag = { $mikka: 'date', value: 'ordinary application data' }
  const first = api.callAction('issues.syncIssueList', [at, literalTag, undefined])
  const second = api.callAction('task-runs.pollTaskRuns', [])
  assert.equal(requests.length, 0)
  assert.deepEqual(await Promise.all([first, second]), [
    { action: 'issues.syncIssueList', args: [at, literalTag, undefined] },
    { action: 'task-runs.pollTaskRuns', args: [] },
  ])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].action, 'desktop.readBatch')
  assert.deepEqual(requests[0].args, [[
    { action: 'issues.syncIssueList', args: [at, literalTag, undefined] },
    { action: 'task-runs.pollTaskRuns', args: [] },
  ]])
  assert.equal(requests[0].path, '/mikka/api/desktop/rpc')
  assert.equal(requests[0].init.credentials, 'omit')
  assert.deepEqual(requests[0].init.headers, { 'content-type': 'application/json', 'x-mikka-desktop-protocol': '1', 'x-mikka-locale': 'en' })
}))

test('one startup read wave stays together across the real hydration gates used by SWR and list fetchers', () => fixture(async ({ api, requests }) => {
  const cache = new Map()
  // SWRDefaults waits for hydration for every fetcher. Issue/thread/chat
  // fetchers also use this same gate before consuming the recovered cursor.
  // These already-resolved promises must not split one startup wave into
  // separately authorized HTTP requests.
  const read = async (action, ownHydrationGate) => {
    await api.waitForCacheHydration(cache)
    if (ownHydrationGate) await api.waitForCacheHydration(cache)
    return api.callAction(action, [])
  }
  const actions = ['task-runs.pollTaskRuns', 'issues.syncIssueList', 'coordinator.pollBotChatSummaries', 'task-runs.syncThreadList', 'bots.pollBots', 'coordinator.syncCoordinatorChat']
  const values = await Promise.all(actions.map((action, index) => read(action, index % 2 === 1)))
  assert.deepEqual(values.map(value => value.action), actions)
  assert.equal(requests.length, 1, 'all six ready reads share one ordinary authorization boundary')
  assert.equal(requests[0].action, 'desktop.readBatch')
  assert.equal(requests[0].args[0].length, actions.length)
  await read('task-runs.syncThreadList', true)
  assert.equal(requests.length, 2, 'a later live refresh still sends a fresh request')
}))

test('single reads, excluded actions and Web keep their ordinary single-request path without a read cache', () => fixture(async ({ api, requests }) => {
  const excluded = ['desktop.bootstrap', 'desktop.session', 'desktop.modelMenu', 'workspace.switchWorkspace', 'bots.updateBot', 'subscription-credentials.getSubscriptionCredential']
  await Promise.all(excluded.map(action => api.callAction(action, [])))
  assert.deepEqual(requests.map(row => row.action), excluded)
  await api.callAction('projects.listProjects', [])
  await api.callAction('projects.listProjects', [])
  assert.deepEqual(requests.slice(-2).map(row => row.action), ['projects.listProjects', 'projects.listProjects'])
  const web = { endpoint: '/api/rpc', credentials: 'same-origin', header: 'x-mikka-rpc' }
  await Promise.all([api.callRemoteAction('projects.listProjects', [], web), api.callRemoteAction('teams.listTeams', [], web)])
  assert.deepEqual(requests.slice(-2).map(row => [row.path, row.action, row.init.credentials]), [
    ['/mikka/api/rpc', 'projects.listProjects', 'same-origin'], ['/mikka/api/rpc', 'teams.listTeams', 'same-origin'],
  ])
}))

test('Native splits at sixteen items and captures each locale before the posted flush', () => fixture(async ({ api, window, requests }) => {
  const pending = Array.from({ length: 18 }, (_, index) => api.callAction('projects.listProjects', [index]))
  window.location = new URL('mikka://app/mikka/')
  pending.push(api.callAction('teams.listTeams', [18]), api.callAction('teams.listTeams', [19]))
  const results = await Promise.all(pending)
  assert.deepEqual(results.map(row => row.args[0]), Array.from({ length: 20 }, (_, index) => index))
  assert.deepEqual(requests.map(row => [row.action, row.args[0].length, row.init.headers['x-mikka-locale']]), [
    ['desktop.readBatch', 16, 'en'], ['desktop.readBatch', 2, 'en'], ['desktop.readBatch', 2, 'zh-CN'],
  ])
}))

test('only an exact unknown batch action on 404 falls back and disables batching for this page', () => fixture(async ({ api, requests, fetchWith, echo }) => {
  fetchWith(request => request.action === 'desktop.readBatch'
    ? Response.json({ version: 1, ok: false, error: { code: 'desktop_rpc_action_unknown' } }, { status: 404 })
    : echo(request))
  const at = new Date('2026-11-07T01:02:03.000Z')
  const first = await Promise.all([api.callAction('projects.listProjects', [at]), api.callAction('teams.listTeams', [])])
  assert.deepEqual(first[0].args, [at])
  assert.deepEqual(requests.map(row => row.action), ['desktop.readBatch', 'projects.listProjects', 'teams.listTeams'])
  await Promise.all([api.callAction('projects.listProjects', []), api.callAction('teams.listTeams', [])])
  assert.deepEqual(requests.slice(3).map(row => row.action), ['projects.listProjects', 'teams.listTeams'])
}))

test('batch HTTP and network failures do not retry or fall back', async t => {
  for (const [status, code, expected, state] of [
    [404, 'not_found', 'not_found', 'ready'],
    [500, 'desktop_rpc_action_unknown', 'desktop_rpc_action_unknown', 'ready'],
    [401, 'authRequired', 'desktop_session_expired', 'unauthenticated'],
    [426, 'desktop_client_update_required', 'desktop_client_update_required', 'update-required'],
    [503, 'desktop_rpc_failed', 'desktop_backend_unreachable', 'offline'],
  ]) await t.test(`${status}:${code}`, () => fixture(async ({ api, requests, fetchWith }) => {
    fetchWith(() => Response.json({ version: 1, ok: false, error: { code } }, { status }))
    const results = await Promise.allSettled([api.callAction('projects.listProjects', []), api.callAction('teams.listTeams', [])])
    assert.equal(requests.length, 1)
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.ok(result.reason instanceof api.DesktopTransportError)
      assert.equal(result.reason.code, expected)
      assert.equal(result.reason.status, status)
    }
    assert.equal(api.getTransportState(), state)
  }))
  await t.test('network', () => fixture(async ({ api, requests, fetchWith }) => {
    const cause = new TypeError('offline fixture')
    fetchWith(() => { throw cause })
    const results = await Promise.allSettled([api.callAction('projects.listProjects', []), api.callAction('teams.listTeams', [])])
    assert.equal(requests.length, 1)
    for (const result of results) assert.equal(result.reason.cause, cause)
    assert.equal(api.getTransportState(), 'offline')
  }))
})

test('batch item failures retain their own error and status without failing successful siblings', () => fixture(async ({ api, requests, packet, fetchWith }) => {
  const date = new Date('2026-11-07T01:02:03.000Z')
  fetchWith(() => packet([{ ok: true, result: { date } }, { ok: false, status: 403, error: { code: 'workspaceAccessDenied' } }]))
  const [success, failed] = await Promise.allSettled([api.callAction('projects.listProjects', []), api.callAction('teams.listTeams', [])])
  assert.deepEqual(success, { status: 'fulfilled', value: { date } })
  assert.equal(failed.status, 'rejected')
  assert.ok(failed.reason instanceof api.DesktopTransportError)
  assert.equal(failed.reason.code, 'workspaceAccessDenied')
  assert.equal(failed.reason.status, 403)
  assert.equal(requests.length, 1)
  assert.equal(api.getTransportState(), 'ready')
}))

test('malformed batch item count or shape rejects every item without retrying', async t => {
  for (const result of [[{ ok: true, result: null }], [{ ok: true, result: null }, { ok: false, status: '403', error: { code: 'workspaceAccessDenied' } }]]) {
    await t.test(JSON.stringify(result), () => fixture(async ({ api, requests, packet, fetchWith }) => {
      fetchWith(() => packet(result))
      const outcomes = await Promise.allSettled([api.callAction('projects.listProjects', []), api.callAction('teams.listTeams', [])])
      assert.equal(requests.length, 1)
      for (const outcome of outcomes) assert.equal(outcome.reason.code, 'desktop_rpc_response_invalid')
    }))
  }
})

test('scope reset after a microtask rejects unsent old-identity reads before the posted flush', () => fixture(async ({ api, requests }) => {
  const old = Promise.allSettled([api.callAction('projects.listProjects', ['old']), api.callAction('teams.listTeams', ['old'])])
  await Promise.resolve()
  assert.equal(requests.length, 0)
  api.resetReadBatchScope()
  const current = await Promise.all([api.callAction('projects.listProjects', ['current']), api.callAction('teams.listTeams', ['current'])])
  for (const outcome of await old) assert.equal(outcome.reason.code, 'desktop_session_changed')
  assert.deepEqual(current.map(row => row.args), [['current'], ['current']])
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].args[0].map(row => row.args), [['current'], ['current']])
}))

test('workspace selector changes cannot pair queued arguments with the new workspace before React effects run', () => fixture(async ({ api, window, requests }) => {
  window.location = new URL('mikka://app/mikka/en?workspace=first')
  const old = Promise.allSettled([api.callAction('projects.listProjects', ['first']), api.callAction('teams.listTeams', ['first'])])
  window.location = new URL('mikka://app/mikka/en?workspace=second')
  const current = await Promise.all([api.callAction('projects.listProjects', ['second']), api.callAction('teams.listTeams', ['second'])])
  for (const outcome of await old) assert.equal(outcome.reason.code, 'desktop_session_changed')
  assert.deepEqual(current.map(row => row.args), [['second'], ['second']])
  assert.equal(requests.length, 1)
}))

test('explicit isCurrent guards drop stale queued reads and remain independent from other guards', () => fixture(async ({ api, requests }) => {
  let valid = true
  const old = api.callAction('projects.listProjects', ['old'], () => valid)
  const rejected = assert.rejects(old, { code: 'desktop_session_changed', status: 409 })
  const current = api.callAction('teams.listTeams', ['current'], () => true)
  valid = false
  await rejected
  assert.deepEqual(await current, { action: 'teams.listTeams', args: ['current'] })
  assert.deepEqual(requests.map(row => row.action), ['teams.listTeams'])
}))

test('retired in-flight batches cannot change current transport state or trigger old-server fallback', async t => {
  for (const status of [401, 503, 404]) await t.test(String(status), () => fixture(async ({ api, requests, fetchWith, echo }) => {
    const started = Promise.withResolvers(), delayed = Promise.withResolvers()
    fetchWith(() => { started.resolve(); return delayed.promise })
    const old = Promise.allSettled([api.callAction('projects.listProjects', []), api.callAction('teams.listTeams', [])])
    await started.promise
    api.resetReadBatchScope()
    fetchWith(echo)
    await api.callAction('projects.listProjects', ['new'])
    delayed.resolve(Response.json({ version: 1, ok: false, error: { code: 'desktop_rpc_action_unknown' } }, { status }))
    for (const outcome of await old) assert.equal(outcome.reason.code, 'desktop_session_changed')
    assert.equal(api.getTransportState(), 'ready')
    assert.equal(requests.length, 2)
  }))
})

test('an isCurrent change while a batch body is pending prevents stale results and state updates', () => fixture(async ({ api, fetchWith }) => {
  const reading = Promise.withResolvers()
  let valid = true, body
  const current = () => valid
  fetchWith(() => {
    const response = new Response(new ReadableStream({ start(controller) { body = controller } }), { status: 200 })
    const json = response.json.bind(response)
    response.json = () => { reading.resolve(); return json() }
    return response
  })
  const pending = Promise.allSettled([api.callAction('projects.listProjects', [], current), api.callAction('teams.listTeams', [], current)])
  await reading.promise
  valid = false
  body.enqueue(new TextEncoder().encode(JSON.stringify({ version: 1, ok: true, result: [{ ok: true, result: null }, { ok: true, result: null }] })))
  body.close()
  for (const outcome of await pending) assert.equal(outcome.reason.code, 'desktop_session_changed')
  assert.equal(api.getTransportState(), 'ready')
}))
