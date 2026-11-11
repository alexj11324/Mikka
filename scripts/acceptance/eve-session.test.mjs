import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client } from 'eve/client'
import { observeEveSession } from './eve-session.mjs'
import { eveHeaders, eveResponse, nativeCall } from '../../tests/support/eve-acceptance.mjs'

const botId = '10000000-0000-4000-8000-000000000001'
const facts = nativeCall('call_1', { issueId: botId, note: 'exact request' }, { runId: botId, details: 'x'.repeat(500) })

test('operational reader consumes native facts, preserves full receipts and cancels the live stream after its boundary', async () => {
  const paths = [], events = []
  let cancelled = false
  const transport = { request: async (path, init) => {
    paths.push(path)
    if (init?.method === 'POST') { assert.deepEqual(JSON.parse(init.body), {}); return Response.json({ ok: true, sessionId: 'wrun_fixture' }) }
    const bytes = await eveResponse(facts).arrayBuffer()
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes)) }, cancel() { cancelled = true } }), { headers: eveHeaders })
  } }
  const result = await observeEveSession(transport, botId, { onEvent: event => { events.push(event); return event.type === 'call.settled' } })
  assert.deepEqual(result, { sessionId: 'wrun_fixture', nextIndex: 2 })
  assert.equal(events[1].data.output.details.length, 500, 'full output is the evidence, never the retired preview')
  assert.deepEqual(events.map(event => event.meta.position), [{ line: 0, index: 0 }, { line: 1, index: 0 }])
  assert.deepEqual(paths, [`/api/agents/eve/v1/session?botId=${botId}`, `/api/agents/eve/v1/session/wrun_fixture/stream?botId=${botId}&startIndex=0`])
  assert.equal(cancelled, true)
})

test('fixtures are accepted by the pinned public Eve Client and preserve native positions', async t => {
  const native = eveResponse(facts)
  const payload = await native.text()
  const server = createServer((request, response) => {
    assert.match(request.url, /^\/eve\/v1\/session\/wrun_fixture\/stream\?/)
    response.writeHead(200, { ...eveHeaders, 'x-eve-stream-tail-index': '1' }); response.end(payload)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const client = new Client({ baseUrl: `http://127.0.0.1:${server.address().port}` })
  const events = []
  for await (const event of client.sessions.attach('wrun_fixture').stream({ follow: false, reconnect: false })) events.push(event)
  assert.deepEqual(events.map(event => [event.type, event.data.callId, event.meta.position]), [
    ['call.requested', 'call_1', { line: 0, index: 0 }], ['call.settled', 'call_1', { line: 1, index: 0 }],
  ])
})

for (const [name, response, code] of [
  ['version mismatch', () => eveResponse(facts, { 'x-eve-stream-version': '26' }), 'version'],
  ['retired projected event', () => new Response('{"type":"tool","name":"dispatch_run"}\n', { headers: eveHeaders }), 'invalid'],
  ['truncated native JSON', () => new Response('{"facts":', { headers: eveHeaders }), 'invalid'],
]) test(`operational reader rejects ${name}`, async () => {
  const client = { request: async (_path, init) => init?.method === 'POST' ? Response.json({ ok: true, sessionId: 'wrun_fixture' }) : response() }
  await assert.rejects(observeEveSession(client, botId), new RegExp(code))
})


test('native progress advances line cursors and a new mapped session rewinds only its own stream', async () => {
  const paths = []
  const progress = JSON.stringify({ progress: { type: 'call.input', data: { callId: 'call_1', delta: '{}' } } })
  const bytes = progress + '\n' + await eveResponse(facts).text()
  const client = { request: async (path, init) => {
    paths.push(path)
    return init?.method === 'POST' ? Response.json({ ok: true, sessionId: 'wrun_new' }) : new Response(bytes, { headers: eveHeaders })
  } }
  const observed = []
  const result = await observeEveSession(client, botId, { previousSessionId: 'wrun_old', startIndex: 50, onEvent: event => { observed.push(event); return event.type === 'call.settled' } })
  assert.match(paths[1], /startIndex=0$/)
  assert.deepEqual(observed.map(event => event.meta.position.line), [1, 2])
  assert.equal(result.nextIndex, 3)
})
