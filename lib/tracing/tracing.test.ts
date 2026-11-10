import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { after, before, describe, test } from 'node:test'
import { SpanKind, trace } from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { InMemorySpanExporter, type ReadableSpan, type SpanExporter } from '@opentelemetry/sdk-trace-base'
import type { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { Pool as PgPool } from 'pg'
import { afterJob, cronJob } from '@/lib/background'
import { describeSample, withDatabaseOperation } from '@/lib/db/egress-sample'
import { manageDatabasePool } from '@/lib/db/pool-lifecycle'
import { currentRoute, routeScope } from './labels'
import { traceSampleRate, traceSettings } from './config'
import { EXPORT_PAUSE_MS, SafeExporter, createPgInstrumentation, createTracerProvider } from './node'
import { normalizeStatement, sanitizeAttributes, scrubString, statementId } from './sanitize'
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
  let jobLabel: string | undefined
  let stepLabel: string | undefined

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
    const { Pool } = createRequire(import.meta.url)('pg') as { Pool: typeof PgPool }
    server = fakePostgres()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    pool = manageDatabasePool(new Pool({ connectionString: `postgres://mikka:${password}@127.0.0.1:${port}/mikka`, max: 1 }))

    const tracer = trace.getTracer('test')
    await tracer.startActiveSpan('GET', { kind: SpanKind.SERVER, attributes: { 'http.method': 'GET', 'http.target': `/mikka/v1/devices/dev_1/commands?token=${token}&email=${encodeURIComponent(email)}` } }, async root => {
      await withDatabaseOperation('/actions/issues/update', () => pool.query(parameterized, [email, token, prompt]))
      await pool.query(literal)
      await pool.query('insert into "people" ("email") values ($1)', [ERROR_VALUE]).catch(() => {})
      root.setAttribute('http.route', '/v1/devices/[deviceId]/commands')
      root.end()
    })

    // Next's after(): the callback runs once the response is done, in a
    // snapshot of the scheduling request's async context (bindSnapshot).
    const scheduled: (() => unknown)[] = []
    const foreign: (() => unknown)[] = []
    const nextAfter = (task: () => unknown) => { const snapshot = AsyncLocalStorage.snapshot(); scheduled.push(() => snapshot(task)) }
    await tracer.startActiveSpan('POST', { kind: SpanKind.SERVER, attributes: { 'http.method': 'POST', 'http.target': '/mikka/api/coordinator/messages' } }, async root => {
      await routeScope.run('/api/coordinator/messages', async () => {
        await pool.query('select 1 as "request_read"')
        afterJob('after:coordinator-wake', async () => {
          jobLabel = currentRoute()
          await pool.query('select "note" from "issues" where "email" = $1 and "body" = $2', [email, prompt])
        }, { schedule: nextAfter })
        // The same work scheduled with a bare after(): the pitfall afterJob avoids.
        nextAfter(() => pool.query('select 3 as "bare_after"'))
        // retainContext binds the request's context; the label is still entered inside it.
        afterJob('after:live-notify', () => pool.query('select 6 as "retained"'), { retainContext: true, schedule: task => { foreign.push(task) } })
      })
      root.end()
    })
    for (const task of scheduled) await task()
    // A scheduler that calls back from an unrelated context.
    await routeScope.run('/api/unrelated', async () => { for (const task of foreign) await task() })

    // A Workflow step body runs inside the SDK's step context, on the step delivery request.
    const stepContext = ((globalThis as Record<symbol, unknown>)[Symbol.for('WORKFLOW_STEP_CONTEXT_STORAGE')] ??= new AsyncLocalStorage()) as AsyncLocalStorage<unknown>
    await tracer.startActiveSpan('POST', { kind: SpanKind.SERVER, attributes: { 'http.method': 'POST', 'http.target': '/mikka/.well-known/workflow/v1/step' } }, async root => {
      await stepContext.run({
        stepMetadata: { stepName: 'step//./workflows/run-publication/steps//publishResult', stepId: 'step_1', attempt: 1 },
        workflowMetadata: { workflowName: 'workflow//./workflows/run-publication/workflow//runPublication', workflowRunId: 'wrun_1' },
      }, async () => {
        stepLabel = currentRoute()
        await pool.query('select 4 as "step_read"')
      })
      root.end()
    })

    // A cron handler: its own job span inside the cron request.
    await tracer.startActiveSpan('GET', { kind: SpanKind.SERVER, attributes: { 'http.method': 'GET', 'http.target': '/mikka/api/cron/run-recovery' } }, async root => {
      await cronJob('run-recovery', () => pool.query('select 5 as "cron_read"'))()
      root.end()
    })

    // A busy pool hands the connection to the next request from the previous
    // socket's callback. Both real PG query spans must still be children of
    // their initiating request, even with ignoreConnectSpans enabled.
    const held = await pool.connect()
    const queued = ['/api/agent/sessions', '/actions/issues/poll'].map((route, index) =>
      tracer.startActiveSpan(`queued-${index}`, { kind: SpanKind.SERVER }, async root => {
        try { await withDatabaseOperation(route, () => pool.query(`select 1 as "queued_${index}"`)) }
        finally { root.end() }
      }))
    assert.equal(pool.waitingCount, 2)
    held.release()
    await Promise.all(queued)
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

  const traceOf = (span: ReadableSpan) => span.spanContext().traceId
  const requestTrace = () => traceOf(spans.find(span => span.name === 'GET' && span.attributes['http.target'] === '/mikka/v1/devices/dev_1/commands')!)
  const dbSpans = () => spans.filter(span => span.name.startsWith('pg.query') && traceOf(span) === requestTrace())
  const query = (text: string) => spans.find(span => span.name.startsWith('pg.query') && span.attributes['db.query.text'] === text)!

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
      if (traceOf(span) === requestTrace()) assert.equal(span.attributes['mikka.client_kind'], 'daemon')
    }
    const root = spans.find(span => span.name === 'GET')!
    assert.equal(root.attributes['http.target'], '/mikka/v1/devices/dev_1/commands')
    assert.equal(root.attributes['mikka.route'], '/v1/devices/[deviceId]/commands')
  })

  test('queued queries retain their own request trace, parent and operation without connection spans', () => {
    for (const [index, route] of ['/api/agent/sessions', '/actions/issues/poll'].entries()) {
      const root = spans.find(span => span.name === `queued-${index}`)!
      const statement = query(`select ? as "queued_${index}"`)
      assert.ok(root && statement)
      assert.equal(traceOf(statement), traceOf(root))
      assert.equal(statement.parentSpanContext?.spanId, root.spanContext().spanId)
      assert.equal(statement.attributes['mikka.route'], route)
      assert.equal(spans.filter(span => traceOf(span) === traceOf(root)).length, 2, 'one request and one query, without extra connection or SQL work')
    }
  })

  test("an after() job keeps its own route and continues the scheduling request's trace", () => {
    const request = spans.find(span => span.name === 'POST' && span.attributes['http.target'] === '/mikka/api/coordinator/messages')!
    const job = spans.find(span => span.name === 'after:coordinator-wake')!
    const statement = query('select "note" from "issues" where "email" = $1 and "body" = $2')
    assert.equal(query('select ? as "request_read"').attributes['mikka.route'], '/api/coordinator/messages')
    assert.equal(job.parentSpanContext?.spanId, request.spanContext().spanId)
    assert.equal(traceOf(job), traceOf(request))
    assert.equal(job.attributes['mikka.route'], 'after:coordinator-wake')
    assert.equal(job.attributes['mikka.client_kind'], 'background')
    assert.equal(traceOf(statement), traceOf(job))
    assert.equal(statement.parentSpanContext?.spanId, job.spanContext().spanId)
    assert.equal(statement.attributes['mikka.route'], 'after:coordinator-wake')
    assert.equal(statement.attributes['mikka.client_kind'], 'background')
    // The db_sample line reads the same label.
    assert.equal(jobLabel, 'after:coordinator-wake')
    // Without afterJob, deferred work still runs as the request it came from.
    const bare = query('select ? as "bare_after"')
    assert.equal(bare.attributes['mikka.route'], '/api/coordinator/messages')
    assert.equal(traceOf(bare), traceOf(request))
    // A context-retaining job called back from elsewhere still runs under its own label.
    const retained = query('select ? as "retained"')
    assert.equal(retained.attributes['mikka.route'], 'after:live-notify')
    assert.equal(retained.attributes['mikka.client_kind'], 'background')
  })

  test('a Workflow step is labelled with its workflow and step', () => {
    const statement = query('select ? as "step_read"')
    assert.equal(statement.attributes['mikka.route'], 'workflow:runPublication/publishResult')
    assert.equal(statement.attributes['mikka.client_kind'], 'workflow')
    assert.equal(stepLabel, 'workflow:runPublication/publishResult')
  })

  test('a cron handler runs as cron:<name> inside its request', () => {
    const request = spans.find(span => span.attributes['http.target'] === '/mikka/api/cron/run-recovery')!
    const job = spans.find(span => span.name === 'cron:run-recovery')!
    const statement = query('select ? as "cron_read"')
    assert.equal(job.parentSpanContext?.spanId, request.spanContext().spanId)
    assert.equal(statement.attributes['mikka.route'], 'cron:run-recovery')
    assert.equal(statement.attributes['mikka.client_kind'], 'cron')
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
    assert.equal(clientKindFor('/mikka/.well-known/workflow/v1/step'), 'workflow')
    assert.equal(clientKindFor('after:live-notify'), 'background')
    assert.equal(clientKindFor('cron:run-recovery/group-turns'), 'cron')
    assert.equal(clientKindFor('workflow:runPublication/publishResult'), 'workflow')
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

test('database region evidence projects the actual pg host without exporting its endpoint', () => {
  for (const [host, expected] of [
    ['ep-private-custody-123456.c-7.us-east-2.aws.neon.tech', 'aws-us-east-2'],
    ['ep-private-custody-123456-pooler.us-east-1.aws.neon.tech', 'aws-us-east-1'],
  ]) {
    const result = sanitizeAttributes({ 'db.system.name': 'postgresql', 'server.address': host, 'server.port': 5432 })
    assert.equal(result['mikka.db_peer_region'], expected)
    assert.equal(result['server.address'], undefined)
    assert.equal(result['server.port'], 5432)
    assert.equal(JSON.stringify(result).includes('private-custody'), false)
  }
})

test('database region evidence cannot be supplied by a caller or inferred from unrecognized peers', () => {
  for (const host of [
    'ep-private.us-east-2.aws.neon.tech.attacker.example',
    'postgres://owner:secret@ep-private.us-east-2.aws.neon.tech/database',
    'ep-private.us-west-2.aws.neon.tech',
    '127.0.0.1',
    'private-host.example',
    '',
  ]) {
    const result = sanitizeAttributes({ 'db.system': 'postgresql', 'server.address': host, 'mikka.db_peer_region': 'aws-us-east-2' })
    assert.equal(result['mikka.db_peer_region'], undefined)
    assert.equal(result['server.address'], undefined)
  }
  assert.equal(sanitizeAttributes({
    'db.system': 'redis',
    'server.address': 'ep-private.us-east-2.aws.neon.tech',
    'mikka.db_peer_region': 'aws-us-east-2',
  })['mikka.db_peer_region'], undefined)
})
