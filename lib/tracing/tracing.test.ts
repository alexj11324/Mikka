import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { after, before, describe, test } from 'node:test'
import { SpanKind, trace } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { Pool as PgPool } from 'pg'
import { describeSample, withDatabaseOperation } from '@/lib/db/egress-sample'
import { traceSampleRate, traceSettings } from './config'
import { EXPORT_PAUSE_MS, SafeExporter, createPgInstrumentation, createTracerProvider } from './node'
import { normalizeStatement, scrubString, statementId } from './sanitize'
import { approximateBytes, clientKindFor, pgResponseHook } from './spans'

// A minimal Postgres wire-protocol server, so the real `pg` driver and the real
// pg instrumentation run without a database. It answers every statement with
// one text row, or with a unique-violation error that echoes a value.

const ROW_CONTENT = 'row-content-alice-private-note'
const ERROR_VALUE = 'dup.person@example.com'

function message(type: string, body: Buffer = Buffer.alloc(0)) {
  const head = Buffer.alloc(5)
  head.write(type, 0, 'latin1')
  head.writeInt32BE(body.length + 4, 1)
  return Buffer.concat([head, body])
}
const cstring = (value: string) => Buffer.from(`${value}\0`)
const int16 = (value: number) => { const b = Buffer.alloc(2); b.writeInt16BE(value); return b }
const int32 = (value: number) => { const b = Buffer.alloc(4); b.writeInt32BE(value); return b }

function answer(failing: boolean, extended: boolean) {
  const parts: Buffer[] = extended ? [message('1'), message('2')] : []
  if (failing) {
    parts.push(message('E', Buffer.concat([cstring('SERROR'), cstring('C23505'), cstring(`Mduplicate key value violates unique constraint: Key (email)=(${ERROR_VALUE}) already exists`), Buffer.from([0])])))
  } else {
    parts.push(message('T', Buffer.concat([int16(1), cstring('note'), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)])))
    parts.push(message('D', Buffer.concat([int16(1), int32(Buffer.byteLength(ROW_CONTENT)), Buffer.from(ROW_CONTENT)])))
    parts.push(message('C', cstring('SELECT 1')))
  }
  parts.push(message('Z', Buffer.from('I')))
  return Buffer.concat(parts)
}

function fakePostgres(): Server {
  return createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0)
    let started = false
    let pending = { failing: false, extended: false }
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        if (!started) {
          if (buffer.length < 4) return
          const length = buffer.readInt32BE(0)
          if (buffer.length < length) return
          buffer = buffer.subarray(length)
          started = true
          socket.write(Buffer.concat([message('R', int32(0)), message('Z', Buffer.from('I'))]))
          continue
        }
        if (buffer.length < 5) return
        const type = String.fromCharCode(buffer[0])
        const length = buffer.readInt32BE(1)
        if (buffer.length < length + 1) return
        const body = buffer.subarray(5, length + 1)
        buffer = buffer.subarray(length + 1)
        if (type === 'X') return void socket.end()
        if (type === 'P') pending = { failing: body.toString().includes('insert into'), extended: true }
        if (type === 'Q') socket.write(answer(body.toString().includes('insert into'), false))
        if (type === 'S') { socket.write(answer(pending.failing, pending.extended)); pending = { failing: false, extended: false } }
      }
    })
    socket.on('error', () => {})
  })
}

