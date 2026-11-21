#!/usr/bin/env node
// Read one real recording segment; persist only a bounded, allowlisted receipt.
// The caller must separately match the session and time window to the APM trace.
// No raw snapshots, person fields, URLs, blob keys, or event.data leave memory.
//
// node scripts/ops/posthog-replay-evidence.mjs --session-id <uuid> --trace-id <hex>
// POSTHOG_PERSONAL_API_KEY is supplied inside the existing export runner only.
// Required existing scope: session_recording:read. No retry or scope expansion.
// Official format: https://posthog.com/docs/session-replay/snapshot-api

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EvidenceError as ReplayEvidenceError, publicEvidenceError, readEvidenceBody } from './posthog-evidence-response.mjs'
import { POSTHOG_ORIGIN, PROJECT_ID, REPORT_DIRECTORY } from './posthog-export-evidence.mjs'

const JSON_LIMIT = 1024 * 1024
const SNAPSHOT_LIMIT = 8 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 15000
const TOTAL_TIMEOUT_MS = 45000
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TRACE_ID = /^[0-9a-f]{32}$/
const HELP = `Usage: node scripts/ops/posthog-replay-evidence.mjs --session-id UUID --trace-id HEX
Environment: POSTHOG_PERSONAL_API_KEY (existing personal phx_ key; session_recording:read).
Fixed target: PostHog US project 670821. Three GET requests, one snapshot source, no retries.
Limits: 15 seconds/request, 45 seconds total, JSON 1 MiB, snapshot 8 MiB.
Output: production-run-observability-report/posthog-replay-<session-id>.receipt.json.
This proves one recording segment was read, not trace correlation or successful playback.
`

function validateOptions({ sessionId, traceId, timeoutMs = TOTAL_TIMEOUT_MS }) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || /^0+$/.test(sessionId.replaceAll('-', ''))
    || typeof traceId !== 'string' || !TRACE_ID.test(traceId) || /^0+$/.test(traceId)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > TOTAL_TIMEOUT_MS)
    throw new ReplayEvidenceError('invalid_arguments')
  return { sessionId, traceId, timeoutMs }
}

export function optionalReplayOptions(sessionId = '', traceId = '') {
  if (sessionId === '' && traceId === '') return null
  return validateOptions({ sessionId, traceId })
}

export function parseReplayArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true }
  const values = new Map()
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1]
    if (!['--session-id', '--trace-id'].includes(flag) || values.has(flag) || value === undefined)
      throw new ReplayEvidenceError('invalid_arguments')
    values.set(flag, value)
  }
  return validateOptions({ sessionId: values.get('--session-id'), traceId: values.get('--trace-id') })
}

function timestamp(value, phase) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new ReplayEvidenceError('invalid_timestamp', { phase })
  return Date.parse(value)
}

function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function safeMetadata(value, sessionId) {
  const phase = 'metadata'
  if (value?.found === false) throw new ReplayEvidenceError('recording_not_found', { phase })
  if (!value || value.id !== sessionId) throw new ReplayEvidenceError('recording_id_mismatch', { phase })
  const start = timestamp(value.start_time, phase)
  const end = value.end_time == null ? null : timestamp(value.end_time, phase)
  if (end !== null && end < start) throw new ReplayEvidenceError('invalid_recording_window', { phase })
  return {
    start_time: new Date(start).toISOString(), end_time: end === null ? null : new Date(end).toISOString(),
    duration_seconds: nonnegative(value.recording_duration),
    event_count: nonnegative(value.event_count), total_size: nonnegative(value.total_size),
    ongoing: typeof value.ongoing === 'boolean' ? value.ongoing : null,
  }
}

function latestSource(value, metadata) {
  const phase = 'sources'
  if (!Array.isArray(value?.sources) || value.sources.length === 0)
    throw new ReplayEvidenceError('no_snapshot_sources', { phase })
  const sources = value.sources.map(source => {
    if (source?.source !== 'blob_v2' || typeof source.blob_key !== 'string'
      || !/^(?:0|[1-9]\d{0,15})$/.test(source.blob_key) || !Number.isSafeInteger(Number(source.blob_key)))
      throw new ReplayEvidenceError('invalid_snapshot_source', { phase })
    const start = timestamp(source.start_timestamp, phase), end = timestamp(source.end_timestamp, phase)
    if (end < start) throw new ReplayEvidenceError('invalid_source_window', { phase })
    return { key: source.blob_key, start, end }
  }).sort((a, b) => b.end - a.end || b.start - a.start || Number(b.key) - Number(a.key))
  const source = sources[0]
  if (source.end < Date.parse(metadata.start_time)
    || (metadata.end_time !== null && source.start > Date.parse(metadata.end_time)))
    throw new ReplayEvidenceError('source_outside_recording', { phase })
  return source
}

function snapshotSummary(bytes, source) {
  const phase = 'snapshot'
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch (cause) { throw new ReplayEvidenceError('invalid_snapshot_encoding', { phase, cause }) }
  let count = 0, first = Infinity, last = -Infinity, inWindow = 0
  const types = {}, windows = new Set()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let row
    try { row = JSON.parse(line) }
    catch (cause) { throw new ReplayEvidenceError('invalid_snapshot_jsonl', { phase, cause }) }
    const event = row?.[1]
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || !row[0].length
      || !event || typeof event !== 'object' || Array.isArray(event)
      || !Number.isInteger(event.type) || event.type < 0 || event.type > 6
      || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > 8640000000000000)
      throw new ReplayEvidenceError('invalid_snapshot_event', { phase })
    count++
    types[event.type] = (types[event.type] ?? 0) + 1
    windows.add(row[0])
    first = Math.min(first, event.timestamp); last = Math.max(last, event.timestamp)
    if (event.timestamp >= source.start && event.timestamp <= source.end) inWindow++
    // Never traverse, copy, persist, log or render event.data.
  }
  if (!count) throw new ReplayEvidenceError('empty_snapshot', { phase })
  if (!inWindow) throw new ReplayEvidenceError('snapshot_outside_source_window', { phase })
  return {
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    event_count: count, event_type_counts: types, window_count: windows.size,
    first_event_at: new Date(first).toISOString(), last_event_at: new Date(last).toISOString(),
    events_in_source_window: inWindow,
  }
}

