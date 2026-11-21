import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { REPORT_DIRECTORY } from './posthog-export-evidence.mjs'
import { main, optionalReplayOptions, parseReplayArguments, replayEvidence } from './posthog-replay-evidence.mjs'

const key = 'phx_offline_replay_fixture'
const sessionId = '019a5a18-8500-7000-8000-000000000001'
const traceId = '1234567890abcdef1234567890abcdef'
const target = { sessionId, traceId }
const start = Date.parse('2026-11-06T12:00:00.000Z')
const iso = seconds => new Date(start + seconds * 1000).toISOString()
const metadata = (patch = {}) => ({ id: sessionId, start_time: iso(0), end_time: iso(20),
  recording_duration: 20, event_count: 50, total_size: 4096, ongoing: false,
  person: { name: 'PRIVATE_PERSON', distinct_ids: ['PRIVATE_DISTINCT_ID'] }, start_url: `https://private.test/?key=${key}`, ...patch })
const source = (patch = {}) => ({ source: 'blob_v2', blob_key: '1', start_timestamp: iso(10), end_timestamp: iso(20), ...patch })
const payload = Buffer.from([
  ['PRIVATE_WINDOW_ID', { type: 4, timestamp: start + 10000, data: { href: 'PRIVATE_URL' } }],
  ['PRIVATE_WINDOW_ID', { type: 2, timestamp: start + 11000, data: { node: 'PRIVATE_DOM_AND_INPUT' } }],
  ['PRIVATE_WINDOW_ID', { type: 3, timestamp: start + 15000, data: { input: key, text: 'PRIVATE_USER_TEXT' } }],
].map(value => JSON.stringify(value)).join('\n') + '\n')
const json = value => Response.json(value)
const segment = bytes => new Response(bytes ?? payload, { headers: { 'Content-Type': 'application/x-ndjson' } })
const responses = () => [json(metadata()), json({ sources: [source()] }), segment()]

async function temporaryDirectory(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'mikka-posthog-replay-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  return cwd
}

async function receipt(cwd) {
  return JSON.parse(await readFile(join(cwd, REPORT_DIRECTORY, `posthog-replay-${sessionId}.receipt.json`), 'utf8'))
}

function recordingFetch(queue) {
  const requests = []
  return { requests, fetchImpl: async (url, options) => {
    requests.push({ url, options })
    assert.equal(new URL(url).origin, 'https://us.posthog.com')
    assert.ok(new URL(url).pathname.includes(`/670821/session_recordings/${sessionId}/`))
    assert.equal(options.method, 'GET'); assert.equal(options.body, undefined)
    assert.equal(options.headers.Authorization, `Bearer ${key}`)
    assert.equal(options.redirect, 'manual')
    assert.ok(options.signal instanceof AbortSignal)
    assert.ok(queue.length, 'unexpected request or retry')
    return queue.shift()
  } }
}

test('requires both exact IDs, keeps the workflow option off when absent, and rejects extra capabilities', () => {
  assert.equal(optionalReplayOptions(), null)
  assert.equal(optionalReplayOptions('', ''), null)
  assert.deepEqual(optionalReplayOptions(sessionId, traceId), { ...target, timeoutMs: 45000 })
  assert.deepEqual(parseReplayArguments(['--trace-id', traceId, '--session-id', sessionId]), { ...target, timeoutMs: 45000 })
  assert.deepEqual(parseReplayArguments(['--help']), { help: true })
  for (const pair of [[sessionId, ''], ['', traceId], [sessionId, '0'.repeat(32)], [sessionId, traceId.toUpperCase()],
    ['00000000-0000-0000-0000-000000000000', traceId], ['../PRIVATE_PATH', traceId], [sessionId + '?token=x', traceId]])
    assert.throws(() => optionalReplayOptions(...pair), error => error.code === 'invalid_arguments')
  for (const args of [[], ['--session-id', sessionId], ['--trace-id', traceId], ['--session-id', sessionId, '--trace-id', traceId, '--host', 'https://foreign.test'],
    ['--session-id', sessionId, '--trace-id', traceId, '--session-id', sessionId], ['--session-id', sessionId, '--trace-id', traceId, '--timeout-ms', '60000']])
    assert.throws(() => parseReplayArguments(args), error => error.code === 'invalid_arguments')
})

