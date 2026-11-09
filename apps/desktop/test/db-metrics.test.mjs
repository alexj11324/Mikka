import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createLifecycleQueryCounter, projectQuerySnapshot, queryCountDelta } from './lifecycle-query-counts.mjs'
import queryOperations from './db-query-operations.cjs'
import unattributedSourceKeys from './db-query-unattributed-sources.cjs'
import './db-query-diagnostics.test.mjs'

const require = createRequire(import.meta.url)
const run = promisify(execFile)
const metrics = new URL('./db-metrics.cjs', import.meta.url)
const pgRoot = dirname(require.resolve('pg/package.json'))

async function fixture(t, runtime) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-pg-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const packages = JSON.parse(await readFile(join(pgRoot, 'package.json'), 'utf8'))
  for (const directory of [join(root, 'node_modules'), join(root, '.output/server/node_modules')]) {
    await mkdir(directory, { recursive: true })
    // These are two actual installations of the pinned driver, not aliases of
    // one cached Client. Only its ordinary dependencies can share a realpath.
    await cp(pgRoot, join(directory, 'pg'), { recursive: true })
    for (const name of Object.keys(packages.dependencies)) {
      await symlink(await realpath(resolve(pgRoot, '..', name)), join(directory, name), 'dir')
    }
  }
  await writeFile(join(root, 'package.json'), '{}')
  if (runtime === 'nitro') await writeFile(join(root, '.output/mikka-build.json'), '{}')
  return root
}

