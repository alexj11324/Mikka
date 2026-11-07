// Read the existing isolated API process counter. No SQL, request bodies,
// credentials or user identifiers enter this closed numeric projection.
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'

const fields = ['pid', 'startedAt', 'endedAt', 'instrumentedClients', 'queryCalls',
  'pgProtocolReceiveBytes', 'pgProtocolSendBytes', 'activeConnections', 'closedConnections', 'unknownReadings']
const cumulative = ['queryCalls', 'pgProtocolReceiveBytes', 'pgProtocolSendBytes', 'closedConnections', 'unknownReadings']

export function projectQuerySnapshot(value, expected) {
  if (!value || value.version !== 1 || value.pid !== expected.pid || value.runtime !== expected.runtime
    || value.measurement !== 'all_pg_client_calls_and_connection_protocol_bytes'
    || fields.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.instrumentedClients < 1 || value.endedAt < value.startedAt) {
    throw new Error('LIFECYCLE_QUERY_COUNTER_SNAPSHOT_INVALID')
  }
  return { version: 1, runtime: value.runtime, ...Object.fromEntries(fields.map(key => [key, value[key]])) }
}

export function queryCountDelta(before, after) {
  if (after.pid !== before.pid || after.runtime !== before.runtime || after.startedAt !== before.startedAt
    || after.endedAt < before.endedAt || cumulative.some(key => after[key] < before[key])) {
    throw new Error('LIFECYCLE_QUERY_COUNTER_CHANGED')
  }
  if (before.unknownReadings !== 0 || after.unknownReadings !== 0) throw new Error('LIFECYCLE_QUERY_COUNTER_UNKNOWN')
  return {
    startedAt: new Date(before.endedAt).toISOString(), finishedAt: new Date(after.endedAt).toISOString(),
    durationMs: after.endedAt - before.endedAt,
    queryCalls: after.queryCalls - before.queryCalls,
    pgProtocolReceiveBytes: after.pgProtocolReceiveBytes - before.pgProtocolReceiveBytes,
    pgProtocolSendBytes: after.pgProtocolSendBytes - before.pgProtocolSendBytes,
    closedConnections: after.closedConnections - before.closedConnections, unknownReadings: 0,
  }
}

export async function createLifecycleQueryCounter({ revision, origin, runtimePath = '.cache/desktop-runtime/processes.json' },
  { read = readFile, httpRequest = request } = {}) {
  let descriptor
  try {
    const text = await read(runtimePath, 'utf8')
    if (Buffer.byteLength(text) > 8192) throw new Error('LIFECYCLE_QUERY_COUNTER_DESCRIPTOR_TOO_LARGE')
    descriptor = JSON.parse(text)
  } catch (error) { throw new Error('LIFECYCLE_QUERY_COUNTER_DESCRIPTOR_INVALID', { cause: error }) }
  const backend = descriptor?.bundled
  const target = new URL(origin)
  if (!/^[0-9a-f]{40}$/.test(revision) || descriptor.revision !== revision || descriptor.origin !== origin
    || target.hostname !== 'localhost' || target.protocol !== 'http:' || target.origin !== origin
    || backend?.port !== Number(target.port || 80) || !Number.isSafeInteger(backend?.pid) || backend.pid <= 0
    || !['next', 'nitro'].includes(backend.runtime) || !/^\/tmp\/mikka-bundled-[0-9]+\.sock$/.test(backend.socket)) {
    throw new Error('LIFECYCLE_QUERY_COUNTER_RUNTIME_MISMATCH')
  }
  return {
    source: { revision, platform: process.platform, arch: process.arch, runtime: backend.runtime, pid: backend.pid,
      process: 'primary API shared by lifecycle bundled, hosted and Chromium' },
    snapshot: () => new Promise((resolve, reject) => {
      const failed = error => reject(new Error('LIFECYCLE_QUERY_COUNTER_READ_FAILED', { cause: error }))
      const req = httpRequest({ socketPath: backend.socket, path: '/metrics', method: 'GET', signal: AbortSignal.timeout(5000) }, response => {
        if (response.statusCode !== 200) {
          response.resume()
          failed(new Error('LIFECYCLE_QUERY_COUNTER_HTTP_STATUS'))
          return
        }
        const chunks = []
        let bytes = 0
        response.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 8192) req.destroy(new Error('LIFECYCLE_QUERY_COUNTER_BODY_TOO_LARGE'))
          else chunks.push(chunk)
        })
        response.once('error', failed)
        response.once('aborted', () => failed(new Error('LIFECYCLE_QUERY_COUNTER_BODY_ABORTED')))
        response.once('end', () => {
          try { resolve(projectQuerySnapshot(JSON.parse(Buffer.concat(chunks).toString('utf8')), backend)) }
          catch (error) { failed(error) }
        })
      })
      req.once('error', failed)
      req.end()
    }),
  }
}
