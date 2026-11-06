import assert from 'node:assert/strict'
import test from 'node:test'
import { EnvironmentError } from '../test-accounts/environment.mjs'
import { TestAccountError } from '../test-accounts/pool.mjs'
import { READ_ACTIONS, ReadCacheAcceptanceError, ReadCacheDiagnosticError, actionResult, createReadClient, discoverReadActions, exerciseReadCases, publicFailure, requestAllowed } from './read-cache.mjs'
import { observedAction, publishedReadActions, readRpcActions, rpcReadRequest } from './read-action-transport.mjs'

const environment = { origin: 'http://127.0.0.1:3110', basePath: '/mikka' }
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const refs = Object.fromEntries(READ_ACTIONS.map((name, index) => [name, String(index + 1).repeat(40)]))
const actionInit = name => ({ method: 'POST', headers: { 'next-action': refs[name], 'content-type': 'application/json', accept: 'text/x-component' }, body: '[]' })

test('failure evidence preserves registered account and environment codes without private diagnostics', () => {
  const privateText = 'private account, response and SQL parameter'
  for (const error of [new TestAccountError('TEST_ACCOUNT_HTTP_FAILED'), new TestAccountError('ACCOUNT_INITIALIZATION_FAILED'), new EnvironmentError('DEPLOYMENT_IDENTITY_MISMATCH')]) {
    error.message = privateText
    error.cause = new Error(privateText)
    assert.deepEqual(publicFailure(error), { status: 'fail', code: error.code })
  }
  for (const error of [new TestAccountError(privateText), new EnvironmentError(privateText), Object.assign(new Error(privateText), { code: privateText })]) {
    assert.deepEqual(publicFailure(error), { status: 'fail', code: 'read_cache_acceptance_failed' })
  }
  assert.deepEqual(publicFailure(Object.assign(new Error(privateText), { code: '23503', detail: privateText })), { status: 'fail', code: 'read_cache_acceptance_failed', sqlState: '23503' })
  assert.deepEqual(publicFailure(new TypeError(privateText)), { status: 'fail', code: 'read_cache_acceptance_failed', errorType: 'TypeError' })
})

test('driver stage evidence retains the original cause and never claims an unobserved lease cleanup', () => {
  const privateText = 'private account, response and SQL parameter'
  const cause = new TestAccountError('ACCOUNT_INITIALIZATION_FAILED')
  cause.message = privateText
  const error = new ReadCacheDiagnosticError(cause, { stage: 'accounts', completedReads: 0, fixtureCleanup: 'not-started', userId: privateText, body: privateText })
  assert.equal(error.cause, cause)
  assert.deepEqual(publicFailure(error), { status: 'fail', code: 'ACCOUNT_INITIALIZATION_FAILED', stage: 'accounts', completedReads: 0, fixtureCleanup: 'not-started', leaseCleanup: 'unobserved' })
  const afterCleanup = new ReadCacheDiagnosticError(new ReadCacheAcceptanceError('read_action_reference_missing'), {
    stage: 'action-discovery', completedReads: 2, fixtureCleanup: 'succeeded', leaseCleanup: 'dirty', privateText,
  })
  assert.deepEqual(publicFailure(afterCleanup), { status: 'fail', code: 'read_action_reference_missing', stage: 'action-discovery', completedReads: 2, fixtureCleanup: 'succeeded', leaseCleanup: 'unobserved' })
  const unknown = new ReadCacheDiagnosticError(new Error(privateText), { stage: privateText, completedReads: privateText, fixtureCleanup: privateText, leaseCleanup: privateText })
  assert.deepEqual(publicFailure(unknown), { status: 'fail', code: 'read_cache_acceptance_failed', stage: 'unknown', completedReads: 0, fixtureCleanup: 'unobserved', leaseCleanup: 'unobserved' })
  assert.equal(JSON.stringify([publicFailure(error), publicFailure(afterCleanup), publicFailure(unknown)]).includes(privateText), false)
})