const probe = String.raw`
const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const vm = require('node:vm')
const { AsyncLocalStorage } = require('node:async_hooks')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
const [root, metricsPath, runtime, mode, dependencies] = process.argv.slice(2)
const packages = JSON.parse(dependencies)
const appEntry = join(root, runtime === 'nitro' ? '.output/server/mikka-entry.mjs' : 'package.json')
const appRequire = Module.createRequire(appEntry)
const selectedEntry = appRequire.resolve('pg')
const otherRequire = Module.createRequire(join(root, runtime === 'nitro' ? 'package.json' : '.output/server/mikka-entry.mjs'))
const otherEntry = otherRequire.resolve('pg')
assert.notEqual(selectedEntry, otherEntry)
let handler, listening = 0, chmods = 0
const context = vm.createContext({ URL, process: { pid: process.pid, cwd: () => root, env: {
  MIKKA_DESKTOP_METRICS_SOCKET: '/tmp/mikka-fixture.sock',
  E2E_DATABASE_URL: 'postgresql://fixture@127.0.0.1/metrics_e2e',
  DATABASE_URL: 'postgresql://fixture@127.0.0.1/metrics_e2e',
  MIKKA_DATABASE_URL: 'postgresql://fixture@127.0.0.1/metrics_e2e', MIKKA_LOCAL_TEST_ACCOUNTS: '1',
} } })
const routeScope = new AsyncLocalStorage()
context[Symbol.for('mikka.requestRoute')] = routeScope
const localRequire = id => id === 'node:http' ? { createServer: callback => {
  handler = callback
  return { on() { return this }, listen(path, ready) { assert.equal(path, '/tmp/mikka-fixture.sock'); listening++; ready() }, unref() {} }
} } : id === 'node:fs' ? { ...fs, chmodSync: (path, mode) => {
  assert.equal(path, '/tmp/mikka-fixture.sock'); assert.equal(mode, 0o600); chmods++
} } : Module.createRequire(metricsPath)(id)
const source = fs.readFileSync(metricsPath, 'utf8')
const sourceKeys = Module.createRequire(metricsPath)('./db-query-unattributed-sources.cjs')
const load = () => vm.runInContext('(function(require) {' + source + '\n})', context)(localRequire)
const snapshot = (reset = false) => {
  let result
  handler({ method: reset ? 'POST' : 'GET', url: reset ? '/reset' : '/metrics' }, {
    writeHead(status) { assert.equal(status, 200); return this }, end(body) { result = JSON.parse(body) },
  })
  return result
}
load()
assert.equal(require.cache[selectedEntry], undefined, 'the preload must not initialize the actual PG before tracing')
assert.equal(require.cache[otherEntry], undefined)
assert.equal(snapshot().instrumentedClients, 0)

// Register the actual installed OpenTelemetry instrumentation after the metrics
// preload, as the product does. Its query wrapper must remain in the chain.
const { registerInstrumentations } = require(packages.instrumentation)
const { PgInstrumentation } = require(packages.pgInstrumentation)
const { NodeTracerProvider, SimpleSpanProcessor, InMemorySpanExporter } = require(packages.sdk)
const exporter = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
provider.register()
const instrumentation = new PgInstrumentation({ requireParentSpan: true, ignoreConnectSpans: true })
registerInstrumentations({ tracerProvider: provider, instrumentations: [instrumentation] })
assert.equal(require.cache[selectedEntry], undefined, 'tracing setup itself does not load the selected PG')

;(async () => {
  // The import-only case runs in its own process: no require('pg') prewarming.
  const selected = mode === 'esm' ? await import(pathToFileURL(join(require('node:path').dirname(appRequire.resolve('pg/package.json')), 'esm/index.mjs')).href) : appRequire('pg')
  const other = otherRequire('pg')
  assert.notEqual(selected.Client, other.Client)
  const wrapped = selected.Client.prototype.query
  assert.equal(snapshot().runtime, runtime)
  assert.equal(snapshot().instrumentedClients, 1)
  assert.equal(snapshot().queryCalls, 0)
  load()
  assert.equal(selected.Client.prototype.query, wrapped, 'a second preload must not replace the tracing wrapper')
  appRequire('pg')
  assert.equal(listening, 1); assert.equal(chmods, 1)

  const stream = Object.assign(new EventEmitter(), { bytesRead: 300, bytesWritten: 200 })
  const client = new selected.Client({ database: 'metrics_e2e' })
  client.connection.stream = stream
  // No database/network here. Exercise the real driver's callback API while
  // supplying a deterministic connection event and synthetic stream counters.
  client._connect = callback => { client.emit('connect'); callback() }
  await client.connect()
  client._queryable = false
  await provider.getTracer('metrics-regression').startActiveSpan('owned-fixture', async span => {
    try { await new Promise(resolve => client.query('SELECT 1', error => { assert.ok(error); resolve() })) }
    finally { span.end() }
  })
  stream.bytesRead += 81; stream.bytesWritten += 27
  const first = snapshot()
  assert.equal(first.queryCalls, 1); assert.equal(first.pgProtocolReceiveBytes, 81); assert.equal(first.pgProtocolSendBytes, 27)
  assert.equal(first.unknownReadings, 0)
  await provider.forceFlush()
  assert.equal(exporter.getFinishedSpans().filter(span => span.attributes['db.system'] === 'postgresql' || span.attributes['db.system.name'] === 'postgresql').length, 1, 'exactly one real OTel query wrapper remains active')
  const privateRoute = '/PRIVATE_OPERATION_CANARY?secret=PRIVATE_VALUE_CANARY'
  await Promise.all(['/actions/coordinator/poll', '/api/live/ticket', privateRoute].map(route => routeScope.run(route, async () => {
    await Promise.resolve()
    await new Promise(resolve => client.query('SELECT 1', () => resolve()))
  })))
  const attributed = snapshot()
  assert.equal(attributed.queryCalls, 4)
  assert.equal(attributed.queryOperations['/actions/coordinator/poll'], 1)
  assert.equal(attributed.queryOperations['/api/live/ticket'], 1)
  assert.equal(attributed.queryOperations.unattributed, 2, 'missing and unrecognized contexts remain counted')
  assert.equal(Object.values(attributed.queryOperations).reduce((total, count) => total + count, 0), attributed.queryCalls)
  assert.deepEqual(attributed.unattributedSources, Object.fromEntries(sourceKeys.map(key => [key, ['otherScoped', 'noScope'].includes(key) ? 1 : 0])))
  assert.equal(JSON.stringify(attributed).includes('PRIVATE_'), false)
  // Exercise these shared chat routes even when an older vocabulary omits them.
  const labels = [...new Set([...sourceKeys.filter(key => !['otherScoped', 'noScope'].includes(key)),
    '/api/approved-writes', '/api/conversations/[id]/read', '/api/mobile/reactions'])]
  const unlisted = ['noScope', '/v1/devices/PRIVATE_ID_CANARY/heartbeat', { private: 'PRIVATE_SCOPE_CANARY' }]
  await Promise.all([...labels, ...unlisted].map(route => routeScope.run(route, async () => {
    await Promise.resolve()
    await new Promise(resolve => client.query('SELECT 1', () => resolve()))
  })))
  const refined = snapshot()
  assert.equal(refined.queryCalls, 4 + labels.length + unlisted.length)
  assert.equal(refined.queryOperations['/actions/coordinator/poll'], 1)
  assert.equal(refined.queryOperations['/api/live/ticket'], 1)
  assert.equal(refined.unattributedSources.noScope, 1)
  for (const label of labels) assert.equal(refined.unattributedSources[label], 1, label)
  assert.equal(refined.unattributedSources.otherScoped, 4, 'concrete IDs, non-string scopes and reserved bucket names are not templates')
  assert.equal(Object.values(refined.unattributedSources).reduce((total, count) => total + count, 0), refined.queryOperations.unattributed)
  assert.equal(Object.values(refined.queryOperations).reduce((total, count) => total + count, 0), refined.queryCalls)
  assert.equal(JSON.stringify(refined).includes('PRIVATE_'), false)
  assert.ok(Buffer.byteLength(JSON.stringify(refined)) <= 8192, 'the unchanged metric response bound includes the closed refinement')
  let diagnostics
  handler({ method: 'GET', url: '/diagnostics' }, {
    writeHead(status) { assert.equal(status, 200, 'the isolated counter must export bounded query diagnostics after measurement'); return this },
    end(body) { diagnostics = JSON.parse(body) },
  })
  assert.equal(diagnostics.version, 1)
  assert.equal(diagnostics.queries.length, refined.queryCalls)
  assert.equal(diagnostics.endQueryCalls, refined.queryCalls)
  assert.equal(JSON.stringify(diagnostics).includes('PRIVATE_'), false)
  const { scopeKeys } = Module.createRequire(metricsPath)('./db-query-diagnostics.cjs')
  const diagnosticOperations = Object.fromEntries(Object.keys(refined.queryOperations).map(key => [key, 0]))
  const diagnosticSources = Object.fromEntries(sourceKeys.map(key => [key, 0]))
  for (const row of diagnostics.queries) {
    const scope = scopeKeys[row[3]], bucket = Object.hasOwn(diagnosticOperations, scope) ? scope : 'unattributed'
    diagnosticOperations[bucket]++
    if (bucket === 'unattributed') diagnosticSources[scope]++
  }
  assert.deepEqual(diagnosticOperations, refined.queryOperations, 'every original operation count retains its query ordinal')
  assert.deepEqual(diagnosticSources, refined.unattributedSources, 'reserved names keep the original source bucket semantics')
  const outsider = new other.Client()
  outsider._queryable = false
  await new Promise(resolve => outsider.query('SELECT 1', () => resolve()))
  assert.equal(snapshot().queryCalls, refined.queryCalls, 'the unselected source/traced copy must not be counted')
  assert.equal(snapshot(true).pgProtocolReceiveBytes, 0)
  assert.equal(Object.values(snapshot().queryOperations).reduce((total, count) => total + count, 0), 0)
  assert.equal(Object.values(snapshot().unattributedSources).reduce((total, count) => total + count, 0), 0)
  stream.bytesRead += 19; stream.bytesWritten += 7; stream.emit('close')
  const end = snapshot()
  assert.equal(end.pgProtocolReceiveBytes, 19); assert.equal(end.pgProtocolSendBytes, 7)
  assert.equal(end.closedConnections, 1); assert.equal(end.activeConnections, 0)
  assert.equal(end.instrumentedClients, 1); assert.equal(end.unknownReadings, 0)
  instrumentation.disable(); await provider.shutdown()
  console.log(JSON.stringify({ runtime, mode, differentClients: true, lazyLoad: true, tracingPreserved: true, queryCount: first.queryCalls, syntheticReceiveBytes: first.pgProtocolReceiveBytes, duplicatePreloadCount: listening }))
})().catch(error => { console.error(error); process.exitCode = 1 })
`

