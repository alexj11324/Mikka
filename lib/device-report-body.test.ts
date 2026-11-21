import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deviceReportSchema } from '@mikka/protocol/device'
import { DEVICE_REPORT_MAX_BODY_BYTES, readDeviceReportBody, withDeviceReportBody } from './device-report-body'

const encoder = new TextEncoder()
const report = { harnesses: [], worktreeDiskBytes: 0 }
const endpoint = 'https://mikka.example/v1/devices/fixture/report'
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

test('keeps the report schema', async () => {
  const value = { ...report, completedDeviceCommands: [crypto.randomUUID()], updateFailure: null }
  const { request } = streamRequest([encoded(value)])
  const result = await readDeviceReportBody(request)
  assert.deepEqual(result, { ok: true, value })
  assert.equal(result.ok && deviceReportSchema.safeParse(result.value).success, true)
})

test('accepts exactly the byte limit, including a split UTF-8 sequence', async () => {
  const value = { ...report, extra: '界' }
  const prefix = encoded(value)
  const bytes = new Uint8Array(DEVICE_REPORT_MAX_BODY_BYTES).fill(32)
  bytes.set(prefix)
  const split = prefix.indexOf(0xe7) + 1
  const { request, state } = streamRequest([bytes.subarray(0, split), bytes.subarray(split, 8192), bytes.subarray(8192)])
  assert.deepEqual(await readDeviceReportBody(request), { ok: true, value })
  assert.equal(state.cancelled, false)
})

test('rejects and cancels a chunked oversized body without trusting absent or small Content-Length', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': 'invalid' }] as Array<Record<string, string>>) {
    const chunks = [new Uint8Array(DEVICE_REPORT_MAX_BODY_BYTES), new Uint8Array(1), encoded(report)]
    const { request, state } = streamRequest(chunks, headers)
    assert.deepEqual(await readDeviceReportBody(request), { ok: false, status: 413 })
    assert.equal(state.reads, 2, 'never consumes the rest after crossing the budget')
    assert.equal(state.cancelled, true)
  }
})

test('rejects an oversized announced body before pulling any stream bytes', async () => {
  const { request, state } = streamRequest([encoded(report)], { 'content-length': String(DEVICE_REPORT_MAX_BODY_BYTES + 1) })
  assert.deepEqual(await readDeviceReportBody(request), { ok: false, status: 413 })
  assert.equal(state.reads, 0)
  assert.equal(state.cancelled, true)
})

test('the route body gate rejects oversize before authentication, or writes can start', async () => {
  let entered = 0
  const handler = withDeviceReportBody(async () => {
    entered++
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  })
  const announced = streamRequest([encoded(report)], { 'content-length': String(DEVICE_REPORT_MAX_BODY_BYTES + 1) }).request
  const chunked = streamRequest([new Uint8Array(DEVICE_REPORT_MAX_BODY_BYTES), new Uint8Array(1)]).request
  for (const request of [announced, chunked]) {
    const response = await handler(request)
    assert.equal(response.status, 413)
    assert.equal(response.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(await response.json(), { error: 'Report too large.' })
  }
  assert.equal(entered, 0)
  assert.equal((await handler(streamRequest([encoder.encode('{')]).request)).status, 401, 'within-budget malformed bodies retain authentication-first refusal')
  assert.equal(entered, 1)
})

test('the route body gate passes the same request, parsed data and route context to the existing handler', async () => {
  const { request } = streamRequest([encoded(report)])
  const context = { params: Promise.resolve({ deviceId: 'fixture' }) }
  const handler = withDeviceReportBody(async (actualRequest, value, actualContext: typeof context) => {
    assert.equal(actualRequest, request)
    assert.deepEqual(value, report)
    assert.equal(actualContext, context)
    return new Response(null, { status: 204 })
  })
  assert.equal((await handler(request, context)).status, 204)
})

test('limits UTF-8 bytes rather than JavaScript string length', async () => {
  const json = JSON.stringify({ ...report, extra: '界'.repeat(Math.floor(DEVICE_REPORT_MAX_BODY_BYTES / 3)) })
  assert.ok(json.length < DEVICE_REPORT_MAX_BODY_BYTES)
  const { request, state } = streamRequest([encoder.encode(json)])
  assert.deepEqual(await readDeviceReportBody(request), { ok: false, status: 413 })
  assert.equal(state.cancelled, true)
})

test('a hostile cancellation acknowledgement cannot stall the 413 response', async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(DEVICE_REPORT_MAX_BODY_BYTES + 1)) },
    cancel() { return new Promise(() => undefined) },
  }, { highWaterMark: 0 })
  const request = new Request(endpoint, { method: 'POST', body, duplex: 'half' } as RequestInit & { duplex: 'half' })
  assert.deepEqual(await readDeviceReportBody(request), { ok: false, status: 413 })
})

test('preserves invalid JSON, absent body and read failures as invalid-report inputs', async () => {
  const invalid = streamRequest([encoder.encode('{"incomplete":')]).request
  const absent = new Request(endpoint, { method: 'POST' })
  const failed = new Request(endpoint, { method: 'POST', body: new ReadableStream({
    pull(controller) { controller.error(new Error('transport failed')) },
  }), duplex: 'half' } as RequestInit & { duplex: 'half' })
  for (const request of [invalid, absent, failed]) {
    const result = await readDeviceReportBody(request)
    assert.deepEqual(result, { ok: true, value: null })
    assert.equal(result.ok && deviceReportSchema.safeParse(result.value).success, false)
  }
})