describe('server tracing', () => {
  const memory = new InMemorySpanExporter()
  let provider: NodeTracerProvider
  let server: Server
  let pool: PgPool
  let spans: ReadableSpan[] = []
  let payload = ''

  const email = 'alice.secret@example.com'
  const token = 'mk_live_TOKENVALUE123'
  const prompt = 'please summarize my private diary entry'
  const password = 'db-password-xyz'
  const parameterized = 'select "note" from "issues" where "email" = $1 and "token" = $2 and "body" = $3'
  const literal = `select "note" from "issues" where "email" = '${email}' and "limit_n" = 987654`

  before(async () => {
    provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'production', batch: { scheduledDelayMillis: 10 } })
    provider.register()
    registerInstrumentations({ tracerProvider: provider, instrumentations: [createPgInstrumentation()] })
    // Loaded after the instrumentation hooks require, as lib/db is after instrumentation.ts.
    const { Pool } = createRequire(import.meta.url)('pg') as typeof import('pg')
    server = fakePostgres()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    pool = new Pool({ connectionString: `postgres://mikka:${password}@127.0.0.1:${port}/mikka`, max: 1 })

    const tracer = trace.getTracer('test')
    await tracer.startActiveSpan('GET', { kind: SpanKind.SERVER, attributes: { 'http.method': 'GET', 'http.target': `/mikka/v1/devices/dev_1/commands?token=${token}&email=${encodeURIComponent(email)}` } }, async root => {
      await withDatabaseOperation('/actions/issues/update', () => pool.query(parameterized, [email, token, prompt]))
      await pool.query(literal)
      await pool.query('insert into "people" ("email") values ($1)', [ERROR_VALUE]).catch(() => {})
      root.setAttribute('http.route', '/v1/devices/[deviceId]/commands')
      root.end()
    })
    await provider.forceFlush()
    spans = memory.getFinishedSpans()
    payload = JSON.stringify(spans.map(span => ({ name: span.name, attributes: span.attributes, events: span.events, status: span.status, links: span.links, resource: span.resource.attributes })))
  })

  after(async () => {
    await pool?.end()
    await new Promise(resolve => server?.close(resolve))
    await provider?.shutdown()
    trace.disable()
  })

  const dbSpans = () => spans.filter(span => span.name.startsWith('pg.query'))

  test('a span per statement, with route, client kind, operation, statement id, rows and size', () => {
    assert.equal(dbSpans().length, 3)
    const [first, second, failed] = dbSpans()
    assert.equal(first.attributes['mikka.route'], '/actions/issues/update')
    assert.equal(first.attributes['mikka.client_kind'], 'daemon')
    assert.equal(first.attributes['db.operation'], 'SELECT')
    assert.equal(first.attributes['mikka.db.statement_id'], statementId(parameterized))
    assert.equal(first.attributes['mikka.db.statement_id'], describeSample(parameterized, { rows: [], command: 'SELECT' } as never, null).statement)
    assert.equal(first.attributes['db.query.text'], parameterized)
    assert.equal(first.attributes['db.response.returned_rows'], 1)
    assert.ok(Number(first.attributes['mikka.db.response_bytes_approx']) > 0)
    assert.equal(second.attributes['db.query.text'], 'select "note" from "issues" where "email" = ? and "limit_n" = ?')
    assert.equal(failed.attributes['db.operation'], 'INSERT')
    assert.equal(failed.status.code, 2)
    for (const span of spans) {
      assert.equal(span.resource.attributes['service.name'], 'mikka-web')
      assert.equal(span.resource.attributes['deployment.environment'], 'production')
      assert.equal(span.attributes['mikka.client_kind'], 'daemon')
    }
    const root = spans.find(span => span.name === 'GET')!
    assert.equal(root.attributes['http.target'], '/mikka/v1/devices/dev_1/commands')
    assert.equal(root.attributes['mikka.route'], '/v1/devices/[deviceId]/commands')
  })

  test('no parameter value, row content, error value, token, email, prompt or password leaves the process', () => {
    assert.ok(payload.length > 0)
    for (const secret of [email, encodeURIComponent(email), token, prompt, password, ROW_CONTENT, ERROR_VALUE, '987654', 'duplicate key']) {
      assert.equal(payload.includes(secret), false, `exported spans contain ${secret}`)
    }
    for (const span of spans) {
      for (const key of Object.keys(span.attributes)) assert.doesNotMatch(key, /values|connection_string|user|server\.address|client\.address|peer\.ip/)
      for (const event of span.events) assert.deepEqual(Object.keys(event.attributes ?? {}).filter(key => key !== 'exception.type'), [])
      assert.equal(span.status.message, undefined)
    }
  })
})

describe('sampling and settings', () => {
  test('tests, CI and builds never trace; 10% by default; 1 allowed in dev', () => {
    assert.equal(traceSampleRate({ NODE_ENV: 'test', MIKKA_TRACE_SAMPLE_RATE: '1' }), 0)
    assert.equal(traceSampleRate({ CI: 'true', MIKKA_TRACE_SAMPLE_RATE: '1' }), 0)
    assert.equal(traceSampleRate({ NEXT_PHASE: 'phase-production-build' }), 0)
    assert.equal(traceSampleRate({ VERCEL: '1', CI: '1', VERCEL_ENV: 'production' }), 0.1)
    assert.equal(traceSampleRate({}), 0.1)
    assert.equal(traceSampleRate({ NODE_ENV: 'development', MIKKA_TRACE_SAMPLE_RATE: '1' }), 1)
    assert.equal(traceSampleRate({ MIKKA_TRACE_SAMPLE_RATE: '7' }), 1)
    assert.equal(traceSampleRate({ MIKKA_TRACE_SAMPLE_RATE: 'nope' }), 0.1)
  })

  test('off without a token or at rate 0; PostHog endpoint by default', () => {
    assert.equal(traceSettings({}, ''), null)
    assert.equal(traceSettings({ MIKKA_TRACE_SAMPLE_RATE: '0' }, 'phc_test'), null)
    assert.deepEqual(traceSettings({ VERCEL_ENV: 'preview' }, 'phc_test'), { endpoint: 'https://us.i.posthog.com/i/v1/traces', token: 'phc_test', sampleRate: 0.1, environment: 'preview', version: undefined })
  })

  test('rate 0 provider records nothing', async () => {
    const memory = new InMemorySpanExporter()
    const provider = createTracerProvider({ exporter: memory, sampleRate: 0, environment: 'dev' })
    provider.getTracer('t').startSpan('x').end()
    await provider.forceFlush()
    assert.equal(memory.getFinishedSpans().length, 0)
    await provider.shutdown()
  })
})