for (const [runtime, mode] of [['next', 'cjs'], ['nitro', 'cjs'], ['nitro', 'esm']]) {
  test(`${runtime} ${mode}: bind the actual PG after tracing, with distinct copies and no double count`, { timeout: 20_000 }, async t => {
    const root = await fixture(t, runtime)
    const dependencies = {
      instrumentation: require.resolve('@opentelemetry/instrumentation'),
      pgInstrumentation: require.resolve('@opentelemetry/instrumentation-pg'),
      sdk: require.resolve('@opentelemetry/sdk-trace-node'),
    }
    const script = join(root, 'probe.cjs')
    await writeFile(script, probe)
    const { stdout } = await run(process.execPath, [script, root, metrics.pathname, runtime, mode, JSON.stringify(dependencies)], {
      env: { PATH: process.env.PATH }, timeout: 15_000, maxBuffer: 32_768,
    })
    assert.deepEqual(JSON.parse(stdout), { runtime, mode, differentClients: true, lazyLoad: true, tracingPreserved: true,
      queryCount: 1, syntheticReceiveBytes: 81, duplicatePreloadCount: 1 })
  })
}

test('Nitro cannot fall back to source PG when its traced dependency is absent or points outside the output', async t => {
  const root = await fixture(t, 'nitro')
  const traced = join(root, '.output/server/node_modules/pg')
  await rm(traced, { recursive: true })
  for (const linked of [false, true]) {
    if (linked) await symlink(join(root, 'node_modules/pg'), traced, 'dir')
    await assert.rejects(run(process.execPath, ['--require', metrics.pathname, '-e', 'throw new Error("unexpected startup")'], {
      cwd: root, env: { PATH: process.env.PATH, MIKKA_LOCAL_TEST_ACCOUNTS: '1',
        MIKKA_DESKTOP_METRICS_SOCKET: '/tmp/mikka-fixture-unused.sock',
        E2E_DATABASE_URL: 'postgresql://fixture@127.0.0.1/metrics_e2e',
        DATABASE_URL: 'postgresql://fixture@127.0.0.1/metrics_e2e', MIKKA_DATABASE_URL: 'postgresql://fixture@127.0.0.1/metrics_e2e' },
      timeout: 5_000, maxBuffer: 8192,
    }), error => error.code === 1 && error.stderr.includes('DESKTOP_METRICS_PG_TARGET_MISMATCH'))
  }
})

const counterIdentity = { pid: 123, runtime: 'nitro' }
const counterSample = (overrides = {}) => ({
  version: 1, ...counterIdentity, startedAt: 1000, endedAt: 2000, instrumentedClients: 1,
  queryCalls: 5, pgProtocolReceiveBytes: 100, pgProtocolSendBytes: 40,
  activeConnections: 1, closedConnections: 0, unknownReadings: 0,
  measurement: 'all_pg_client_calls_and_connection_protocol_bytes', ...overrides,
})