test('the request allowlist admits only scoped GETs and published read actions', () => {
  for (const path of ['/mikka/api/version', '/mikka/api/auth/get-session', '/mikka/api/workspace/switcher', '/mikka/api/settings/issue-prefix', '/mikka', '/mikka/settings?section=preferences', `/mikka?issue=${id(1)}`, '/mikka/_next/static/chunks/read.js?v=2'])
    assert.equal(requestAllowed(path, {}, environment, refs), true, path)
  for (const name of READ_ACTIONS) assert.equal(requestAllowed('/mikka', actionInit(name), environment, refs), true)
  for (const path of ['https://other.example/mikka', '/api/settings/issue-prefix', '/mikka/api/coordinator/messages', '/mikka/api/mobile/chat', '/mikka/api/bots', '/mikka/api/acceptance', '/mikka?acceptance=1', '/mikka/settings?section=secrets', '/mikka/_next/static/chunks/%2e%2e/private.js', '/mikka/_next/static/chunks/a%2fb.js'])
    assert.equal(requestAllowed(path, {}, environment, refs), false, path)
  assert.equal(requestAllowed('/mikka', { ...actionInit('pollIssue'), method: 'DELETE' }, environment, refs), false)
  assert.equal(requestAllowed('/mikka', { ...actionInit('pollIssue'), headers: { ...actionInit('pollIssue').headers, 'next-action': 'f'.repeat(40) } }, environment, refs), false)
  assert.equal(requestAllowed('/mikka', actionInit('pollIssue'), environment, {}), false)
  assert.equal(requestAllowed('/mikka/api/version', { headers: { cookie: 'private' } }, environment), false)
  assert.equal(requestAllowed('/mikka/api/version', { body: 'data' }, environment), false)
  // A read must not switch locale and persistently rename the baseline workspace.
  for (const path of ['/mikka/en', '/mikka/en/settings?section=preferences']) {
    assert.equal(requestAllowed(path, {}, environment, refs), false)
    assert.equal(requestAllowed(path, actionInit('pollIssue'), environment, refs), false)
  }
})

test('action discovery handles Next dev bracket imports, minified calls and lazy public chunks without evaluating them', async () => {
  const calls = []
  const source = name => name === 'pollIssue'
    ? `(0, imported["createServerReference"])("${refs[name]}", imported["callServer"], void 0, imported["findSourceMapURL"], "${name}")`
    : `createServerReference("${refs[name]}",callServer,undefined,findSourceMapURL,"${name}")`
  const chunks = {
    '/mikka/_next/static/chunks/page.js': `${source(READ_ACTIONS[0])};const lazy="static/chunks/read.js";const ignored="https://foreign.example/mikka/_next/static/chunks/bad.js";throw Error('must never evaluate')`,
    '/mikka/_next/static/chunks/read.js': READ_ACTIONS.slice(1).map(source).join(';') + ';createServerReference("' + 'f'.repeat(40) + '",callServer,void 0,findSourceMapURL,"sendCoordinatorMessage")',
  }
  const { refs: found, diagnostics } = await discoverReadActions(async path => {
    calls.push(path)
    assert.equal(requestAllowed(path, {}, environment), true)
    return new Response((path === '/mikka' || path.startsWith('/mikka?') || path.startsWith('/mikka/settings?')) ? '<script src="/mikka/_next/static/chunks/page.js"></script>' : chunks[path], { status: 200 })
  }, environment, id(1))
  assert.deepEqual(found, refs)
  assert.equal(diagnostics.pagesRead, 3)
  assert.equal(diagnostics.chunksRead, 2)
  assert.equal(calls.some(path => path.includes('foreign')), false)
  assert.equal(Object.hasOwn(found, 'sendCoordinatorMessage'), false)
})

test('missing named references fail closed instead of guessing action IDs', async () => {
  await assert.rejects(discoverReadActions(async () => new Response('<html></html>'), environment, id(1)), { code: 'read_action_reference_missing' })
})