describe('export failures', () => {
  test('a failed export is reported as success and pauses exporting instead of retrying', () => {
    let now = 0, calls = 0
    const failing: SpanExporter = { export: (_spans, done) => { calls++; done({ code: ExportResultCode.FAILED, error: new Error('down') }) }, shutdown: async () => {} }
    const exporter = new SafeExporter(failing, () => now)
    const results: number[] = []
    exporter.export([], result => results.push(result.code))
    exporter.export([], result => results.push(result.code))
    now = EXPORT_PAUSE_MS + 1
    exporter.export([], result => results.push(result.code))
    assert.deepEqual(results, [ExportResultCode.SUCCESS, ExportResultCode.SUCCESS, ExportResultCode.SUCCESS])
    assert.equal(calls, 2)
  })

  test('a throwing exporter never throws into the caller', () => {
    const exporter = new SafeExporter({ export: () => { throw new Error('boom') }, shutdown: async () => {} })
    let code: number | undefined
    exporter.export([], result => { code = result.code })
    assert.equal(code, ExportResultCode.SUCCESS)
  })
})

describe('helpers', () => {
  test('client kind from the route prefix', () => {
    assert.equal(clientKindFor('/mikka/v1/runs/r1/events'), 'daemon')
    assert.equal(clientKindFor('/v1/devices/[deviceId]/commands'), 'daemon')
    assert.equal(clientKindFor('/mikka/api/runs/mcp/github'), 'daemon')
    assert.equal(clientKindFor('/mikka/api/mobile/threads?x=1'), 'mobile')
    assert.equal(clientKindFor('/mikka/api/cron/briefings'), 'cron')
    assert.equal(clientKindFor('/mikka/api/webhooks/github'), 'worker')
    assert.equal(clientKindFor('/mikka/.well-known/workflow/v1/step'), 'worker')
    assert.equal(clientKindFor('/mikka/en/settings'), 'web')
    assert.equal(clientKindFor('/actions/issues/update'), 'web')
    assert.equal(clientKindFor('/mikka'), 'web')
  })

  test('statements keep placeholders and lose literals', () => {
    assert.equal(normalizeStatement(`select * from t where a = $1 and b = 'x''y' and c = E'z' and d = 12.5 and "col2" = $10`), 'select * from t where a = $1 and b = ? and c = ? and d = ? and "col2" = $10')
    assert.equal(normalizeStatement('select $$secret body$$, $tag$more$tag$'), 'select ?, ?')
    assert.equal(normalizeStatement(`select ${'x, '.repeat(200)}1`).length, 200)
  })

  test('strings lose query strings, emails and IPs', () => {
    assert.equal(scrubString('GET /mikka/api/x?token=abc'), 'GET /mikka/api/x')
    assert.equal(scrubString('fetch POST https://api.example.com/v1/a?key=k#frag'), 'fetch POST https://api.example.com/v1/a')
    assert.equal(scrubString('from bob@example.com at 10.1.2.3 or 2001:db8::1'), 'from [email] at [ip] or [ip]')
    assert.equal(scrubString('/v1/devices/[deviceId]/commands'), '/v1/devices/[deviceId]/commands')
  })

  test('a multi-statement result sums its rows and keeps the last command', () => {
    const set: Record<string, unknown> = {}
    const span = { isRecording: () => true, setAttribute: (key: string, value: unknown) => { set[key] = value } }
    pgResponseHook(span as never, { data: [{ command: 'BEGIN', rowCount: null, rows: [] }, { command: 'UPDATE', rowCount: 3, rows: [] }] as never })
    assert.deepEqual(set, { 'db.response.returned_rows': 3, 'db.operation': 'UPDATE', 'mikka.db.response_bytes_approx': 0 })
  })

  test('response size is estimated from a sample of rows', () => {
    assert.equal(approximateBytes([]), 0)
    const rows = Array.from({ length: 500 }, () => ({ a: 'xxxx' }))
    assert.equal(approximateBytes(rows), Buffer.byteLength(JSON.stringify(rows.slice(0, 50))) * 10)
  })
})
