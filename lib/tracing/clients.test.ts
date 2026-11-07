import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { channel } from 'node:diagnostics_channel'
import { z } from 'zod'
import { context, propagation, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api'
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base'
import { CodedError } from '../../packages/protocol/src/coded-error'
import { mobileTraceHeaders } from '../../packages/protocol/src/trace-context'
import { hashUserId, noteLogUser, requestClientAttributes, withRequestLog } from '../request-log'
import * as requestLog from '../request-log'
import { dispatchRpc } from '../desktop-rpc/handler'
import { SafeExporter, createTracerProvider } from './node'

const memory = new InMemorySpanExporter()
const provider = createTracerProvider({ exporter: new SafeExporter(memory), sampleRate: 1, environment: 'dev' })
before(() => provider.register())
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })

test('mobile API context joins the server and database spans with version attribution', async () => {
  memory.reset()
  const headers = mobileTraceHeaders('1.2.3')
  const request = new Request('https://mikka.test/mikka/api/issues', { headers })
  const tracer = provider.getTracer('client-propagation')
  await context.with(propagation.extract(ROOT_CONTEXT, headers), () => tracer.startActiveSpan('GET /api/issues', { kind: SpanKind.SERVER, attributes: { 'http.target': '/mikka/api/issues' } }, async span => {
    await withRequestLog('/api/issues', async () => {
      await Promise.resolve()
      tracer.startSpan('database query').end()
      return new Response('{}')
    }, () => {})(request)
    span.end()
  }))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  assert.equal(spans.length, 2)
  for (const span of spans) {
    assert.equal(span.spanContext().traceId, headers.traceparent.slice(3, 35))
    assert.equal(span.attributes['mikka.client_kind'], 'mobile')
    assert.equal(span.attributes['mikka.app.version'], '1.2.3')
  }
  const server = spans.find(span => span.kind === SpanKind.SERVER)!
  assert.equal(server.parentSpanContext?.spanId, headers.traceparent.slice(36, 52))
  assert.equal(spans.find(span => span.name === 'database query')?.parentSpanContext?.spanId, server.spanContext().spanId)
})

test('mobile attribution stays in its request and cannot overwrite machine routes', async () => {
  memory.reset()
  const tracer = provider.getTracer('client-isolation')
  await Promise.all(['mobile', 'web'].map(kind => context.with(ROOT_CONTEXT, () => tracer.startActiveSpan(kind, { kind: SpanKind.SERVER, attributes: { 'http.target': '/api/issues' } }, async span => {
    await withRequestLog('/api/issues', async () => { await Promise.resolve(); tracer.startSpan(`${kind}-query`).end(); return new Response('{}') }, () => {})(new Request('https://mikka.test/api/issues', { headers: kind === 'mobile' ? mobileTraceHeaders('1.0.0') : {} }))
    span.end()
  }))))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  for (const span of spans) {
    const mobile = span.name.startsWith('mobile')
    assert.equal(span.attributes['mikka.client_kind'], mobile ? 'mobile' : 'web')
    assert.equal(span.attributes['mikka.app.version'], mobile ? '1.0.0' : undefined)
  }
  const request = new Request('https://mikka.test', { headers: mobileTraceHeaders('1.0.0') })
  for (const route of ['/v1/runs/[runId]/events', '/api/cron/recover', '/api/webhooks/github', '/api/runs/mcp/github']) assert.deepEqual(requestClientAttributes(request, route), {})
})

test('untrusted version and unrelated request headers never enter spans', async () => {
  memory.reset()
  const privateValues = ['alice@example.com', '/Users/alex/private', '1.0.0-secret-token']
  const tracer = provider.getTracer('client-privacy')
  for (const version of privateValues) {
    await context.with(ROOT_CONTEXT, () => tracer.startActiveSpan('request', async span => {
      await withRequestLog('/api/issues', () => new Response('{}'), () => {})(new Request('https://mikka.test/api/issues', { headers: { 'x-mikka-client-kind': 'mobile', 'x-mikka-app-version': version, authorization: 'Bearer private-token', cookie: 'session=private-cookie' } }))
      span.end()
    }))
  }
  await provider.forceFlush()
  const payload = JSON.stringify(memory.getFinishedSpans().map(span => ({ attributes: span.attributes, name: span.name })))
  for (const value of [...privateValues, 'private-token', 'private-cookie']) assert.equal(payload.includes(value), false)
  for (const span of memory.getFinishedSpans()) assert.equal(span.attributes['mikka.app.version'], undefined)
})

