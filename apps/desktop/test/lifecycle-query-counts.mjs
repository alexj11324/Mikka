// Read the existing isolated API process counter. No SQL, request bodies,
// credentials or user identifiers enter this closed numeric projection.
import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { dirname, resolve } from 'node:path'

const fields = ['pid', 'startedAt', 'endedAt', 'instrumentedClients', 'queryCalls',
  'pgProtocolReceiveBytes', 'pgProtocolSendBytes', 'activeConnections', 'closedConnections', 'unknownReadings']
const cumulative = ['queryCalls', 'pgProtocolReceiveBytes', 'pgProtocolSendBytes', 'closedConnections', 'unknownReadings']
const rpcWindowNames = ['nativeLogin', 'webLogin', 'startup-bundled', 'startup-hosted']
const rpcPhases = {
  nativeLogin: ['common-email-authentication', 'native-pkce-and-automatic-renderer-to-public-session', 'workspace-selection-to-usable'],
  webLogin: ['common-email-authentication', 'web-navigation-to-dom-content-loaded', 'workspace-selection-to-usable'],
  'startup-bundled': ['launch-to-usable'], 'startup-hosted': ['launch-to-usable'],
}
const maxLogBytes = 16 * 1024 * 1024
const rpcBoundary = {
  assignment: 'requests belong to the half-open window [startedAt, finishedAt) containing their api_request_started timestamp',
  counts: 'RPC invocations, not SQL calls; all primary API requests are included, without user attribution',
  overlap: 'completedInWindow includes carried-in requests; crossesStart/crossesEnd are confirmed by paired receipts and are not additive',
  statusCounts: 'observed completions of requests intersecting the window, including completions after its end',
  unknown: 'completionNotObserved means no completion in this one log snapshot, not proof the request is still running; without a start its window remains unknown',
  segments: 'closed measurement phases partition a completed window; starts belong to one phase, while completions and crossings remain separate non-additive observations',
}

function unavailableRpcActions(reason) {
  return { version: 1, status: 'incomplete', reasons: [reason], boundary: rpcBoundary,
    windows: Object.fromEntries(rpcWindowNames.map(name => [name, { status: 'unavailable' }])) }
}

function logTime(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ? Date.parse(value) : NaN
}

function actionsInInterval(records, from, to) {
  if (from === to) return []
  const actions = new Map()
  for (const { start, complete } of records) {
    if (start ? start.at >= to || (complete && complete.at < from) : complete.at < from || complete.at >= to) continue
    const route = (start ?? complete).route, rpcAction = complete?.rpcAction ?? null
    const key = route + ' ' + (rpcAction ?? '')
    const row = actions.get(key) ?? { route, rpcAction, startedInWindow: 0, completedInWindow: 0,
      crossesStart: 0, crossesEnd: 0, completionNotObserved: 0, completionWithoutStart: 0, statusCounts: new Map() }
    if (start && start.at >= from) row.startedInWindow++
    if (complete && complete.at >= from && complete.at < to) row.completedInWindow++
    if (start && complete && start.at < from) row.crossesStart++
    if (start && complete && complete.at >= to) row.crossesEnd++
    if (!complete) row.completionNotObserved++
    if (!start) row.completionWithoutStart++
    if (complete) row.statusCounts.set(complete.status, (row.statusCounts.get(complete.status) ?? 0) + 1)
    actions.set(key, row)
  }
  return [...actions.values()].map(row => ({ ...row, statusCounts: [...row.statusCounts].sort(([a], [b]) => a - b).map(([status, count]) => ({ status, count })) }))
    .sort((a, b) => a.route.localeCompare(b.route) || (a.rpcAction ?? '').localeCompare(b.rpcAction ?? ''))
}