test('Vite discovery uses the actual published used-actions manifest and never widens the five-read boundary', async () => {
  const manifest = { version: 1, target: 'web', usedActions: [...Object.values(readRpcActions), 'coordinator.sendCoordinatorMessage'] }
  const calls = []
  const discovered = await discoverReadActions(async path => {
    calls.push(path)
    assert.equal(requestAllowed(path, {}, environment), true)
    return path.endsWith('/renderer-manifest.json')
      ? Response.json(manifest)
      : new Response('<script type="module" src="/mikka/assets/index-realbuild.js"></script>')
  }, environment, id(1))
  assert.deepEqual(discovered.refs, readRpcActions)
  assert.equal(discovered.diagnostics.transport, 'rpc')
  assert.equal(discovered.diagnostics.manifestsRead, 1)
  assert.deepEqual(calls, ['/mikka', `/mikka?issue=${id(1)}`, '/mikka/settings?section=preferences', '/mikka/renderer-manifest.json'])
  for (const invalid of [{ ...manifest, target: 'desktop' }, { ...manifest, version: 2 },
    { ...manifest, usedActions: manifest.usedActions.slice(1) },
    { ...manifest, usedActions: [...manifest.usedActions, manifest.usedActions[0]] },
    { ...manifest, usedActions: undefined, exports: manifest.usedActions }]) assert.throws(() => publishedReadActions(invalid))
  for (const path of ['/mikka/assets/../private.js', '/mikka/assets/a%2fb.js', 'https://foreign.example/mikka/assets/app.js', '/mikka/renderer-manifest.json?override=1']) {
    assert.equal(requestAllowed(path, {}, environment), false)
  }
})

test('only the exact published RPC read with the real same-origin protocol is allowed', () => {
  const { path, init } = rpcReadRequest('pollIssue', [id(1)], environment, readRpcActions)
  assert.equal(requestAllowed(path, init, environment, readRpcActions), true)
  assert.equal(requestAllowed(path, init, environment, {}), false)
  for (const changed of [
    { ...init, body: JSON.stringify({ version: 1, action: 'issues.deleteIssue', args: [id(1)] }) },
    { ...init, body: JSON.stringify({ version: 1, action: 'issues.pollIssue', args: [], owner: id(1) }) },
    { ...init, body: JSON.stringify({ version: 1, action: 'issues.pollIssue', args: {} }) },
    ...['origin', 'x-mikka-rpc', 'content-type', 'accept'].map(name => ({ ...init, headers: { ...init.headers, [name]: 'wrong' } })),
    ...['authorization', 'cookie', 'host', 'x-mikka-session-cache', 'x-mikka-session-token', 'next-action'].map(name => ({ ...init, headers: { ...init.headers, [name]: 'private' } })),
  ]) assert.equal(requestAllowed(path, changed, environment, readRpcActions), false)
  assert.equal(requestAllowed(path + '?override=1', init, environment, readRpcActions), false)
  assert.throws(() => rpcReadRequest('sendCoordinatorMessage', [], environment, readRpcActions))
})

test('RPC read accounting waits for actual JSON and rejects protocol errors without retaining private content', async () => {
  const complete = Promise.withResolvers(), records = []
  let payload = { version: 1, ok: true, result: { issue: { text: 'private fixture content', at: { $mikka: 'date', value: '2026-11-05T00:00:00.000Z' } } } }
  let calls = 0
  const client = createReadClient({ request: async (path, init) => {
    calls++
    assert.equal(path, '/mikka/api/rpc')
    assert.equal(init.headers.origin, environment.origin)
    assert.deepEqual(JSON.parse(init.body), { version: 1, action: 'issues.pollIssue', args: [id(1)] })
    await complete.promise
    return Response.json(payload)
  } }, environment, 'owner', records, readRpcActions)
  const reading = client.action('pollIssue', [id(1)], 'task-detail', 'cold')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records.length, 0)
  complete.resolve()
  const result = await reading
  assert.equal(result.issue.at.toISOString(), '2026-11-05T00:00:00.000Z')
  assert.equal(records[0].httpBytes, Buffer.byteLength(JSON.stringify(payload)))
  assert.equal(records[0].jsonBytes, Buffer.byteLength(JSON.stringify(result)))
  assert.doesNotMatch(JSON.stringify(records), /private fixture/)
  for (payload of [{ ok: true, result: [] }, { version: 1, ok: true }, { version: 1, ok: false, error: { code: 'private' } }]) {
    await assert.rejects(client.action('pollIssue', [id(1)], 'task-detail', 'cold'), { code: 'read_action_response_invalid' })
  }
  assert.equal(records.length, 1)
  assert.equal(calls, 4)
})