test('a failed request records its error code on the span, never the message', async () => {
  memory.reset()
  const tracer = provider.getTracer('client-errors')
  await context.with(ROOT_CONTEXT, () => tracer.startActiveSpan('POST /api/issues', async span => {
    const handler = withRequestLog('/api/issues', () => { throw new CodedError('issue_create_failed', { detail: 'missing_title', cause: new Error('alice@example.com said hi') }) }, () => {})
    await assert.rejects(handler(new Request('https://mikka.test/api/issues', { method: 'POST' })))
    span.end()
  }))
  await provider.forceFlush()
  const [span] = memory.getFinishedSpans()
  assert.equal(span.status.code, 2)
  assert.equal(span.attributes['mikka.error.code'], 'issue_create_failed')
  assert.equal(span.attributes['mikka.error.detail'], 'missing_title')
  assert.equal(span.attributes['error.type'], 'CodedError')
  assert.equal(JSON.stringify(span.attributes).includes('alice'), false)
})

test('request attribution stays on each parent chain when concurrent requests share a trace', async () => {
  memory.reset()
  const tracer = provider.getTracer('request-attribution')
  const sharedParent = propagation.extract(ROOT_CONTEXT, { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' })
  const logs: string[] = []
  let entered = 0, release!: () => void
  const bothStarted = new Promise<void>(resolve => { release = resolve })
  await Promise.all(['one', 'two'].map(name => context.with(sharedParent, () => tracer.startActiveSpan(name, { kind: SpanKind.SERVER }, async root => {
    const actionName = name === 'one' ? 'fixture.read' : 'model-order.getModelOrder'
    await withRequestLog('/api/desktop/rpc', async request => {
      tracer.startSpan(`${name}:before-auth-query`).end()
      if (++entered === 2) release()
      await bothStarted
      return tracer.startActiveSpan(`${name}:auth`, async auth => {
        try {
          noteLogUser(`PRIVATE_USER_${name}`)
          tracer.startSpan(`${name}:after-auth-query`).end()
          return await dispatchRpc({ scope: async (_session, work) => work(), actions: {
            [actionName]: { args: z.tuple([z.string()]), invoke: async () => {
              tracer.startSpan(`${name}:action-query`).end()
              return 'PRIVATE_RESPONSE'
            } },
          } }, request, {})
        } finally { auth.end() }
      })
    }, line => { logs.push(line) })(new Request('https://mikka.test/api/desktop/rpc?private=PRIVATE_QUERY', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-vercel-id': 'shared-external-id',
        authorization: 'Bearer PRIVATE_TOKEN', cookie: 'PRIVATE_COOKIE', 'mikka.request_id': 'forged-request-id' },
      body: JSON.stringify({ version: 1, action: actionName, args: ['PRIVATE_ARGUMENT'] }),
    }))
    root.end()
  }))))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans()
  assert.equal(spans.length, 10)
  assert.equal(new Set(spans.map(span => span.spanContext().traceId)).size, 1)
  const requestIds = new Set<unknown>()
  for (const name of ['one', 'two']) {
    const actionName = name === 'one' ? 'fixture.read' : 'model-order.getModelOrder'
    const root = spans.find(span => span.name === name)!
    const id = root.attributes['mikka.request_id']
    requestIds.add(id)
    assert.match(String(id), /^[0-9a-f-]{36}$/)
    assert.equal(root.attributes['mikka.user_id_hash'], hashUserId(`PRIVATE_USER_${name}`))
    assert.equal(root.attributes['mikka.rpc.action'], actionName)
    for (const span of spans.filter(span => span.name.startsWith(`${name}:`))) assert.equal(span.attributes['mikka.request_id'], id)
    const early = spans.find(span => span.name === `${name}:before-auth-query`)!
    assert.equal(early.attributes['mikka.user_id_hash'], undefined)
    assert.equal(early.attributes['mikka.rpc.action'], undefined)
    const authenticated = spans.find(span => span.name === `${name}:after-auth-query`)!
    assert.equal(authenticated.attributes['mikka.user_id_hash'], root.attributes['mikka.user_id_hash'])
    assert.equal(authenticated.attributes['mikka.rpc.action'], undefined)
    const action = spans.find(span => span.name === `${name}:action-query`)!
    assert.equal(action.attributes['mikka.user_id_hash'], root.attributes['mikka.user_id_hash'])
    assert.equal(action.attributes['mikka.rpc.action'], actionName)
    const completion = logs.map(line => JSON.parse(line)).find(entry => entry.msg === 'api_request' && entry.invocationId === id)
    assert.equal(completion.userIdHash, root.attributes['mikka.user_id_hash'])
    assert.equal(completion.rpcAction, actionName)
  }
  assert.equal(requestIds.size, 2)
  const payload = JSON.stringify(spans.map(span => ({ attributes: span.attributes, events: span.events })))
  assert.doesNotMatch(payload, /PRIVATE_|shared-external-id|forged-request-id/)
})