// The server owns these two JSON-line shapes. Retain only closed request
// metadata; invocation IDs are used in RAM and never enter the report.
function projectRpcActions(text, windows) {
  const reasons = new Set(), requests = new Map()
  let duplicateRecords = 0, conflictingInvocations = 0
  for (const line of text.split('\n')) {
    let value
    try { value = JSON.parse(line) } catch {
      if (/"msg"\s*:\s*"api_request(?:_started)?"/.test(line)) reasons.add('invalid_request_record')
      continue
    }
    if (!['api_request_started', 'api_request'].includes(value?.msg)
      || !['/api/rpc', '/api/desktop/rpc'].includes(value.route)) continue
    const at = logTime(value.timestamp), complete = value.msg === 'api_request'
    if (value.method !== 'POST' || !Number.isFinite(at)
      || typeof value.invocationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.invocationId)
      || (complete && (!Number.isInteger(value.status) || value.status < 100 || value.status > 599))) {
      reasons.add('invalid_request_record')
      continue
    }
    const action = typeof value.rpcAction === 'string' && value.rpcAction.length <= 120
      && /^[a-z][\w-]*\.[a-z]\w*$/i.test(value.rpcAction) ? value.rpcAction : null
    if (complete && value.rpcAction !== undefined && action === null) reasons.add('invalid_request_record')
    const event = { at, route: value.route, ...(complete ? { status: value.status, rpcAction: action } : {}) }
    const record = requests.get(value.invocationId) ?? {}
    const key = complete ? 'complete' : 'start'
    if (record[key]) {
      if (JSON.stringify(record[key]) === JSON.stringify(event)) duplicateRecords++
      else record.conflict = true
    } else record[key] = event
    requests.set(value.invocationId, record)
  }
  if (!requests.size) return unavailableRpcActions('no_request_records')
  const records = []
  for (const record of requests.values()) {
    const { start, complete } = record
    if (record.conflict || (start && complete && (start.route !== complete.route || complete.at < start.at))) {
      conflictingInvocations++
      reasons.add('conflicting_records')
      continue
    }
    if (!start || !complete) reasons.add('unpaired_requests')
    records.push(record)
  }
  const recordsIncomplete = reasons.size > 0
  const measured = {}
  for (const name of rpcWindowNames) {
    const window = windows[name], from = logTime(window?.total?.startedAt), to = logTime(window?.total?.finishedAt)
    if (window?.status !== 'complete' || !Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      measured[name] = { status: 'unavailable' }
      reasons.add('query_window_incomplete')
      continue
    }
    const measuredWindow = measured[name] = { status: recordsIncomplete ? 'incomplete' : 'complete',
      startedAt: window.total.startedAt, finishedAt: window.total.finishedAt, actions: actionsInInterval(records, from, to) }
    if (window.segments !== undefined) {
      let boundary = from
      const valid = Array.isArray(window.segments) && window.segments.length === rpcPhases[name].length
        && window.segments.every((segment, index) => {
          const start = logTime(segment?.startedAt), end = logTime(segment?.finishedAt)
          if (segment?.phase !== rpcPhases[name][index] || start !== boundary || !Number.isFinite(end) || end < start || end > to) return false
          boundary = end
          return true
        }) && boundary === to
      if (valid) {
        measuredWindow.segmentStatus = recordsIncomplete ? 'incomplete' : 'complete'
        measuredWindow.segments = window.segments.map(segment => ({ phase: segment.phase,
          startedAt: segment.startedAt, finishedAt: segment.finishedAt,
          actions: actionsInInterval(records, logTime(segment.startedAt), logTime(segment.finishedAt)) }))
      } else {
        measuredWindow.segmentStatus = 'unavailable'
        reasons.add('query_segments_invalid')
      }
    }
  }
  return { version: 1, status: reasons.size ? 'incomplete' : 'complete', reasons: [...reasons],
    duplicateRecords, conflictingInvocations, boundary: rpcBoundary, windows: measured }
}

// One read after the existing samples and cleanup. Never upload the mixed
// stdout file, wait for a flush or query an API to obtain these diagnostics.
async function readRpcActions({ revision, runtimePath, backend }, windows) {
  const ownerPid = /^\/tmp\/mikka-bundled-([0-9]+)\.sock$/.exec(backend.socket)?.[1]
  const expected = resolve(dirname(runtimePath), 'bundled-' + revision.slice(0, 12) + '-' + ownerPid + '.log')
  if (!ownerPid || backend.log !== expected) return unavailableRpcActions('log_binding_mismatch')
  let file, result
  try {
    file = await open(expected, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await file.stat()
    if (!info.isFile() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) result = unavailableRpcActions('log_file_invalid')
    else if (info.size > maxLogBytes) result = unavailableRpcActions('log_size_limit')
    else {
      const bytes = Buffer.alloc(info.size)
      const read = await file.read(bytes, 0, bytes.length, 0)
      if (read.bytesRead !== info.size) result = unavailableRpcActions('log_read_incomplete')
      else if (bytes.length && bytes.at(-1) !== 10) result = unavailableRpcActions('log_partial_line')
      else result = projectRpcActions(bytes.toString('utf8'), windows)
    }
  } catch (error) {
    result = unavailableRpcActions(error.code === 'ENOENT' ? 'log_missing' : 'log_read_failed')
  } finally {
    try { await file?.close() } catch { result = unavailableRpcActions('log_close_failed') }
  }
  return result
}

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
    rpcActions: windows => readRpcActions({ revision, runtimePath, backend }, windows),
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
