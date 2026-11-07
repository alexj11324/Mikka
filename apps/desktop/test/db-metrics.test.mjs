import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createLifecycleQueryCounter, projectQuerySnapshot, queryCountDelta } from './lifecycle-query-counts.mjs'

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
const localRequire = id => id === 'node:http' ? { createServer: callback => {
  handler = callback
  return { on() { return this }, listen(path, ready) { assert.equal(path, '/tmp/mikka-fixture.sock'); listening++; ready() }, unref() {} }
} } : id === 'node:fs' ? { ...fs, chmodSync: (path, mode) => {
  assert.equal(path, '/tmp/mikka-fixture.sock'); assert.equal(mode, 0o600); chmods++
} } : require(id)
const source = fs.readFileSync(metricsPath, 'utf8')
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
  const outsider = new other.Client()
  outsider._queryable = false
  await new Promise(resolve => outsider.query('SELECT 1', () => resolve()))
  assert.equal(snapshot().queryCalls, 1, 'the unselected source/traced copy must not be counted')
  assert.equal(snapshot(true).pgProtocolReceiveBytes, 0)
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