async function atomicReceipt(path, data) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

export async function replayEvidence(options, {
  key = process.env.POSTHOG_PERSONAL_API_KEY, fetchImpl = globalThis.fetch, cwd = process.cwd(), now = Date.now,
} = {}) {
  const target = validateOptions(options)
  if (!key) throw new ReplayEvidenceError('missing_personal_api_key')
  if (typeof key !== 'string' || !/^phx_[A-Za-z0-9_-]+$/.test(key))
    throw new ReplayEvidenceError('invalid_personal_api_key')
  const started = now(), deadline = started + target.timeoutMs
  const directory = join(cwd, REPORT_DIRECTORY)
  const receiptPath = join(directory, `posthog-replay-${target.sessionId}.receipt.json`)
  const metadataUrl = `${POSTHOG_ORIGIN}/api/projects/${PROJECT_ID}/session_recordings/${target.sessionId}/`
  const snapshotsUrl = `${POSTHOG_ORIGIN}/api/environments/${PROJECT_ID}/session_recordings/${target.sessionId}/snapshots`
  let requestCount = 0
  const remaining = phase => {
    const ms = deadline - now()
    if (ms <= 0) throw new ReplayEvidenceError('deadline_exceeded', { phase })
    return ms
  }
  const baseReceipt = () => ({
    schema_version: 1, project_id: PROJECT_ID, region: 'US',
    session_id: target.sessionId, trace_id_hex: target.traceId,
    proof_scope: 'one_recording_segment', trace_correlation: 'requires_apm_match', playback_verified: false,
    started_at: new Date(started).toISOString(), finished_at: new Date(now()).toISOString(),
    elapsed_ms: Math.max(0, now() - started), request_count: requestCount,
  })
  async function request(phase, url) {
    const budget = remaining(phase), controller = new AbortController()
    let timer
    try {
      return await Promise.race([
        (async () => {
          requestCount++
          const response = await fetchImpl(url, {
            method: 'GET', headers: { Authorization: `Bearer ${key}`, Accept: phase === 'snapshot' ? 'application/x-ndjson' : 'application/json' },
            redirect: 'manual', signal: controller.signal,
          })
          if (response.status >= 300 && response.status < 400)
            throw new ReplayEvidenceError('redirect_not_allowed', { phase, httpStatus: response.status })
          if (!response.ok) throw new ReplayEvidenceError('http_error', { phase, httpStatus: response.status })
          const bytes = await readEvidenceBody(response, phase === 'snapshot' ? SNAPSHOT_LIMIT : JSON_LIMIT, phase)
          if (phase === 'snapshot') return bytes
          try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
          catch (cause) { throw new ReplayEvidenceError('invalid_json', { phase, cause }) }
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(new ReplayEvidenceError(budget <= REQUEST_TIMEOUT_MS ? 'deadline_exceeded' : 'request_timeout', { phase }))
          }, Math.min(REQUEST_TIMEOUT_MS, budget))
        }),
      ])
    } catch (cause) {
      if (cause instanceof ReplayEvidenceError) throw cause
      throw new ReplayEvidenceError('request_failed', { phase, cause })
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const recording = safeMetadata(await request('metadata', metadataUrl), target.sessionId)
    const source = latestSource(await request('sources', `${snapshotsUrl}?blob_v2=true`), recording)
    const query = new URLSearchParams({ source: 'blob_v2', blob_key: source.key, decompress: 'true' })
    const snapshot = snapshotSummary(await request('snapshot', `${snapshotsUrl}?${query}`), source)
    remaining('write')
    const receipt = { ...baseReceipt(), status: 'complete', recording,
      source: { type: 'blob_v2', start_time: new Date(source.start).toISOString(), end_time: new Date(source.end).toISOString() }, snapshot }
    await atomicReceipt(receiptPath, receipt)
    return receipt
  } catch (cause) {
    const error = cause instanceof ReplayEvidenceError ? cause : new ReplayEvidenceError('write_failed', { phase: 'write', cause })
    try { await atomicReceipt(receiptPath, { ...baseReceipt(), status: 'failed', error: publicEvidenceError(error) }) }
    catch (writeCause) { throw new ReplayEvidenceError('receipt_write_failed', { phase: 'write', cause: writeCause }) }
    throw error
  }
}

export async function main(args = process.argv.slice(2), { env = process.env, stdout = process.stdout, stderr = process.stderr, ...dependencies } = {}) {
  try {
    const options = parseReplayArguments(args)
    if (options.help) { stdout.write(HELP); return 0 }
    const receipt = await replayEvidence(options, { ...dependencies, key: env.POSTHOG_PERSONAL_API_KEY })
    stdout.write(`${JSON.stringify(receipt)}\n`)
    return 0
  } catch (error) {
    stderr.write(`${JSON.stringify({ status: 'failed', error: publicEvidenceError(error) })}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main()
