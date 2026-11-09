// Test-process instrumentation, loaded with --require before the product entry.
// Counts actual pg calls and connection protocol bytes without logging SQL,
// parameters, returned data or credentials. Never imported by application code.
const Module = require('node:module')
const { createServer } = require('node:http')
const { chmodSync, lstatSync, realpathSync } = require('node:fs')
const { resolve, sep } = require('node:path')
const operations = require('./db-query-operations.cjs')
const knownOperations = new Set(operations)
const unattributedSourceKeys = require('./db-query-unattributed-sources.cjs')
const knownUnattributedSources = new Set(unattributedSourceKeys.filter(key => key !== 'otherScoped' && key !== 'noScope'))
const { createQueryDiagnostics } = require('./db-query-diagnostics.cjs')

const socketPath = process.env.MIKKA_DESKTOP_METRICS_SOCKET
const target = new URL(process.env.E2E_DATABASE_URL ?? 'invalid:')
if (!socketPath?.startsWith('/tmp/mikka-') || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || !target.pathname.endsWith('_e2e') || process.env.DATABASE_URL !== target.href || process.env.MIKKA_DATABASE_URL !== target.href
  || (process.env.MIKKA_LOCAL_TEST_ACCOUNTS !== '1' && process.env.GITHUB_ACTIONS !== 'true')) {
  throw new Error('DESKTOP_METRICS_REQUIRES_ISOLATED_TEST_PROCESS')
}

// productionApplication has already validated the compiled revision. Resolve
// from that application's cwd, not from this (possibly separate) harness tree.
// A traced Nitro dependency is a different Client from the installed source PG.
// Resolving does not load PG: the product must still initialize tracing first.
const root = realpathSync(process.cwd())
let runtime = 'next'
try {
  const manifest = lstatSync(resolve(root, '.output/mikka-build.json'))
  if (!manifest.isFile() || manifest.isSymbolicLink()) throw new Error('DESKTOP_METRICS_COMPILED_FILE_INVALID')
  runtime = 'nitro'
} catch (error) { if (error.code !== 'ENOENT') throw error }
const dependencyRoot = resolve(root, runtime === 'nitro' ? '.output/server/node_modules' : 'node_modules')
const entry = resolve(root, runtime === 'nitro' ? '.output/server/mikka-entry.mjs' : 'package.json')
const appRequire = Module.createRequire(entry)
const pgEntry = realpathSync(appRequire.resolve('pg'))
const pgClientEntry = realpathSync(appRequire.resolve('pg/lib/client.js'))
if (![pgEntry, pgClientEntry].every(path => path.startsWith(`${dependencyRoot}${sep}`))) throw new Error('DESKTOP_METRICS_PG_TARGET_MISMATCH')

const singleton = Symbol.for('mikka.desktop.db-metrics')
const previous = globalThis[singleton]
if (previous) {
  if (previous.pgEntry !== pgEntry || previous.socketPath !== socketPath) throw new Error('DESKTOP_METRICS_DUPLICATE_TARGET')
} else {
  globalThis[singleton] = { pgEntry, socketPath }
  startMetrics()
}