test('lifecycle query windows retain exact counter deltas and omit unrelated content', () => {
  const before = projectQuerySnapshot(counterSample({ secret: 'counter-private-canary' }), counterIdentity)
  const after = projectQuerySnapshot(counterSample({ endedAt: 2500, queryCalls: 9, pgProtocolReceiveBytes: 180,
    pgProtocolSendBytes: 70, activeConnections: 0, closedConnections: 1 }), counterIdentity)
  assert.deepEqual(queryCountDelta(before, after), { startedAt: new Date(2000).toISOString(), finishedAt: new Date(2500).toISOString(),
    durationMs: 500, queryCalls: 4, pgProtocolReceiveBytes: 80, pgProtocolSendBytes: 30, closedConnections: 1, unknownReadings: 0 })
  assert.equal(JSON.stringify(before).includes('counter-private-canary'), false)
})

const operationCounts = (overrides = {}) => ({ ...Object.fromEntries(queryOperations.map(key => [key, 0])), ...overrides })
const sourceCounts = (overrides = {}) => ({ ...Object.fromEntries(unattributedSourceKeys.map(key => [key, 0])), ...overrides })

test('operation SQL counts partition the original full window without removing unknown or background work', () => {
  const before = projectQuerySnapshot(counterSample({ queryOperations: operationCounts({ '/api/live/ticket': 2, unattributed: 3 }) }), counterIdentity)
  const after = projectQuerySnapshot(counterSample({ endedAt: 2500, queryCalls: 10,
    queryOperations: operationCounts({ '/api/live/ticket': 3, '/actions/threads/poll': 2, unattributed: 5 }) }), counterIdentity)
  const delta = queryCountDelta(before, after)
  assert.equal(delta.queryCalls, 5)
  assert.deepEqual(delta.queryOperations, operationCounts({ '/api/live/ticket': 1, '/actions/threads/poll': 2, unattributed: 2 }))
  assert.equal(Object.values(delta.queryOperations).reduce((sum, count) => sum + count, 0), delta.queryCalls)
  assert.equal(before.queryOperations.unattributed, 3)
})