test('request attribution channel projects only valid closed metadata', async () => {
  memory.reset()
  const metadata = channel('mikka.request.metadata')
  await context.with(ROOT_CONTEXT, () => provider.getTracer('request-attribution-privacy').startActiveSpan('request', span => {
    metadata.publish({ requestId: 'PRIVATE_ID', userIdHash: '0123456789abcdef', rpcAction: 'fixture.read' })
    metadata.publish({ requestId: '11111111-1111-4111-8111-111111111111', userIdHash: 'private@example.com', rpcAction: 'https://private.test',
      userId: 'PRIVATE_USER', authorization: 'PRIVATE_TOKEN', body: 'PRIVATE_BODY' })
    span.end()
  }))
  await provider.forceFlush()
  const [span] = memory.getFinishedSpans()
  assert.equal(span.attributes['mikka.request_id'], '11111111-1111-4111-8111-111111111111')
  assert.equal(span.attributes['mikka.user_id_hash'], undefined)
  assert.equal(span.attributes['mikka.rpc.action'], undefined)
  assert.doesNotMatch(JSON.stringify(span.attributes), /PRIVATE_|private@example|private\.test/)
})

test('read-batch actions retain separate parent chains and one physical request identity', async () => {
  assert.equal(typeof requestLog.withRpcActionLog, 'function')
  memory.reset()
  const tracer = provider.getTracer('read-batch-attribution')
  const logs: string[] = []
  let entered = 0, release!: () => void
  const bothStarted = new Promise<void>(resolve => { release = resolve })
  await context.with(ROOT_CONTEXT, () => tracer.startActiveSpan('physical-read-batch', { kind: SpanKind.SERVER }, async root => {
    await withRequestLog('/api/desktop/rpc', async () => {
      noteLogUser('PRIVATE_BATCH_OWNER')
      requestLog.noteLogRpcAction('desktop.readBatch')
      const values = await Promise.all(['task-runs.pollTaskRuns', 'issues.syncIssueList'].map(action => requestLog.withRpcActionLog(action, async () => {
        if (++entered === 2) release()
        await bothStarted
        tracer.startSpan(`query:${action}`).end()
        return { status: 200, privateValue: 'PRIVATE_RESULT' }
      }, value => value.status)))
      assert.ok(values.every(value => value.privateValue === 'PRIVATE_RESULT'))
      tracer.startSpan('after-batch-query').end()
      return new Response('{}')
    }, line => { logs.push(line) })(new Request('https://mikka.test/api/desktop/rpc', { method: 'POST', body: 'PRIVATE_ARGUMENTS' }))
    root.end()
  }))
  await provider.forceFlush()
  const spans = memory.getFinishedSpans(), roots = spans.filter(span => span.name === 'physical-read-batch')
  assert.equal(roots.length, 1)
  const root = roots[0], physicalId = root.attributes['mikka.request_id']
  assert.equal(root.attributes['mikka.rpc.action'], 'desktop.readBatch')
  for (const action of ['task-runs.pollTaskRuns', 'issues.syncIssueList']) {
    const child = spans.find(span => span.name === 'rpc.action' && span.attributes['mikka.rpc.action'] === action)!
    const query = spans.find(span => span.name === `query:${action}`)!
    assert.ok(child)
    assert.equal(child.parentSpanContext?.spanId, root.spanContext().spanId)
    assert.equal(query.parentSpanContext?.spanId, child.spanContext().spanId)
    for (const span of [child, query]) {
      assert.equal(span.attributes['mikka.rpc.action'], action)
      assert.equal(span.attributes['mikka.request_id'], physicalId)
      assert.equal(span.attributes['mikka.user_id_hash'], hashUserId('PRIVATE_BATCH_OWNER'))
      assert.notEqual(span.attributes['mikka.trace.critical'], true)
    }
  }
  assert.equal(spans.find(span => span.name === 'after-batch-query')?.attributes['mikka.rpc.action'], 'desktop.readBatch')
  const entries = logs.map(line => JSON.parse(line))
  assert.equal(entries.filter(entry => entry.msg === 'api_request_started').length, 1)
  assert.equal(entries.filter(entry => entry.msg === 'api_request').length, 1)
  const started = entries.filter(entry => entry.msg === 'rpc_action_started'), completed = entries.filter(entry => entry.msg === 'rpc_action')
  assert.equal(started.length, 2); assert.equal(completed.length, 2)
  assert.equal(new Set(completed.map(entry => entry.invocationId)).size, 2)
  for (const end of completed) {
    assert.equal(end.httpInvocationId, physicalId)
    assert.equal(end.route, '/api/desktop/rpc')
    assert.equal(end.status, 200)
    assert.equal(started.find(entry => entry.invocationId === end.invocationId)?.rpcAction, end.rpcAction)
  }
  assert.doesNotMatch(JSON.stringify({ entries, spans: spans.map(span => span.attributes) }), /PRIVATE_/)
})