test('response observation identifies browser RPC only by its actual request envelope', () => {
  const request = { method: () => 'POST', headers: () => ({ 'x-mikka-rpc': '1' }), postDataJSON: () => ({ version: 1, action: 'issues.pollIssue', args: [] }) }
  assert.deepEqual(observedAction(request, '/mikka/api/rpc', '/mikka', new Map()), { kind: 'rpc', action: 'issues.pollIssue' })
  assert.equal(observedAction({ ...request, headers: () => ({}) }, '/mikka/api/rpc', '/mikka', new Map()), null)
  assert.equal(observedAction({ ...request, postDataJSON: () => ({ action: 'issues.pollIssue' }) }, '/mikka/api/rpc', '/mikka', new Map()), null)
  assert.equal(observedAction(request, '/mikka/api/rpc?other', '/mikka', new Map()), null)
})

test('discovery before selecting an existing task uses only the main and settings pages and still requires every read action', async () => {
  const pages = []
  const found = await discoverReadActions(async path => {
    if (path === '/mikka' || path.startsWith('/mikka?') || path.startsWith('/mikka/settings?')) {
      pages.push(path)
      return new Response('<script src="/mikka/_next/static/chunks/read.js"></script>')
    }
    return new Response(READ_ACTIONS.map(name => `createServerReference("${refs[name]}",callServer,void 0,findSourceMapURL,"${name}")`).join(';'))
  }, environment)
  assert.deepEqual(pages, ['/mikka', '/mikka/settings?section=preferences'])
  assert.deepEqual(found.refs, refs)
  await assert.rejects(discoverReadActions(async () => new Response('<html></html>'), environment), { code: 'read_action_reference_missing' })
})

test('Flight decoder preserves large UTF-8 text rows and resolves only the action result', () => {
  const body = '任务正文\n'.repeat(300), bytes = Buffer.byteLength(body)
  const text = `0:{"a":"$@1","f":"","b":"development"}\n1:{"issue":{"content":"$2","at":"$D2026-11-05T00:00:00.000Z","literal":"$$not_a_ref"}}\n2:T${bytes.toString(16)},${body}`
  assert.deepEqual(actionResult(text), { issue: { content: body, at: '2026-11-05T00:00:00.000Z', literal: '$not_a_ref' } })
  assert.deepEqual(actionResult('0:{"a":"$@1"}\n1:{"error":"issueNotFound"}\n'), { error: 'issueNotFound' })
  assert.throws(() => actionResult('0:{"a":"$@1"}\n1:E{"digest":"private"}\n'), { code: 'action_server_error' })
  assert.throws(() => actionResult('0:{"a":"$@1"}\n1:{"nested":"$1"}\n'), { code: 'action_reference_invalid' })
  assert.throws(() => actionResult('0:{"a":"$@1"}\n1:Tff,short'), { code: 'action_text_invalid' })
  assert.throws(() => actionResult('1:{"issue":{}}\n'), { code: 'action_result_missing' })
})