test('operation SQL attribution refuses unknown labels, missing buckets, inconsistent totals and partial histories', () => {
  const counts = operationCounts({ unattributed: 5 })
  const before = projectQuerySnapshot(counterSample({ queryOperations: counts }), counterIdentity)
  const missing = { ...counts }; delete missing.unattributed
  for (const value of [null, [], missing, { ...counts, PRIVATE_OPERATION_CANARY: 0 },
    operationCounts({ unattributed: 4 }), operationCounts({ unattributed: 5.5 }), operationCounts({ unattributed: -1 })]) {
    assert.throws(() => projectQuerySnapshot(counterSample({ queryOperations: value }), counterIdentity), /LIFECYCLE_QUERY_COUNTER_SNAPSHOT_INVALID/)
  }
  const legacy = projectQuerySnapshot(counterSample(), counterIdentity)
  assert.equal('queryOperations' in legacy, false, 'historical absence is not a synthetic zero partition')
  assert.throws(() => queryCountDelta(before, legacy), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
  assert.throws(() => queryCountDelta(legacy, before), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
  const decreased = projectQuerySnapshot(counterSample({ endedAt: 2500, queryCalls: 6,
    queryOperations: operationCounts({ '/api/live/ticket': 2, unattributed: 4 }) }), counterIdentity)
  assert.throws(() => queryCountDelta(before, decreased), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
})

test('unattributed source refinement conserves the original partition and full-window deltas', () => {
  const before = projectQuerySnapshot(counterSample({
    queryOperations: operationCounts({ '/api/live/ticket': 2, unattributed: 3 }),
    unattributedSources: sourceCounts({ '/api/settings/model-order': 2, noScope: 1 }),
  }), counterIdentity)
  const after = projectQuerySnapshot(counterSample({ endedAt: 2500, queryCalls: 10,
    queryOperations: operationCounts({ '/api/live/ticket': 3, '/actions/threads/poll': 2, unattributed: 5 }),
    unattributedSources: sourceCounts({ '/api/settings/model-order': 3, 'after:live-notify': 1, noScope: 1 }),
  }), counterIdentity)
  assert.deepEqual(before.unattributedSources, sourceCounts({ '/api/settings/model-order': 2, noScope: 1 }))
  const delta = queryCountDelta(before, after)
  assert.equal(delta.queryCalls, 5)
  assert.deepEqual(delta.queryOperations, operationCounts({ '/api/live/ticket': 1, '/actions/threads/poll': 2, unattributed: 2 }))
  assert.deepEqual(delta.unattributedSources, sourceCounts({ '/api/settings/model-order': 1, 'after:live-notify': 1 }))
  assert.equal(Object.values(delta.unattributedSources).reduce((sum, count) => sum + count, 0), delta.queryOperations.unattributed)
  assert.equal(Object.values(delta.queryOperations).reduce((sum, count) => sum + count, 0), delta.queryCalls)
})

test('unattributed source refinement rejects incomplete evidence without upgrading legacy reports', () => {
  const operations = operationCounts({ '/api/live/ticket': 2, unattributed: 3 })
  const sources = sourceCounts({ '/api/settings/model-order': 2, noScope: 1 })
  const before = projectQuerySnapshot(counterSample({ queryOperations: operations, unattributedSources: sources }), counterIdentity)
  const missing = { ...sources }; delete missing.otherScoped
  for (const value of [null, [], missing, { ...sources, PRIVATE_SOURCE_CANARY: 0 },
    sourceCounts({ noScope: 2 }), sourceCounts({ noScope: 3.5 }), sourceCounts({ noScope: -1 }),
    sourceCounts({ noScope: Number.MAX_SAFE_INTEGER + 1 })]) {
    assert.throws(() => projectQuerySnapshot(counterSample({ queryOperations: operations, unattributedSources: value }), counterIdentity),
      /LIFECYCLE_QUERY_COUNTER_SNAPSHOT_INVALID/)
  }
  assert.throws(() => projectQuerySnapshot(counterSample({ unattributedSources: sources }), counterIdentity),
    /LIFECYCLE_QUERY_COUNTER_SNAPSHOT_INVALID/)
  const legacy = projectQuerySnapshot(counterSample({ queryOperations: operations }), counterIdentity)
  assert.equal('unattributedSources' in legacy, false, 'historical absence does not prove a zero source partition')
  assert.throws(() => queryCountDelta(before, legacy), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
  assert.throws(() => queryCountDelta(legacy, before), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
  const decreased = projectQuerySnapshot(counterSample({ endedAt: 2500, queryCalls: 6,
    queryOperations: operationCounts({ '/api/live/ticket': 2, unattributed: 4 }),
    unattributedSources: sourceCounts({ '/api/settings/model-order': 1, noScope: 3 }),
  }), counterIdentity)
  assert.throws(() => queryCountDelta(before, decreased), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
})

test('unattributed source refinement fits the unchanged control-response limit at the largest safe count', () => {
  const each = Math.floor(Number.MAX_SAFE_INTEGER / unattributedSourceKeys.length)
  const remainder = Number.MAX_SAFE_INTEGER - each * unattributedSourceKeys.length
  const sources = Object.fromEntries(unattributedSourceKeys.map((key, index) => [key, each + (index < remainder ? 1 : 0)]))
  const value = counterSample({ queryCalls: Number.MAX_SAFE_INTEGER,
    queryOperations: operationCounts({ unattributed: Number.MAX_SAFE_INTEGER }),
    unattributedSources: sources,
    excludes: ['connection_handshake', 'TCP_TLS_overhead', 'other_processes'],
  })
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 8192)
  assert.deepEqual(projectQuerySnapshot(value, counterIdentity).unattributedSources, sources)
})

test('the 78-source refinement rejects a historical 75-key partition without backfilling it', () => {
  assert.equal(unattributedSourceKeys.length, 78)
  const historical = sourceCounts({ otherScoped: 5 })
  for (const key of ['/api/approved-writes', '/api/conversations/[id]/read', '/api/mobile/reactions']) delete historical[key]
  const original = JSON.stringify(historical)
  assert.equal(Object.keys(historical).length, 75)
  assert.throws(() => projectQuerySnapshot(counterSample({
    queryOperations: operationCounts({ unattributed: 5 }), unattributedSources: historical,
  }), counterIdentity), /LIFECYCLE_QUERY_COUNTER_SNAPSHOT_INVALID/)
  assert.equal(JSON.stringify(historical), original, 'the original unknown source count is not reclassified')
})

test('lifecycle query windows refuse a changed process, reset, missing driver and unknown readings', () => {
  const before = projectQuerySnapshot(counterSample(), counterIdentity)
  for (const change of [{ pid: 456 }, { runtime: 'next' }, { instrumentedClients: 0 }, { queryCalls: null }, { queryCalls: -1 }]) {
    assert.throws(() => projectQuerySnapshot(counterSample(change), counterIdentity), /LIFECYCLE_QUERY_COUNTER_SNAPSHOT_INVALID/)
  }
  for (const change of [{ pid: 456 }, { runtime: 'next' }, { startedAt: 2000 }, { endedAt: 1999 }, { queryCalls: 4 }, { pgProtocolReceiveBytes: 99 }]) {
    assert.throws(() => queryCountDelta(before, { ...before, ...change }), /LIFECYCLE_QUERY_COUNTER_CHANGED/)
  }
  assert.throws(() => queryCountDelta(before, { ...before, unknownReadings: 1 }), /LIFECYCLE_QUERY_COUNTER_UNKNOWN/)
})

test('lifecycle reads only the attested primary metric socket, with bounded closed errors', async () => {
  const revision = 'a'.repeat(40), origin = 'http://localhost:3000'
  const descriptor = { revision, origin, bundled: { ...counterIdentity, port: 3000, socket: '/tmp/mikka-bundled-44.sock' },
    hosted: { pid: 456, port: 3001, socket: '/tmp/mikka-hosted-44.sock' } }
  let body = JSON.stringify(counterSample()), calls = 0
  const dependencies = {
    read: async () => JSON.stringify(descriptor),
    httpRequest(options, callback) {
      calls++
      assert.equal(options.socketPath, descriptor.bundled.socket)
      assert.equal(options.path, '/metrics')
      assert.equal(options.method, 'GET')
      assert.ok(options.signal instanceof AbortSignal)
      const req = new EventEmitter()
      req.destroy = error => req.emit('error', error)
      req.end = () => queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode: 200 })
        callback(response)
        response.emit('data', Buffer.from(body))
        response.emit('end')
      })
      return req
    },
  }
  const counter = await createLifecycleQueryCounter({ revision, origin }, dependencies)
  assert.equal((await counter.snapshot()).pid, counterIdentity.pid)
  for (const value of ['{"private-canary": invalid}', 'x'.repeat(8193)]) {
    body = value
    await assert.rejects(counter.snapshot(), error => error.message === 'LIFECYCLE_QUERY_COUNTER_READ_FAILED' && !error.message.includes('private-canary'))
  }
  const completedCalls = calls
  for (const change of [{ revision: 'b'.repeat(40) }, { origin: 'http://localhost:3001' },
    { bundled: descriptor.hosted }, { bundled: { ...descriptor.bundled, socket: 'https://example.invalid/counter' } }]) {
    await assert.rejects(createLifecycleQueryCounter({ revision, origin }, { ...dependencies, read: async () => JSON.stringify({ ...descriptor, ...change }) }),
      /LIFECYCLE_QUERY_COUNTER_RUNTIME_MISMATCH/)
  }
  assert.equal(calls, completedCalls, 'a mismatched counter must not be queried')
})

const rpcWindows = Object.fromEntries(['nativeLogin', 'webLogin', 'startup-bundled', 'startup-hosted'].map((name, index) =>
  [name, { status: 'complete', total: { startedAt: new Date(2000 + index * 2000).toISOString(), finishedAt: new Date(3000 + index * 2000).toISOString() } }]))
const rpcEvent = (id, milliseconds, complete = false, extra = {}) => ({
  msg: complete ? 'api_request' : 'api_request_started', timestamp: new Date(milliseconds).toISOString(),
  invocationId: '00000000-0000-4000-8000-' + String(id).padStart(12, '0'),
  route: '/api/desktop/rpc', method: 'POST',
  ...(complete ? { rpcAction: 'preferences.getPreferences', status: 200 } : {}), ...extra,
})

async function rpcLogFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-lifecycle-rpc-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const revision = 'a'.repeat(40), origin = 'http://localhost:3000', runtimePath = join(directory, 'processes.json')
  const log = join(directory, 'bundled-' + revision.slice(0, 12) + '-44.log')
  const descriptor = { revision, origin, bundled: { ...counterIdentity, port: 3000, socket: '/tmp/mikka-bundled-44.sock', log } }
  await writeFile(runtimePath, JSON.stringify(descriptor), { mode: 0o600 })
  const counter = await createLifecycleQueryCounter({ revision, origin, runtimePath }, {
    httpRequest() { throw new Error('RPC diagnostics must not query the API or metrics socket') },
  })
  return { log, descriptor, runtimePath, counter, write: events => writeFile(log, events.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 }) }
}

