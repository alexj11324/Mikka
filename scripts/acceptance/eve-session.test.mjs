import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Client } from 'eve/client'
import { observeEveSession, submitEveMessage } from './eve-session.mjs'
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

test('a stream lease ending resumes the same session at the next line until the boundary', async () => {
  const paths = [], observed = []
  const [requested, settled] = facts.map(fact => JSON.stringify({ at: '2026-11-11T00:00:00.000Z', facts: [fact] }))
  const bodies = [`{"$eve":"heartbeat"}\n${requested}\n{"$eve":"stream.lease-ended"}\n`, `${settled}\n`]
  const client = { request: async (path, init) => {
    paths.push(path)
    return init?.method === 'POST' ? Response.json({ ok: true, sessionId: 'wrun_fixture' }) : new Response(bodies.shift(), { headers: eveHeaders })
  } }
  const result = await observeEveSession(client, botId, { onEvent: event => { observed.push(event.type); return event.type === 'call.settled' } })
  assert.deepEqual(observed, ['call.requested', 'call.settled'])
  assert.deepEqual(paths.slice(1).map(path => path.split('startIndex=')[1]), ['0', '1'])
  assert.deepEqual(result, { sessionId: 'wrun_fixture', nextIndex: 2 })
})

test('stream.ended ends observation without another connection', async () => {
  const paths = []
  const client = { request: async (path, init) => {
    paths.push(path)
    return init?.method === 'POST' ? Response.json({ ok: true, sessionId: 'wrun_fixture' }) : new Response('{"$eve":"stream.ended"}\n', { headers: eveHeaders })
  } }
  assert.deepEqual(await observeEveSession(client, botId), { sessionId: 'wrun_fixture', nextIndex: 0 })
  assert.equal(paths.length, 2)
})

test('native submission preserves UUID, selected context and tracing and requires accepted delivery', async () => {
  const submissionId = '11111111-1111-4111-8111-111111111111'
  const context = { profileId: 'builtin', taskDestination: { kind: 'cloud' }, expectedOwnerId: 'owner' }
  const client = { async request(path, init) {
    assert.equal(path, '/api/agents/eve/v1/session?botId=bot')
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['x-mikka-submission-id'], submissionId)
    assert.equal(init.headers.traceparent, 'trace')
    assert.deepEqual(JSON.parse(init.body), { message: 'dispatch', clientContext: context })
    return Response.json({ ok: true, sessionId: 'wrun_test', deliveryId: 'delivery_test' }, { status: 202 })
  } }
  assert.equal((await submitEveMessage(client, 'bot', 'dispatch', submissionId, context, { traceparent: 'trace' })).deliveryId, 'delivery_test')
  for (const [status, body] of [[200, { ok: true, sessionId: 'wrun_test', deliveryId: 'delivery_test' }],
    [202, { ok: true, sessionId: 'wrun_test' }], [409, { error: 'submissionConflict' }]]) {
    await assert.rejects(submitEveMessage({ request: async () => Response.json(body, { status }) }, 'bot', 'dispatch', submissionId), { httpStatus: status })
  }
})

test('personal default submission omits the bot selector and reuses the operation UUID', async () => {
  const submissionId = '11111111-1111-4111-8111-111111111111'
  const requests = []
  const client = { async request(path, init) {
    requests.push({ path, id: init.headers['x-mikka-submission-id'], body: JSON.parse(init.body) })
    return Response.json({ ok: true, sessionId: 'wrun_default', deliveryId: 'delivery_default' }, { status: 202 })
  } }
  for (let i = 0; i < 2; i++) await submitEveMessage(client, null, 'files', submissionId, { expectedOwnerId: 'owner' })
  assert.deepEqual(requests, Array(2).fill({ path: '/api/agents/eve/v1/session', id: submissionId,
    body: { message: 'files', clientContext: { expectedOwnerId: 'owner' } } }))
})
