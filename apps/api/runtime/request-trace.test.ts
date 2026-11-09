import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, before, test } from 'node:test'
import { context, propagation, trace } from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import { AlwaysOnSampler, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { createMikkaMcpBackend } from '../../../packages/daemon/src/agents/mikka-mcp-backend.mjs'
import { beginRequestTrace } from './request-trace'

const memory = new InMemorySpanExporter()
const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [new SimpleSpanProcessor(memory)] })
before(() => provider.register({ propagator: new W3CTraceContextPropagator() }))
after(async () => { await provider.shutdown(); trace.disable(); context.disable(); propagation.disable() })
const catalogue = JSON.stringify({ version: 1, tool: { name: 'record_decision', title: 'Record decision',
  description: 'Synthetic tracing fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } } })

for (const flags of ['01', '00']) test(`Decision backend HTTP preserves its daemon parent at the API boundary (flags ${flags})`, async () => {
  memory.reset()
  const parent = `00-11111111111111111111111111111111-2222222222222222-${flags}`
  const observed: { traceparent: string | undefined; baggage: string | undefined }[] = []
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    observed.push({ traceparent: incoming.headers.traceparent as string | undefined, baggage: incoming.headers.baggage as string | undefined })
    const request = new Request('https://mikka.test/api/mcp', { method: 'POST', headers: {
      ...(incoming.headers.traceparent ? { traceparent: String(incoming.headers.traceparent) } : {}),
      authorization: String(incoming.headers.authorization ?? ''),
    } })
    const active = beginRequestTrace(request, '/api/mcp')
    active.run(() => trace.getTracer('mcp-fixture').startSpan('record_decision').end())
    active.finish(200)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'recorded' }] },
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const backend = createMikkaMcpBackend({ handoffFile: '/unused-synthetic-handoff', decisionUrl: `http://127.0.0.1:${address.port}/api/mcp`,
    decisionToken: 'mkw_' + 'A'.repeat(43), decisionCatalogue: catalogue, decisionTraceparent: parent,
    env: { MIKKA_DECISION_MCP_TRACEPARENT: 'private-canary' } })
  try {
    const result = await backend.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'record_decision', arguments: { traceparent: 'private-canary', baggage: 'private-canary' } } })
    assert.equal(result.error, undefined)
    assert.notEqual(result.result?.isError, true)
    assert.deepEqual(observed, [{ traceparent: parent, baggage: undefined }])
    await provider.forceFlush()
    const spans = memory.getFinishedSpans(), request = spans.find(span => span.name === 'POST /api/mcp')
    const tool = spans.find(span => span.name === 'record_decision')
    assert.ok(request && tool)
    assert.equal(request.spanContext().traceId, parent.slice(3, 35))
    assert.equal(request.parentSpanContext?.spanId, parent.slice(36, 52))
    assert.equal(request.parentSpanContext?.traceFlags, Number.parseInt(flags, 16))
    assert.equal(tool.spanContext().traceId, request.spanContext().traceId)
    assert.equal(tool.parentSpanContext?.spanId, request.spanContext().spanId)
    assert.equal(JSON.stringify(spans.map(span => span.attributes)).includes('private-canary'), false)
    assert.equal(JSON.stringify(spans.map(span => span.attributes)).includes('mkw_'), false)
  } finally {
    await backend.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