test('RPC diagnostics count four windows by request start, deduplicate unordered receipts and discard private fields', async t => {
  const f = await rpcLogFixture(t), secret = 'PRIVATE_RPC_CONTENT_CANARY'
  const completed = rpcEvent(1, 2500, true, { userIdHash: secret, requestId: secret, error: secret, body: secret, arguments: [secret] })
  await f.write([
    completed, rpcEvent(1, 2000), completed, rpcEvent(1, 2000),
    rpcEvent(2, 1999), rpcEvent(2, 2000, true),
    rpcEvent(3, 2999), rpcEvent(3, 3000, true),
    rpcEvent(4, 3000), rpcEvent(4, 3100, true),
    rpcEvent(5, 4000, false, { route: '/api/rpc' }), rpcEvent(5, 4500, true, { route: '/api/rpc' }),
    rpcEvent(6, 6000), rpcEvent(6, 6500, true),
    rpcEvent(7, 8000, false, { route: '/api/rpc' }), rpcEvent(7, 8500, true, { route: '/api/rpc' }),
    rpcEvent(8, 2100, true, { route: '/api/other', rpcAction: 'private.canary', body: secret }),
  ])
  const result = await f.counter.rpcActions(rpcWindows)
  assert.equal(result.status, 'complete')
  assert.equal(result.duplicateRecords, 2)
  const native = result.windows.nativeLogin.actions[0]
  assert.deepEqual(native, { route: '/api/desktop/rpc', rpcAction: 'preferences.getPreferences',
    startedInWindow: 2, completedInWindow: 2, crossesStart: 1, crossesEnd: 1,
    completionNotObserved: 0, completionWithoutStart: 0, statusCounts: [{ status: 200, count: 3 }] })
  for (const name of ['webLogin', 'startup-bundled', 'startup-hosted']) {
    assert.equal(result.windows[name].status, 'complete')
    assert.equal(result.windows[name].actions[0].startedInWindow, 1)
    assert.equal(result.windows[name].actions[0].completedInWindow, 1)
  }
  const text = JSON.stringify(result)
  for (const value of [secret, completed.invocationId, 'userIdHash', 'requestId', 'private.canary', 'arguments']) assert.equal(text.includes(value), false)
})