test('read-batch failures retain error status without exporting payloads or forcing ordinary sampling', async () => {
  assert.equal(typeof requestLog.withRpcActionLog, 'function')
  memory.reset()
  const logs: string[] = [], privateError = new CodedError('read_failed', { detail: 'unavailable', cause: new Error('PRIVATE_CAUSE') })
  const tracer = provider.getTracer('read-batch-failure')
  await context.with(ROOT_CONTEXT, () => tracer.startActiveSpan('physical', async root => {
    await withRequestLog('/api/desktop/rpc', async () => {
      requestLog.noteLogRpcAction('desktop.readBatch')
      const value = await requestLog.withRpcActionLog('issues.syncIssueList', async () => ({ status: 403, privateValue: 'PRIVATE_VALUE' }), result => result.status)
      assert.equal(value.privateValue, 'PRIVATE_VALUE')
      await assert.rejects(requestLog.withRpcActionLog('task-runs.pollTaskRuns', async () => { throw privateError }), error => error === privateError)
      return new Response('{}')
    }, line => { logs.push(line) })(new Request('https://mikka.test/api/desktop/rpc', { method: 'POST' }))
    root.end()
  }))
  await provider.forceFlush()
  const actions = memory.getFinishedSpans().filter(span => span.name === 'rpc.action')
  assert.equal(actions.length, 2)
  assert.ok(actions.every(span => span.status.code === 2 && span.attributes['mikka.trace.critical'] !== true))
  assert.equal(actions.find(span => span.attributes['mikka.rpc.action'] === 'task-runs.pollTaskRuns')?.attributes['mikka.error.code'], 'read_failed')
  const entries = logs.map(line => JSON.parse(line)).filter(entry => entry.msg === 'rpc_action')
  assert.deepEqual(entries.map(entry => entry.status), [403, 500])
  assert.doesNotMatch(JSON.stringify({ entries, actions: actions.map(span => span.attributes) }), /PRIVATE_/)
  const result = await withRequestLog('/api/desktop/rpc', () => requestLog.withRpcActionLog('issues.syncIssueList', async () => new Response('ok')), () => { throw new Error('sink failure') })(new Request('https://mikka.test/api/desktop/rpc', { method: 'POST' }))
  assert.equal(result.status, 200)
})
