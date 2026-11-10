// Temporary issue1512 fixture diagnostics. No launchctl wrapper or probes.
import { open } from 'node:fs/promises'
const PREFIX = 'MIKKA_LAUNCHCTL_DIAGNOSTIC '
const ERRORS = new Set(['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ENOBUFS', 'OTHER'])
const SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGABRT', 'SIGFPE', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGUSR1', 'SIGUSR2', 'OTHER'])
const EVENT_KEYS = ['startedAt', 'finishedAt', 'elapsedMs', 'complete', 'failed', 'exitCode', 'errorCode', 'signal'].sort()
const RECORD_KEYS = ['schema', 'bootout', 'bootstrap', 'betweenCommandsMs'].sort()
const iso = value => value === null || typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
const duration = value => value === null || Number.isFinite(value) && value >= 0
function validEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(EVENT_KEYS)) return false
  if (!iso(value.startedAt) || !iso(value.finishedAt) || !duration(value.elapsedMs) || typeof value.complete !== 'boolean') return false
  if (!(value.failed === null || typeof value.failed === 'boolean')) return false
  if (!(value.exitCode === null || Number.isInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255)) return false
  if (!(value.errorCode === null || ERRORS.has(value.errorCode)) || !(value.signal === null || SIGNALS.has(value.signal))) return false
  return value.complete
    ? value.startedAt !== null && value.finishedAt !== null && value.elapsedMs !== null && value.failed !== null &&
      (value.failed || value.exitCode === 0 && value.errorCode === null && value.signal === null)
    : value.failed === null && value.exitCode === null
}
function validRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify(RECORD_KEYS) &&
    value.schema === 'issue1512.launchctl-inprocess.v1' && validEvent(value.bootout) &&
    validEvent(value.bootstrap) && duration(value.betweenCommandsMs)
}
export function createLaunchctlInprocessDiagnostic() {
  let phase = 'install', attempts = 0, missing = 0, invalid = 0, oversized = 0
  const records = []
  return {
    reconnect: () => { phase = 'reconnect' },
    capture: stdout => {
      // Called only after the original service-install process completed or failed.
      // Never throw or change the command result because diagnostic bytes are missing.
      attempts++
      try {
        if (typeof stdout !== 'string') { missing++; return }
        if (Buffer.byteLength(stdout) > 16384) { oversized++; return }
        const lines = stdout.split('\n').filter(line => line.startsWith(PREFIX))
        if (lines.length !== 1 || records.length >= 2) { if (lines.length === 0) missing++; else invalid++; return }
        const value = JSON.parse(lines[0].slice(PREFIX.length))
        if (!validRecord(value)) { invalid++; return }
        records.push({ phase, ...value })
      } catch { invalid++ }
    },
    snapshot: () => ({ status: attempts > 0 && attempts === records.length && !missing && !invalid && !oversized ? 'captured' : 'partial',
      attempts, records: records.map(value => ({ ...value, bootout: { ...value.bootout }, bootstrap: { ...value.bootstrap } })),
      missing, invalid, oversized, maxRecords: 2, maxCommandOutputBytes: 16384,
      boundary: 'Only completed command output. Synchronous timestamp recording still changes timing; non-reproduction is not a product fix.' }),
  }
}
export async function readDaemonLifecycle(path) {
  // One bounded file read after the original fixture assertions or failure.
  // Preserve only fixed lifecycle event names, time and an ordinal generation.
  const kinds = new Map([['daemon started', 'started'], ['device registered', 'registered'], ['daemon stopped', 'stopped']])
  let file
  try {
    file = await open(path, 'r')
    const buffer = Buffer.alloc(65537)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead === buffer.length) return { status: 'oversized', limitBytes: 65536, events: [] }
    const generations = new Map(), events = []
    let malformedLines = 0
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n').filter(Boolean)) {
      let value
      try { value = JSON.parse(line) } catch { malformedLines++; continue }
      if (!kinds.has(value?.msg)) continue
      if (!Number.isInteger(value.pid) || value.pid <= 0 || !Number.isInteger(value.time) || value.time < 0 || value.time > 8640000000000000) { malformedLines++; continue }
      if (!generations.has(value.pid)) generations.set(value.pid, generations.size + 1)
      if (events.length >= 16) return { status: 'truncated', limitEvents: 16, events, malformedLines }
      events.push({ event: kinds.get(value.msg), at: new Date(value.time).toISOString(), generation: generations.get(value.pid) })
    }
    return { status: 'captured', events, malformedLines,
      boundary: 'Point-in-time log read only; a missing line is not proof that an event did not happen.' }
  } catch { return { status: 'unavailable', events: [] } }
  finally { await file?.close().catch(() => undefined) }
}