test('RPC diagnostics retain unknown attribution and missing boundaries without double counting conflicting receipts', async t => {
  const f = await rpcLogFixture(t)
  await f.write([
    rpcEvent(1, 2100),
    rpcEvent(2, 2500, true),
    rpcEvent(3, 2200), rpcEvent(3, 2300, true), rpcEvent(3, 2300, true, { status: 500 }),
    rpcEvent(4, 2300), rpcEvent(4, 2400, true, { rpcAction: 'PRIVATE ACTION CANARY' }),
  ])
  const result = await f.counter.rpcActions(rpcWindows)
  assert.equal(result.status, 'incomplete')
  assert.equal(result.conflictingInvocations, 1)
  assert.ok(result.reasons.includes('unpaired_requests'))
  assert.ok(result.reasons.includes('invalid_request_record'))
  const native = result.windows.nativeLogin.actions
  assert.equal(native.reduce((sum, row) => sum + row.startedInWindow, 0), 2)
  assert.equal(native.reduce((sum, row) => sum + row.completionNotObserved, 0), 1)
  assert.equal(native.reduce((sum, row) => sum + row.completionWithoutStart, 0), 1)
  assert.equal(native.some(row => row.statusCounts.some(status => status.status === 500)), false)
  assert.equal(JSON.stringify(result).includes('PRIVATE ACTION CANARY'), false)
})

test('RPC diagnostic missing, partial and oversized logs remain unavailable rather than reporting zero calls', async t => {
  const f = await rpcLogFixture(t)
  for (const [prepare, reason] of [
    [() => rm(f.log, { force: true }), 'log_missing'],
    [() => writeFile(f.log, '{"msg":"api_request","private":"TRUNCATED_CANARY"', { mode: 0o600 }), 'log_partial_line'],
    [() => truncate(f.log, 16 * 1024 * 1024 + 1), 'log_size_limit'],
  ]) {
    await prepare()
    const result = await f.counter.rpcActions(rpcWindows)
    assert.equal(result.status, 'incomplete')
    assert.deepEqual(result.reasons, [reason])
    for (const window of Object.values(result.windows)) {
      assert.equal(window.status, 'unavailable')
      assert.equal(window.actions, undefined)
    }
    assert.equal(JSON.stringify(result).includes('TRUNCATED_CANARY'), false)
  }
})

test('RPC diagnostics accept only the descriptor-bound primary log and complete measured windows', async t => {
  const f = await rpcLogFixture(t)
  await f.write([rpcEvent(1, 2000), rpcEvent(1, 2500, true)])
  const partial = await f.counter.rpcActions({ nativeLogin: rpcWindows.nativeLogin })
  assert.equal(partial.windows.webLogin.status, 'unavailable')
  const other = await createLifecycleQueryCounter({ revision: f.descriptor.revision, origin: f.descriptor.origin, runtimePath: f.runtimePath }, {
    read: async () => JSON.stringify({ ...f.descriptor, bundled: { ...f.descriptor.bundled, log: join(dirname(f.log), 'foreign.log') } }),
  })
  const mismatched = await other.rpcActions(rpcWindows)
  assert.deepEqual(mismatched.reasons, ['log_binding_mismatch'])
  assert.equal(mismatched.windows.nativeLogin.actions, undefined)
})

test('RPC phase attribution separates handoff from workspace reads and preserves a completed login when startup is unavailable', async t => {
  const f = await rpcLogFixture(t)
  await f.write([rpcEvent(1, 2100), rpcEvent(1, 2301, true, { rpcAction: 'desktop.bootstrap' }),
    rpcEvent(2, 2300), rpcEvent(2, 2399, true, { rpcAction: 'desktop.bootstrap' }),
    rpcEvent(3, 1999), rpcEvent(3, 2050, true, { rpcAction: 'desktop.bootstrap' })])
  const nativeLogin = { ...rpcWindows.nativeLogin, segments: [
    { phase: 'common-email-authentication', startedAt: new Date(2000).toISOString(), finishedAt: new Date(2000).toISOString() },
    { phase: 'native-pkce-and-automatic-renderer-to-public-session', startedAt: new Date(2000).toISOString(), finishedAt: new Date(2300).toISOString() },
    { phase: 'workspace-selection-to-usable', startedAt: new Date(2300).toISOString(), finishedAt: new Date(3000).toISOString() },
  ] }
  const result = await f.counter.rpcActions({ nativeLogin })
  assert.equal(result.status, 'incomplete', 'missing startup measurements remain incomplete globally')
  assert.equal(result.windows.nativeLogin.status, 'complete', 'a separate missing window does not invalidate paired login records')
  assert.equal(result.windows.nativeLogin.segmentStatus, 'complete')
  const [auth, handoff, workspace] = result.windows.nativeLogin.segments
  assert.deepEqual(auth.actions, [])
  assert.equal(handoff.actions[0].startedInWindow, 1)
  assert.equal(handoff.actions[0].crossesEnd, 1)
  assert.equal(workspace.actions[0].startedInWindow, 1)
  assert.equal(workspace.actions[0].crossesStart, 1)
  assert.equal(workspace.actions[0].completedInWindow, 2)
  assert.equal(result.windows.nativeLogin.actions[0].startedInWindow, 2)
})

