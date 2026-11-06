// Test-only OTLP/HTTP collector. Retains a closed metadata view, never raw requests.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { gunzipSync } from 'node:zlib'

const string = value => Buffer.isBuffer(value) ? value.toString('utf8') : ''
const hex = value => Buffer.isBuffer(value) ? value.toString('hex') : ''
const values = (fields, tag) => fields.get(tag) ?? []
const first = (fields, tag) => values(fields, tag)[0]

/** The standard protobuf wire types used by OTLP. Unknown fields stay opaque. */
function fields(buffer) {
  const result = new Map()
  let offset = 0
  const variable = () => {
    let value = 0n, shift = 0n
    for (let index = 0; index < 10; index++) {
      assert.ok(offset < buffer.length, 'TRUNCATED_OTLP')
      const byte = buffer[offset++]
      value |= BigInt(byte & 0x7f) << shift
      if (!(byte & 0x80)) return value
      shift += 7n
    }
    throw new Error('INVALID_OTLP_VARINT')
  }
  while (offset < buffer.length) {
    const key = Number(variable()), tag = key >>> 3, wire = key & 7
    assert.ok(tag > 0, 'INVALID_OTLP_TAG')
    let value
    if (wire === 0) value = variable()
    else {
      const length = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? Number(variable()) : -1
      assert.ok(length >= 0 && length <= buffer.length - offset, 'INVALID_OTLP_LENGTH')
      value = buffer.subarray(offset, offset + length); offset += length
    }
    result.set(tag, [...values(result, tag), value])
  }
  return result
}
function any(value) {
  const data = fields(value)
  if (data.has(1)) return string(first(data, 1))
  if (data.has(2)) return first(data, 2) !== 0n
  if (data.has(3)) return Number(first(data, 3))
  if (data.has(4)) return first(data, 4).readDoubleLE()
}
function attributes(records) {
  return Object.fromEntries(records.map(value => { const data = fields(value); return [string(first(data, 1)), any(first(data, 2))] }))
}
const allowed = new Set(['service.name', 'mikka.run_id', 'mikka.thread_id', 'mikka.task_id', 'mikka.task_number', 'mikka.workflow_run_id',
  'mikka.harness', 'mikka.outcome', 'mikka.stage', 'mikka.status', 'mikka.error.code', 'mikka.error.detail', 'mikka.error.causes',
  'mikka.workflow', 'mikka.step', 'mikka.route', 'mikka.client_kind', 'mikka.ai.provider', 'mikka.ai.model', 'mikka.ai.operation',
  'mikka.ai.input_tokens', 'mikka.ai.output_tokens', 'mikka.ai.cache_read_tokens', 'mikka.ai.cache_write_tokens', 'mikka.ai.ttft_ms',
  'mikka.ai.latency_ms', 'mikka.ai.total_cost_usd', 'error.type', 'sessionId', 'posthogDistinctId', 'http.response.status_code', 'db.system', 'db.system.name'])
const safe = input => Object.fromEntries(Object.entries(input).filter(([key, value]) => allowed.has(key)
  && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 512)))

export function decodeOtlp(body, signal) {
  const output = []
  for (const resource of values(fields(body), 1)) {
    const group = fields(resource)
    const service = attributes(values(fields(first(group, 1)), 1))['service.name']
    for (const scope of values(group, 2)) for (const item of values(fields(scope), 2)) {
      const data = fields(item)
      if (signal === 'traces') output.push({ service, name: string(first(data, 5)), traceId: hex(first(data, 1)), spanId: hex(first(data, 2)),
        parentSpanId: hex(first(data, 4)), status: first(data, 15) ? Number(first(fields(first(data, 15)), 3) ?? 0n) : 0,
        attributes: safe(attributes(values(data, 9))) })
      else output.push({ service, traceId: hex(first(data, 9)), spanId: hex(first(data, 10)), severity: Number(first(data, 2) ?? 0n),
        body: first(data, 5) ? any(first(data, 5)) : undefined, attributes: safe(attributes(values(data, 6))) })
    }
  }
  return output
}

const aiAllowed = new Set(['$ai_trace_id', '$ai_span_id', '$ai_parent_id', '$ai_session_id', '$session_id', '$ai_model', '$ai_provider', '$ai_input_tokens', '$ai_output_tokens',
  '$ai_cache_read_input_tokens', '$ai_cache_creation_input_tokens', '$ai_total_cost_usd', '$ai_cost_passthrough', '$ai_latency', '$ai_time_to_first_token', '$ai_is_error'])
export async function startTraceCollector(port = 3196) {
  const evidence = { spans: [], logs: [], generations: [], privacyViolations: 0, dropped: 0, malformed: 0 }
  const forbidden = new Set()
  const append = (target, rows) => {
    const room = Math.max(0, 20_000 - target.length)
    target.push(...rows.slice(0, room)); evidence.dropped += Math.max(0, rows.length - room)
  }
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (request.method === 'GET' && path === '/health') { response.writeHead(200); return response.end('ready') }
      const chunks = []; let size = 0
      for await (const chunk of request) { size += chunk.length; assert.ok(size <= 8_000_000, 'COLLECTOR_REQUEST_TOO_LARGE'); chunks.push(chunk) }
      let body = Buffer.concat(chunks)
      if (request.headers['content-encoding'] === 'gzip') body = gunzipSync(body, { maxOutputLength: 16_000_000 })
      for (const value of forbidden) if (body.includes(value)) evidence.privacyViolations++
      if (path === '/i/v1/traces' || path === '/i/v1/logs') {
        const signal = path.endsWith('/traces') ? 'traces' : 'logs'
        append(signal === 'traces' ? evidence.spans : evidence.logs, decodeOtlp(body, signal))
        response.writeHead(200, { 'content-type': 'application/x-protobuf' }); return response.end(Buffer.alloc(0))
      }
      if (path.startsWith('/flags')) { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ featureFlags: {}, featureFlagPayloads: {} })) }
      const payload = JSON.parse(body.toString('utf8'))
      for (const event of payload.batch ?? [payload]) if (event.event === '$ai_generation') {
        append(evidence.generations, [{ timestamp: event.timestamp, properties: Object.fromEntries(Object.entries(event.properties ?? {}).filter(([key, value]) =>
          (aiAllowed.has(key) || allowed.has(key)) && (typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || typeof value === 'string' && value.length <= 128))) }])
      }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":1}')
    } catch {
      evidence.malformed++; response.writeHead(400); response.end('invalid')
    }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
  return { evidence, forbid: value => forbidden.add(value), async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