function startMetrics() {
  let queries = 0
  const queryOperations = Object.fromEntries(operations.map(operation => [operation, 0]))
  const unattributedSources = Object.fromEntries(unattributedSourceKeys.map(source => [source, 0]))
  let receiveBytes = 0
  let sendBytes = 0
  let closedConnections = 0
  let unknownReadings = 0
  let startedAt = Date.now()
  const streams = new Map()
  const clients = new WeakSet()
  let instrumentedClients = 0
  const diagnostics = createQueryDiagnostics({ globals: globalThis })
  const read = (stream, key) => {
    const value = stream[key]
    if (!Number.isSafeInteger(value) || value < 0) { unknownReadings++; return 0 }
    return value
  }
  const instrument = Client => {
    if (typeof Client !== 'function' || typeof Client.prototype.query !== 'function' || typeof Client.prototype.connect !== 'function') {
      throw new Error('DESKTOP_METRICS_PG_EXPORT_INVALID')
    }
    if (clients.has(Client)) return
    clients.add(Client)
    instrumentedClients++
    const originalQuery = Client.prototype.query
    Client.prototype.query = function (...args) {
      queries++
      // This existing AsyncLocalStorage is populated by the product's request
      // and database-operation wrappers. Count at the same invocation as the
      // total, without importing application code or recording arbitrary labels.
      let operation
      try { operation = globalThis[Symbol.for('mikka.requestRoute')]?.getStore() } catch { /* keep unattributed calls */ }
      const bucket = knownOperations.has(operation) ? operation : 'unattributed'
      queryOperations[bucket]++
      if (bucket === 'unattributed') {
        const source = operation == null ? 'noScope' : knownUnattributedSources.has(operation) ? operation : 'otherScoped'
        unattributedSources[source]++
      }
      diagnostics.record(queries, args[0], operation)
      return originalQuery.apply(this, args)
    }
    const originalConnect = Client.prototype.connect
    Client.prototype.connect = function (...args) {
      this.once('connect', () => {
        const stream = this.connection?.stream
        if (!stream) { unknownReadings++; return }
        if (streams.has(stream)) return
        const entry = { received: read(stream, 'bytesRead'), sent: read(stream, 'bytesWritten') }
        streams.set(stream, entry)
        stream.once('close', () => {
          receiveBytes += Math.max(0, read(stream, 'bytesRead') - entry.received)
          sendBytes += Math.max(0, read(stream, 'bytesWritten') - entry.sent)
          closedConnections++
          streams.delete(stream)
        })
      })
      return originalConnect.apply(this, args)
    }
  }
  // Observe only the selected package's normal CJS loads. PG's ESM entry uses
  // this same Client. Wrap its file export before OTel's outer onrequire hook;
  // wrapping the already instrumented index export would hide OTel's marker and
  // a later root import could duplicate its span wrapper. Never require PG early
  // or replace the export. Repeated imports/preloads keep one metrics wrapper.
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    const exports = originalLoad.apply(this, arguments)
    if (request === pgClientEntry || request === 'pg/lib/client.js' || request === './client' && parent?.filename === pgEntry) {
      if (Module._resolveFilename(request, parent, isMain) === pgClientEntry) instrument(exports)
    } else if ((request === 'pg' || request === pgEntry)
      && Module._resolveFilename(request, parent, isMain) === pgEntry && !clients.has(exports.Client)) {
      // A driver loaded before this preload may already have live connections.
      // Do not silently count a partial history or wrap an existing OTel wrapper.
      throw new Error('DESKTOP_METRICS_PG_CLIENT_LOAD_UNOBSERVED')
    }
    return exports
  }

  function snapshot() {
    let received = receiveBytes
    let sent = sendBytes
    for (const [stream, entry] of streams) {
      received += Math.max(0, read(stream, 'bytesRead') - entry.received)
      sent += Math.max(0, read(stream, 'bytesWritten') - entry.sent)
    }
    return {
      version: 1, pid: process.pid, startedAt, endedAt: Date.now(),
      runtime, instrumentedClients,
      queryCalls: queries, pgProtocolReceiveBytes: received, pgProtocolSendBytes: sent,
      queryOperations: { ...queryOperations },
      unattributedSources: { ...unattributedSources },
      activeConnections: streams.size, closedConnections, unknownReadings,
      measurement: 'all_pg_client_calls_and_connection_protocol_bytes',
      excludes: ['connection_handshake', 'TCP_TLS_overhead', 'other_processes'],
    }
  }

  const server = createServer((request, response) => {
    if (request.url === '/reset' && request.method === 'POST') {
      queries = 0; receiveBytes = 0; sendBytes = 0; closedConnections = 0; unknownReadings = 0
      for (const operation of operations) queryOperations[operation] = 0
      for (const source of unattributedSourceKeys) unattributedSources[source] = 0
      for (const [stream, entry] of streams) {
        entry.received = read(stream, 'bytesRead'); entry.sent = read(stream, 'bytesWritten')
      }
      startedAt = Date.now()
      diagnostics.reset()
    } else if (request.url === '/diagnostics' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(diagnostics.finish({ pid: process.pid, runtime, startedAt }, queries)))
      return
    } else if (request.url !== '/metrics' || request.method !== 'GET') {
      response.writeHead(404).end(); return
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    diagnostics.checkpoint(queries)
    response.end(JSON.stringify(snapshot()))
  })
  server.on('error', () => { throw new Error('DESKTOP_METRICS_CONTROL_UNAVAILABLE') })
  server.listen(socketPath, () => chmodSync(socketPath, 0o600))
  server.unref()
}