test('transport rejects writes before request and reports only byte counts and trace IDs', async () => {
  let calls = 0
  const records = [], privateText = 'sensitive fixture text must stay in memory'
  const client = createReadClient({ request: async (path, init) => {
    assert.equal(path, environment.basePath)
    calls++
    assert.match(init.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
    return new Response(`0:{"a":"$@1"}\n1:${JSON.stringify({ issue: { text: privateText } })}\n`, { status: 200 })
  } }, environment, 'owner', records, refs)
  await assert.rejects(client.request('/mikka/api/coordinator/messages', { method: 'POST', body: '{}' }), { code: 'business_request_forbidden' })
  assert.throws(() => client.action('sendCoordinatorMessage', ['hello'], 'chat', 'bad'), { code: 'read_action_forbidden' })
  assert.equal(calls, 0)
  assert.equal((await client.action('pollIssue', [id(1)], 'task-detail', 'cold')).issue.text, privateText)
  assert.equal(calls, 1)
  assert.equal(records[0].httpStatus, 200)
  assert.ok(records[0].httpBytes > records[0].jsonBytes)
  assert.equal(JSON.stringify(records).includes(privateText), false)
  assert.deepEqual(publicFailure(new Error(privateText)), { status: 'fail', code: 'read_cache_acceptance_failed' })
  assert.deepEqual(publicFailure(new ReadCacheAcceptanceError('read_action_forbidden')), { status: 'fail', code: 'read_action_forbidden' })
})

test('the HTTP scenario exercises real cursor arguments, account isolation, deltas and deletion without a write action', async () => {
  const calls = [], issueIds = [id(1), id(2), id(3)], runIds = [id(4), id(5), id(6)], botId = id(7)
  const version = 'a'.repeat(32), changed = 'b'.repeat(32)
  const positions = ids => ids.map(value => ({ id: value, version }))
  let phase = 'cold'
  const fixture = { issueIds, runIds, botId, change: async () => { phase = 'changed' }, remove: async () => { phase = 'removed' } }
  const client = actor => ({
    json: async path => { assert.equal(path, '/mikka/api/settings/issue-prefix'); return { suggested: 'TEST', teamKeys: [] } },
    action: async (name, args, surface, scenario) => {
      calls.push({ name, args, actor, surface, scenario })
      assert.ok(READ_ACTIONS.includes(name))
      if (actor === 'peer') {
        if (name === 'syncCoordinatorChat') return { error: 'botNotFound' }
        if (name === 'pollIssue') return { error: 'issueNotFound' }
        return { snapshot: { version: changed, items: [], positions: [] } }
      }
      if (name === 'syncCoordinatorChat') {
        assert.equal(args[0], botId)
        if (phase === 'removed') return { chat: { version: changed, items: [{ position: 2 }, { position: 13 }] } }
        if (phase === 'changed') return { chat: { version: changed, after: 12, items: [{ position: 13 }] } }
        if (args.length === 1) return { chat: { version, items: Array.from({ length: 12 }, (_, index) => ({ position: index + 1 })), continuation: { after: 12, cursor: 12, prefix: version } } }
        assert.deepEqual(args[2], { after: 12, cursor: 12, prefix: version, sourceIds: [], artifactIds: [] })
        return { chat: args[1] === null ? { after: 12, items: [] } : { unchanged: true } }
      }
      if (name === 'pollIssue') {
        if (phase === 'removed') return { error: 'issueNotFound' }
        if (phase === 'changed') return { version: changed, issue: { title: 'Read cache changed' } }
        return args.length === 1 ? { version, issue: { content: { type: 'doc' } } } : { unchanged: true, version }
      }
      const ids = name === 'syncIssueList' ? issueIds : name === 'syncThreadList' ? runIds : [id(8), id(9), id(10)]
      if (phase === 'removed') return name === 'pollIssueVersionSummaries' ? { error: 'issueNotFound' } : { snapshot: { delta: true, items: [], positions: positions(ids.slice(1)), version: changed } }
      if (phase === 'changed') return { snapshot: { delta: true, items: [{ id: ids[0] }], positions: positions(ids), version: changed } }
      const cold = name === 'pollIssueVersionSummaries' ? args.length === 1 : args.length === 0
      if (!cold) {
        assert.equal(args[name === 'pollIssueVersionSummaries' ? 1 : 0], version)
        assert.deepEqual(args.at(-1), positions(ids))
      }
      return { snapshot: cold ? { version, items: ids.map(value => ({ id: value })), positions: positions(ids) } : { unchanged: true, version } }
    },
  })
  await exerciseReadCases({ owner: client('owner'), peer: client('peer'), fixture, environment })
  assert.equal(phase, 'removed')
  for (const scenario of ['cold', 'warm', 'reload-restored', 'peer-denied', 'peer-isolation', 'one-row-delta', 'deleted']) assert.ok(calls.some(call => call.scenario === scenario), scenario)
  assert.ok(calls.some(call => call.name === 'pollIssueVersionSummaries' && call.scenario === 'deleted'))
})