test('reads metadata and exactly one newest source, saves safe counts/hash only, and does not attest to trace correlation', async t => {
  const cwd = await temporaryDirectory(t)
  const fake = recordingFetch([json(metadata()), json({ sources: [source(), source({ blob_key: '0', start_timestamp: iso(0), end_timestamp: iso(9) })] }), segment()])
  const result = await replayEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl })
  assert.equal(result.status, 'complete'); assert.equal(result.request_count, 3)
  assert.equal(result.session_id, sessionId); assert.equal(result.trace_id_hex, traceId)
  assert.equal(result.trace_correlation, 'requires_apm_match'); assert.equal(result.playback_verified, false)
  assert.equal(fake.requests[0].url, `https://us.posthog.com/api/projects/670821/session_recordings/${sessionId}/`)
  assert.equal(fake.requests[1].url, `https://us.posthog.com/api/environments/670821/session_recordings/${sessionId}/snapshots?blob_v2=true`)
  assert.equal(fake.requests[2].url, `https://us.posthog.com/api/environments/670821/session_recordings/${sessionId}/snapshots?source=blob_v2&blob_key=1&decompress=true`)
  assert.deepEqual(result.source, { type: 'blob_v2', start_time: iso(10), end_time: iso(20) })
  assert.deepEqual(result.snapshot, { bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex'),
    event_count: 3, event_type_counts: { 2: 1, 3: 1, 4: 1 }, window_count: 1,
    first_event_at: iso(10), last_event_at: iso(15), events_in_source_window: 3 })
  assert.deepEqual(await receipt(cwd), result)
  assert.deepEqual(await readdir(join(cwd, REPORT_DIRECTORY)), [`posthog-replay-${sessionId}.receipt.json`])
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|phx_|private\.test|blob_key|person|distinct|start_url|event\.data/)
})

test('missing, mismatched or malformed recording metadata stops before source access', async t => {
  for (const [body, expected] of [[{ found: false, reason: 'PRIVATE_REASON' }, 'recording_not_found'],
    [metadata({ id: 'wrong-session' }), 'recording_id_mismatch'], [metadata({ start_time: 'PRIVATE_TIMESTAMP' }), 'invalid_timestamp'],
    [metadata({ end_time: iso(-1) }), 'invalid_recording_window']]) {
    const cwd = await temporaryDirectory(t), fake = recordingFetch([json(body)])
    await assert.rejects(replayEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === expected)
    assert.equal(fake.requests.length, 1)
    const saved = await receipt(cwd)
    assert.equal(saved.status, 'failed'); assert.equal(saved.recording, undefined)
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_|phx_|wrong-session/)
  }
})

test('sources must be supported, numeric and inside the recording; no guessed URLs or alternative-source retries', async t => {
  for (const [body, expected] of [[{ sources: [] }, 'no_snapshot_sources'], [{}, 'no_snapshot_sources'],
    [{ sources: [source({ source: 'realtime' })] }, 'invalid_snapshot_source'],
    [{ sources: [source({ blob_key: 'https://foreign.test/?token=PRIVATE' })] }, 'invalid_snapshot_source'],
    [{ sources: [source({ blob_key: '../1' })] }, 'invalid_snapshot_source'],
    [{ sources: [source({ end_timestamp: iso(9) })] }, 'invalid_source_window'],
    [{ sources: [source({ start_timestamp: iso(21), end_timestamp: iso(22) })] }, 'source_outside_recording']]) {
    const cwd = await temporaryDirectory(t), fake = recordingFetch([json(metadata()), json(body)])
    await assert.rejects(replayEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === expected)
    assert.equal(fake.requests.length, 2)
    assert.doesNotMatch(JSON.stringify(await receipt(cwd)), /PRIVATE|foreign|blob_key/)
  }
})

test('redirects at every phase never forward credentials or expose Location', async t => {
  for (let phase = 0; phase < 3; phase++) {
    const queue = responses().slice(0, phase)
    queue.push(new Response(null, { status: 302, headers: { Location: `https://foreign.test/?token=${key}` } }))
    const cwd = await temporaryDirectory(t), fake = recordingFetch(queue)
    await assert.rejects(replayEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === 'redirect_not_allowed')
    assert.equal(fake.requests.length, phase + 1)
    assert.doesNotMatch(JSON.stringify(await receipt(cwd)), /foreign|phx_|Location/)
  }
})

test('permission and HTTP failures emit only closed status codes and never retry or dump responses', async t => {
  for (const status of [403, 404, 429, 500]) {
    const cwd = await temporaryDirectory(t), fake = recordingFetch([new Response(`PRIVATE_RESPONSE ${key}`, { status })]), output = []
    const code = await main(['--session-id', sessionId, '--trace-id', traceId], {
      cwd, env: { POSTHOG_PERSONAL_API_KEY: key }, fetchImpl: fake.fetchImpl,
      stdout: { write: value => output.push(value) }, stderr: { write: value => output.push(value) },
    })
    assert.equal(code, 1); assert.equal(fake.requests.length, 1)
    const saved = await receipt(cwd)
    assert.deepEqual(saved.error, { code: 'http_error', phase: 'metadata', http_status: status })
    assert.doesNotMatch(output.join('') + JSON.stringify(saved), /PRIVATE_|phx_|cause|stack/)
  }
})

