import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import operations from './metrics/db-query-operations.cjs'
import sources from './metrics/db-query-unattributed-sources.cjs'
import { createLifecycleQueryCounter, projectQuerySnapshot, queryCountDelta } from './metrics/lifecycle-query-counts.mjs'
import { CLOSED_LABELS_SHA256, METRICS_BODY_MAX_BYTES, compactSnapshot, profileDelta } from './projection.mjs'
import { EXPECTED, REQUEST_PLAN } from './driver.mjs'

const expected = { pid: 123, runtime: 'nitro' }
const snapshot = () => ({ version: 1, pid: expected.pid, runtime: 'nitro', startedAt: 10, endedAt: 20,
  instrumentedClients: 1, queryCalls: 0, pgProtocolReceiveBytes: 0, pgProtocolSendBytes: 0,
  activeConnections: 1, closedConnections: 0, unknownReadings: 0,
  measurement: 'all_pg_client_calls_and_connection_protocol_bytes',
  queryOperations: Object.fromEntries(operations.map(key => [key, 0])),
  unattributedSources: Object.fromEntries(sources.map(key => [key, 0])),
})
const project = value => projectQuerySnapshot(value, expected)

test('the fixed table is the independently reviewed e7 catalogue, with residual unknowns retained', async () => {
  const bytes = await readFile(new URL('./closed-labels.json', import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), CLOSED_LABELS_SHA256)
  const table = JSON.parse(bytes)
  assert.equal(table.sourceHead, EXPECTED.candidate)
  assert.equal(table.compiledRevision, EXPECTED.source)
  assert.equal(table.reconstructedRoutesSha256, table.compiledRoutesSha256)
  assert.deepEqual(table.queryUnattributedSources, sources)
  assert.equal(sources.length, 287)
  assert.equal(new Set(sources).size, sources.length)
  assert.equal(operations.length, 17)
  for (const key of ['/api/agent/sessions', '/api/computer/events', '/api/conversations', '/api/pending-actions', 'otherScoped', 'noScope']) assert.ok(sources.includes(key))
  assert.ok(operations.every(key => key === 'unattributed' || !sources.includes(key)))
})

test('full snapshot validation rejects missing/extra labels, nonintegers, negative values and conservation loss', () => {
  assert.equal(project(snapshot()).queryCalls, 0)
  const mutations = [
    value => { delete value.unattributedSources }, value => { delete value.queryOperations },
    value => { delete value.unattributedSources.otherScoped },
    value => { value.unattributedSources.CANARY_PRIVATE_SCOPE = 0 },
    value => { value.unattributedSources.noScope = -1 },
    value => { value.unattributedSources.noScope = 0.5 },
    value => { value.queryOperations.unattributed = 1 },
    value => { value.queryCalls = 1 },
    value => { value.unattributedSources.noScope = 1 },
    value => { value.pid++ },
  ]
  for (const mutate of mutations) { const value = snapshot(); mutate(value); assert.throws(() => project(value), /SNAPSHOT_INVALID/) }
})

test('a sparse delta follows full-map monotonic and scalar validation and preserves otherScoped/noScope', () => {
  const before = snapshot(), after = snapshot()
  after.endedAt++
  after.queryCalls = 4
  after.queryOperations['/api/rpc'] = 1
  after.queryOperations.unattributed = 3
  for (const key of ['/api/agent/sessions', 'otherScoped', 'noScope']) after.unattributedSources[key] = 1
  after.pgProtocolReceiveBytes = 200; after.pgProtocolSendBytes = 100
  const value = profileDelta(project(before), project(after))
  assert.deepEqual(value.queryOperations, { '/api/rpc': 1, unattributed: 3 })
  assert.deepEqual(value.unattributedSources, { '/api/agent/sessions': 1, otherScoped: 1, noScope: 1 })
  assert.equal(Object.values(value.queryOperations).reduce((a, b) => a + b), value.queryCalls)
  assert.equal(Object.values(value.unattributedSources).reduce((a, b) => a + b), value.queryOperations.unattributed)
  const lower = structuredClone(after)
  lower.unattributedSources.otherScoped = 0; lower.unattributedSources.noScope = 2
  assert.throws(() => profileDelta(project(after), project(lower)), /COUNTER_CHANGED/)
  for (const mutate of [value => { value.pid++ }, value => { value.startedAt++ }, value => { value.endedAt-- },
    value => { value.pgProtocolReceiveBytes-- }, value => { value.unknownReadings++ }]) {
    const changed = structuredClone(after); mutate(changed)
    assert.throws(() => queryCountDelta(project(after), { ...project(changed), pid: changed.pid }))
  }
  const compact = compactSnapshot({ ...project(after), privatePayload: 'CANARY_PRIVATE_VALUE' })
  assert.ok(!JSON.stringify(compact).includes('CANARY_PRIVATE'))
  assert.ok(!Object.hasOwn(compact, 'queryOperations') && !Object.hasOwn(compact, 'unattributedSources'))
})