test('RPC phase attribution refuses private labels and non-partition boundaries without fabricating phases', async t => {
  const f = await rpcLogFixture(t)
  await f.write([rpcEvent(1, 2000), rpcEvent(1, 2500, true)])
  for (const segments of [
    [{ phase: 'PRIVATE_PHASE_CANARY', startedAt: new Date(2000).toISOString(), finishedAt: new Date(3000).toISOString() }],
    [{ phase: 'launch-to-usable', startedAt: new Date(2001).toISOString(), finishedAt: new Date(3000).toISOString() }],
    [{ phase: 'launch-to-usable', startedAt: new Date(2000).toISOString(), finishedAt: new Date(3001).toISOString() }],
  ]) {
    const result = await f.counter.rpcActions({ 'startup-bundled': { ...rpcWindows.nativeLogin, segments } })
    assert.equal(result.windows['startup-bundled'].segmentStatus, 'unavailable')
    assert.equal(result.windows['startup-bundled'].segments, undefined)
    assert.ok(result.reasons.includes('query_segments_invalid'))
    assert.equal(JSON.stringify(result).includes('PRIVATE_PHASE_CANARY'), false)
  }
})

const batchItem = (id, parent, at, complete, action = 'task-runs.pollTaskRuns', extra = {}) => rpcEvent(id, at, complete, {
  msg: complete ? 'rpc_action' : 'rpc_action_started', httpInvocationId: rpcEvent(parent, 0).invocationId,
  rpcAction: action, ...extra,
})

test('RPC batch diagnostics separate physical requests from logical actions without losing phase boundaries', async t => {
  const f = await rpcLogFixture(t)
  const events = [rpcEvent(1, 2100), rpcEvent(1, 2500, true, { rpcAction: 'desktop.readBatch', rpcItemCount: 2 }),
    batchItem(10, 1, 2110, false), batchItem(10, 1, 2400, true),
    batchItem(11, 1, 2310, false, 'issues.syncIssueList'), batchItem(11, 1, 2450, true, 'issues.syncIssueList'),
    rpcEvent(2, 2600), rpcEvent(2, 2800, true, { rpcAction: 'desktop.bootstrap' })]
  await f.write([...events, events[2], events[3]])
  const nativeLogin = { ...rpcWindows.nativeLogin, segments: [
    { phase: 'common-email-authentication', startedAt: new Date(2000).toISOString(), finishedAt: new Date(2000).toISOString() },
    { phase: 'native-pkce-and-automatic-renderer-to-public-session', startedAt: new Date(2000).toISOString(), finishedAt: new Date(2300).toISOString() },
    { phase: 'workspace-selection-to-usable', startedAt: new Date(2300).toISOString(), finishedAt: new Date(3000).toISOString() },
  ] }
  const result = await f.counter.rpcActions({ ...rpcWindows, nativeLogin })
  assert.equal(result.status, 'complete')
  assert.equal(result.windows.nativeLogin.actions.reduce((n, row) => n + row.startedInWindow, 0), 2)
  assert.equal(result.logical.status, 'complete')
  assert.equal(result.logical.duplicateRecords, 2)
  assert.equal(result.logical.windows.nativeLogin.actions.reduce((n, row) => n + row.startedInWindow, 0), 3)
  assert.ok(result.logical.windows.nativeLogin.actions.every(row => row.rpcAction !== 'desktop.readBatch'))
  const [, handoff, workspace] = result.logical.windows.nativeLogin.segments
  assert.equal(handoff.actions.find(row => row.rpcAction === 'task-runs.pollTaskRuns').crossesEnd, 1)
  assert.equal(workspace.actions.find(row => row.rpcAction === 'issues.syncIssueList').startedInWindow, 1)
  for (const id of [1, 2, 10, 11]) assert.ok(!JSON.stringify(result).includes(rpcEvent(id, 0).invocationId))
})

test('RPC batch diagnostics refuse missing, mismatched and out-of-parent action evidence', async t => {
  const f = await rpcLogFixture(t)
  const parent = [rpcEvent(1, 2100), rpcEvent(1, 2500, true, { rpcAction: 'desktop.readBatch', rpcItemCount: 2 })]
  const one = [batchItem(10, 1, 2110, false), batchItem(10, 1, 2400, true)]
  const two = [batchItem(11, 1, 2120, false), batchItem(11, 1, 2450, true)]
  for (const [events, reason] of [
    [[...parent, ...one], 'batch_item_count_mismatch'],
    [[...parent, ...one, batchItem(11, 99, 2120, false), batchItem(11, 99, 2450, true)], 'batch_parent_unobserved'],
    [[...parent, ...one, batchItem(11, 1, 2000, false), two[1]], 'batch_item_outside_parent'],
    [[...parent, ...one, two[0], batchItem(11, 1, 2450, true, 'issues.syncIssueList')], 'batch_item_binding_mismatch'],
    [[...parent, ...one, batchItem(11, 1, 2120, false, 'PRIVATE ACTION CANARY'), two[1]], 'invalid_batch_item'],
  ]) {
    await f.write(events)
    const result = await f.counter.rpcActions(rpcWindows)
    assert.equal(result.status, 'incomplete')
    assert.equal(result.logical.status, 'incomplete')
    assert.ok(result.logical.reasons.includes(reason), reason)
    assert.equal(result.windows.nativeLogin.actions[0].startedInWindow, 1)
    assert.equal(JSON.stringify(result).includes('PRIVATE ACTION CANARY'), false)
  }
})