test('JSONL is validated without reporting invalid bytes or private event contents', async t => {
  for (const [bytes, expected] of [[Buffer.from([0xc3, 0x28]), 'invalid_snapshot_encoding'],
    [Buffer.from('PRIVATE_BAD_JSON'), 'invalid_snapshot_jsonl'], [Buffer.from('\n  \n'), 'empty_snapshot'],
    [Buffer.from(JSON.stringify({ private: key })), 'invalid_snapshot_event'],
    [Buffer.from(JSON.stringify(['x', { type: 8, timestamp: start + 12000, data: key }])), 'invalid_snapshot_event'],
    [Buffer.from(JSON.stringify(['x', { type: 3, timestamp: 'PRIVATE_TIMESTAMP', data: key }])), 'invalid_snapshot_event'],
    [Buffer.from(JSON.stringify(['x', { type: 3, timestamp: start - 1000, data: key }])), 'snapshot_outside_source_window']]) {
    const cwd = await temporaryDirectory(t), fake = recordingFetch([json(metadata()), json({ sources: [source()] }), segment(bytes)])
    await assert.rejects(replayEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === expected)
    assert.equal(fake.requests.length, 3)
    assert.doesNotMatch(JSON.stringify(await receipt(cwd)), /PRIVATE_|phx_|data|cause|stack/)
  }
})

test('declared and streamed byte limits reject large metadata or snapshots before evidence can pass', async t => {
  const cases = [
    [new Response('{}', { headers: { 'Content-Length': String(1024 * 1024 + 1) } })],
    [new Response(Buffer.alloc(1024 * 1024 + 1, 32))],
    [json(metadata()), json({ sources: [source()] }), new Response(payload, { headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) } })],
    [json(metadata()), json({ sources: [source()] }), new Response(Buffer.alloc(8 * 1024 * 1024 + 1, 32))],
  ]
  for (const queue of cases) {
    const cwd = await temporaryDirectory(t), fake = recordingFetch(queue)
    await assert.rejects(replayEvidence(target, { cwd, key, fetchImpl: fake.fetchImpl }), error => error.code === 'response_too_large')
    assert.equal((await receipt(cwd)).status, 'failed')
  }
})

test('a stalled request is aborted by the total deadline and cannot leave a passing receipt', async t => {
  const cwd = await temporaryDirectory(t)
  let signal, calls = 0
  await assert.rejects(replayEvidence({ ...target, timeoutMs: 1000 }, { cwd, key,
    fetchImpl: async (_url, options) => { calls++; signal = options.signal; return new Promise(() => {}) },
  }), error => error.code === 'deadline_exceeded')
  assert.equal(signal.aborted, true); assert.equal(calls, 1)
  assert.equal((await receipt(cwd)).status, 'failed')
})

test('missing/project keys and untrusted exceptions never reach stdout or stderr', async t => {
  const cwd = await temporaryDirectory(t)
  for (const token of [undefined, 'phc_not_personal', key]) {
    const output = []
    const code = await main(['--session-id', sessionId, '--trace-id', traceId], {
      cwd, env: { POSTHOG_PERSONAL_API_KEY: token },
      fetchImpl: async () => { throw new Error(`PRIVATE_NETWORK ${key} https://foreign.test/?secret=x`) },
      stdout: { write: value => output.push(value) }, stderr: { write: value => output.push(value) },
    })
    assert.equal(code, 1)
    assert.doesNotMatch(output.join(''), /PRIVATE_|phx_|phc_|foreign|secret=|cause|stack/)
  }
})

test('a later failed read replaces an old success receipt and unknown metadata stays null', async t => {
  const cwd = await temporaryDirectory(t)
  const successful = recordingFetch([json(metadata({ recording_duration: undefined, event_count: undefined, total_size: undefined, end_time: null })),
    json({ sources: [source()] }), segment()])
  const first = await replayEvidence(target, { cwd, key, fetchImpl: successful.fetchImpl })
  assert.deepEqual(first.recording, { start_time: iso(0), end_time: null, duration_seconds: null, event_count: null, total_size: null, ongoing: false })
  const failed = recordingFetch([json({ found: false })])
  await assert.rejects(replayEvidence(target, { cwd, key, fetchImpl: failed.fetchImpl }), error => error.code === 'recording_not_found')
  assert.equal((await receipt(cwd)).status, 'failed')
  assert.equal((await receipt(cwd)).snapshot, undefined)
})

test('an oversized response releases its stream and preserves the refusal reason', async t => {
  const cwd = await temporaryDirectory(t)
  let cancelled = false
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
    cancel() { cancelled = true; return new Promise(() => {}) },
  })
  const fake = recordingFetch([new Response(body)])
  await assert.rejects(replayEvidence({ ...target, timeoutMs: 1000 }, { cwd, key, fetchImpl: fake.fetchImpl }),
    error => error.code === 'response_too_large' && error.phase === 'metadata')
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})
