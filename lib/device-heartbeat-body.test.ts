import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceHeartbeatSchema } from '@mikka/protocol/device'
import { TASK_SECRET_MAX_ASSIGNMENT_BYTES, TASK_SECRET_MAX_TOKEN_BYTES } from '@mikka/protocol/task-secrets'
import { DEVICE_HEARTBEAT_MAX_BODY_BYTES, readDeviceHeartbeatBody, withDeviceHeartbeatBody } from './device-heartbeat-body'

const encoder = new TextEncoder()
const heartbeat = { harnesses: [], runs: [], worktreeDiskBytes: 0 }
const endpoint = 'https://mikka.example/v1/devices/fixture/heartbeat'
const encoded = (value: unknown) => encoder.encode(JSON.stringify(value))

function streamRequest(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { reads: 0, cancelled: false }
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.reads++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
    cancel() { state.cancelled = true },
  }, { highWaterMark: 0 })
  return { state, request: new Request(endpoint, { method: 'POST', headers, body, duplex: 'half' } as RequestInit & { duplex: 'half' }) }
}

test('keeps the existing schema and accepts all 500 legacy run reports', async () => {
  const value = { ...heartbeat, runs: Array.from({ length: 500 }, (_, index) => ({ runId: `run-${index}`, lastProgressAt: '2026-11-08T00:00:00.000Z' })) }
  const { request } = streamRequest([encoded(value)])
  const result = await readDeviceHeartbeatBody(request)
  assert.deepEqual(result, { ok: true, value })
  assert.equal(result.ok && deviceHeartbeatSchema.safeParse(result.value).success, true)
})

test('accepts exactly the byte limit, including a split UTF-8 sequence', async () => {
  const value = { ...heartbeat, extra: '界' }
  const prefix = encoded(value)
  const bytes = new Uint8Array(DEVICE_HEARTBEAT_MAX_BODY_BYTES).fill(32)
  bytes.set(prefix)
  const split = prefix.indexOf(0xe7) + 1
  const { request, state } = streamRequest([bytes.subarray(0, split), bytes.subarray(split, 8192), bytes.subarray(8192)])
  assert.deepEqual(await readDeviceHeartbeatBody(request), { ok: true, value })
  assert.equal(state.cancelled, false)
})

test('rejects and cancels a chunked oversized body without trusting absent or small Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': 'invalid' }] as Array<Record<string, string>>) {
    const chunks = [new Uint8Array(DEVICE_HEARTBEAT_MAX_BODY_BYTES), new Uint8Array(1), encoded(heartbeat)]
    const { request, state } = streamRequest(chunks, headers)
    assert.deepEqual(await readDeviceHeartbeatBody(request), { ok: false, status: 413 })
    assert.equal(state.reads, 2, 'never consumes the rest after crossing the budget')
    assert.equal(state.cancelled, true)
  }
})

test('rejects an oversized announced body before pulling any stream bytes', async () => {
  const { request, state } = streamRequest([encoded(heartbeat)], { 'content-length': String(DEVICE_HEARTBEAT_MAX_BODY_BYTES + 1) })
  assert.deepEqual(await readDeviceHeartbeatBody(request), { ok: false, status: 413 })
  assert.equal(state.reads, 0)
  assert.equal(state.cancelled, true)
})

test('the route body gate rejects oversize before authentication, writes or renewal can start', async () => {
  let entered = 0
  const handler = withDeviceHeartbeatBody(async () => {
    entered++
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  })
  const announced = streamRequest([encoded(heartbeat)], { 'content-length': String(DEVICE_HEARTBEAT_MAX_BODY_BYTES + 1) }).request
  const chunked = streamRequest([new Uint8Array(DEVICE_HEARTBEAT_MAX_BODY_BYTES), new Uint8Array(1)]).request
  for (const request of [announced, chunked]) {
    const response = await handler(request)
    assert.equal(response.status, 413)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: 'Heartbeat too large.' })
  }
  assert.equal(entered, 0)
  assert.equal((await handler(streamRequest([encoder.encode('{')]).request)).status, 401, 'within-budget malformed bodies retain authentication-first refusal')
  assert.equal(entered, 1)
})

test('the route body gate passes the same request, parsed data and route context to the existing handler', async () => {
  const { request } = streamRequest([encoded(heartbeat)])
  const context = { params: Promise.resolve({ deviceId: 'fixture' }) }
  const handler = withDeviceHeartbeatBody(async (actualRequest, value, actualContext: typeof context) => {
    assert.equal(actualRequest, request)
    assert.deepEqual(value, heartbeat)
    assert.equal(actualContext, context)
    return new Response(null, { status: 204 })
  })
  assert.equal((await handler(request, context)).status, 204)
})

test('limits UTF-8 bytes rather than JavaScript string length', async () => {
  const json = JSON.stringify({ ...heartbeat, extra: '界'.repeat(Math.floor(DEVICE_HEARTBEAT_MAX_BODY_BYTES / 3)) })
  assert.ok(json.length < DEVICE_HEARTBEAT_MAX_BODY_BYTES)
  const { request, state } = streamRequest([encoder.encode(json)])
  assert.deepEqual(await readDeviceHeartbeatBody(request), { ok: false, status: 413 })
  assert.equal(state.cancelled, true)
})

test('a hostile cancellation acknowledgement cannot stall the 413 response', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(DEVICE_HEARTBEAT_MAX_BODY_BYTES + 1)) },
    cancel() { return new Promise(() => undefined) },
  }, { highWaterMark: 0 })
  const request = new Request(endpoint, { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' })
  assert.deepEqual(await readDeviceHeartbeatBody(request), { ok: false, status: 413 })
})

test('15 full capability renewals fit; 16 full bundles exceed the whole-request budget', async () => {
  const tokens = Array.from({ length: TASK_SECRET_MAX_ASSIGNMENT_BYTES / TASK_SECRET_MAX_TOKEN_BYTES }, () => 'x'.repeat(TASK_SECRET_MAX_TOKEN_BYTES))
  const run = { runId: 'run-with-protected-secrets', lastProgressAt: '2026-11-08T00:00:00.000Z', secretCapabilities: tokens }
  const accepted = { ...heartbeat, runs: Array.from({ length: 15 }, (_, index) => ({ ...run, runId: `${run.runId}-${index}` })) }
  assert.equal(deviceHeartbeatSchema.safeParse(accepted).success, true)
  const allowed = await readDeviceHeartbeatBody(streamRequest([encoded(accepted)]).request)
  assert.equal(allowed.ok, true)
  const oversized = { ...accepted, runs: [...accepted.runs, run] }
  assert.equal(deviceHeartbeatSchema.safeParse(oversized).success, true, 'the byte budget is deliberately separate from schema cardinality')
  assert.deepEqual(await readDeviceHeartbeatBody(streamRequest([encoded(oversized)]).request), { ok: false, status: 413 })
})

test('preserves invalid JSON, absent body and read failures as invalid-heartbeat inputs', async () => {
  const invalid = streamRequest([encoder.encode('{"incomplete":')]).request
  const absent = new Request(endpoint, { method: 'POST' })
  const failed = new Request(endpoint, { method: 'POST', body: new ReadableStream({
    pull(controller) { controller.error(new Error('transport failed')) },
  }), duplex: 'half' } as RequestInit & { duplex: 'half' })
  for (const request of [invalid, absent, failed]) {
    const result = await readDeviceHeartbeatBody(request)
    assert.deepEqual(result, { ok: true, value: null })
    assert.equal(result.ok && deviceHeartbeatSchema.safeParse(result.value).success, false)
  }
})