async function readThroughCounter(body, { aborted = false } = {}) {
  const descriptor = { revision: EXPECTED.source, origin: 'http://localhost:3000', bundled: { ...expected, port: 3000, socket: '/tmp/mikka-bundled-123.sock' } }
  const httpRequest = (options, callback) => {
    assert.equal(options.path, '/metrics'); assert.equal(options.method, 'GET')
    assert.equal(options.socketPath, descriptor.bundled.socket)
    const req = new EventEmitter()
    let destroyed = false
    req.destroy = error => { if (!destroyed) { destroyed = true; req.emit('error', error) } }
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = 200
      callback(response)
      for (let offset = 0; offset < body.length && !destroyed; offset += 1000) response.emit('data', body.subarray(offset, offset + 1000))
      if (!destroyed) response.emit(aborted ? 'aborted' : 'end')
    })
    return req
  }
  const counter = await createLifecycleQueryCounter({ revision: EXPECTED.source, origin: descriptor.origin },
    { read: async () => JSON.stringify(descriptor), httpRequest })
  return counter.snapshot()
}

test('the actual copied reader accepts the full 287-label response above 8 KiB and refuses truncation/overflow', async () => {
  const value = snapshot()
  for (const key of sources) value.unattributedSources[key] = 1_000_000
  value.queryCalls = value.queryOperations.unattributed = sources.length * 1_000_000
  const bytes = Buffer.from(JSON.stringify(value))
  assert.ok(bytes.length > 8192 && bytes.length < METRICS_BODY_MAX_BYTES)
  assert.equal((await readThroughCounter(bytes)).queryCalls, value.queryCalls)
  await assert.rejects(readThroughCounter(bytes.subarray(0, bytes.length - 1)), /COUNTER_READ_FAILED/)
  await assert.rejects(readThroughCounter(bytes, { aborted: true }), /COUNTER_READ_FAILED/)
  await assert.rejects(readThroughCounter(Buffer.concat([bytes, Buffer.alloc(METRICS_BODY_MAX_BYTES, 32)])), /COUNTER_READ_FAILED/)
})

test('the unchanged preload counts real method invocations against the new table without retaining arguments', async () => {
  // Execute the real copied preload with only its module/HTTP boundary faked.
  // No socket, pg service, connection or product import is created here.
  const text = await readFile(new URL('./metrics/db-metrics.cjs', import.meta.url), 'utf8')
  let handler
  const route = new AsyncLocalStorage(), root = '/fixture-source', pgEntry = `${root}/.output/server/node_modules/pg/lib/index.js`
  const pgClientEntry = `${root}/.output/server/node_modules/pg/lib/client.js`
  class Client extends EventEmitter {
    query(...args) { assert.equal(args.length, 2); return 'original-result' }
    connect() { return 'original-connect' }
  }
  const Module = { createRequire: () => ({ resolve: name => name === 'pg' ? pgEntry : pgClientEntry }),
    _load: () => Client, _resolveFilename: () => pgClientEntry }
  const server = { on() {}, listen(_path, ready) { ready() }, unref() {} }
  const dependencies = {
    'node:module': Module, 'node:http': { createServer: callback => { handler = callback; return server } },
    'node:fs': { chmodSync() {}, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }), realpathSync: value => value },
    'node:path': { resolve, sep: '/' }, './db-query-operations.cjs': operations,
    './db-query-unattributed-sources.cjs': sources,
  }
  const env = { MIKKA_DESKTOP_METRICS_SOCKET: '/tmp/mikka-bundled-123.sock',
    E2E_DATABASE_URL: 'postgresql://localhost/mikka_e2e', DATABASE_URL: 'postgresql://localhost/mikka_e2e',
    MIKKA_DATABASE_URL: 'postgresql://localhost/mikka_e2e', MIKKA_LOCAL_TEST_ACCOUNTS: '1' }
  const global = { [Symbol.for('mikka.requestRoute')]: route }
  runInNewContext(text, { require: name => { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name] },
    process: { env, cwd: () => root, pid: 123 }, URL, globalThis: global })
  Module._load(pgClientEntry)
  const client = new Client()
  for (const label of ['/api/rpc', '/api/agent/sessions', '/api/computer/events', '/api/conversations', '/api/pending-actions', 'CANARY_PRIVATE_SCOPE', undefined]) {
    route.run(label, () => assert.equal(client.query('CANARY_PRIVATE_SQL', ['CANARY_PRIVATE_PARAMETER']), 'original-result'))
  }
  let body
  handler({ url: '/metrics', method: 'GET' }, { writeHead() {}, end: value => { body = value } })
  assert.ok(!body.includes('CANARY_PRIVATE'))
  const result = JSON.parse(body)
  assert.equal(result.queryCalls, 7)
  assert.equal(result.queryOperations['/api/rpc'], 1)
  assert.equal(result.queryOperations.unattributed, 6)
  for (const key of ['/api/agent/sessions', '/api/computer/events', '/api/conversations', '/api/pending-actions', 'otherScoped', 'noScope']) assert.equal(result.unattributedSources[key], 1)
  assert.doesNotThrow(() => project(result))
})

test('a 60-request sparse report stays bounded without dropping unknown buckets or raw count conservation', () => {
  const before = project(snapshot()), next = snapshot()
  next.queryCalls = next.queryOperations.unattributed = next.unattributedSources.otherScoped = 1
  next.endedAt++
  const after = project(next)
  const rows = REQUEST_PLAN.map(id => ({ id, before: compactSnapshot(before), after: compactSnapshot(after), delta: profileDelta(before, after) }))
  assert.ok(Buffer.byteLength(JSON.stringify({ requests: rows, gaps: rows.map(row => row.delta) }, null, 2)) < 256 * 1024)
  assert.ok(rows.every(row => row.delta.queryCalls === row.delta.unattributedSources.otherScoped))
})
