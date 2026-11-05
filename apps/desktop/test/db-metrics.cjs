// Test-process instrumentation, loaded with --require before `next start`.
// Counts actual pg calls and connection protocol bytes without logging SQL,
// parameters, returned data or credentials. Never imported by application code.
const { Client } = require('pg')
const { createServer } = require('node:http')
const { chmodSync } = require('node:fs')

const socketPath = process.env.MIKKA_DESKTOP_METRICS_SOCKET
const target = new URL(process.env.E2E_DATABASE_URL ?? 'invalid:')
if (!socketPath?.startsWith('/tmp/mikka-') || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
  || !target.pathname.endsWith('_e2e') || process.env.DATABASE_URL !== target.href || process.env.MIKKA_DATABASE_URL !== target.href
  || (process.env.MIKKA_LOCAL_TEST_ACCOUNTS !== '1' && process.env.GITHUB_ACTIONS !== 'true')) {
  throw new Error('DESKTOP_METRICS_REQUIRES_ISOLATED_TEST_PROCESS')
}

let queries = 0
let receiveBytes = 0
let sendBytes = 0
let closedConnections = 0
let unknownReadings = 0
let startedAt = Date.now()
const streams = new Map()
const originalQuery = Client.prototype.query
Client.prototype.query = function (...args) {
  queries++
  return originalQuery.apply(this, args)
}
const read = (stream, key) => {
  const value = stream[key]
  if (!Number.isSafeInteger(value) || value < 0) { unknownReadings++; return 0 }
  return value
}
const originalConnect = Client.prototype.connect
Client.prototype.connect = function (...args) {
  this.once('connect', () => {
    const stream = this.connection?.stream
    if (!stream) { unknownReadings++; return }
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

function snapshot() {
  let received = receiveBytes
  let sent = sendBytes
  for (const [stream, entry] of streams) {
    received += Math.max(0, read(stream, 'bytesRead') - entry.received)
    sent += Math.max(0, read(stream, 'bytesWritten') - entry.sent)
  }
  return {
    version: 1, pid: process.pid, startedAt, endedAt: Date.now(),
    queryCalls: queries, pgProtocolReceiveBytes: received, pgProtocolSendBytes: sent,
    activeConnections: streams.size, closedConnections, unknownReadings,
    measurement: 'all_pg_client_calls_and_connection_protocol_bytes',
    excludes: ['connection_handshake', 'TCP_TLS_overhead', 'other_processes'],
  }
}

const server = createServer((request, response) => {
  if (request.url === '/reset' && request.method === 'POST') {
    queries = 0; receiveBytes = 0; sendBytes = 0; closedConnections = 0; unknownReadings = 0
    for (const [stream, entry] of streams) {
      entry.received = read(stream, 'bytesRead'); entry.sent = read(stream, 'bytesWritten')
    }
    startedAt = Date.now()
  } else if (request.url !== '/metrics' || request.method !== 'GET') {
    response.writeHead(404).end(); return
  }
  response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(snapshot()))
})
server.on('error', () => { throw new Error('DESKTOP_METRICS_CONTROL_UNAVAILABLE') })
server.listen(socketPath, () => chmodSync(socketPath, 0o600))
server.unref()
