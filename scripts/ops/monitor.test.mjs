import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { actionableAlerts, internalSink, notifyAlerts, requestSlis } from './monitor.mjs'
import { withRequestLog } from '../../lib/request-log.ts'

const now = Date.parse('2026-10-31T12:00:00Z')
const start = (id, route = '/api/auth/[...all]') => ({ msg: 'api_request_started', invocationId: id, route, timestamp: new Date(now - 180_000).toISOString() })
const end = (id, status, durationMs = 500) => ({ ...start(id), msg: 'api_request', status, durationMs })

test('started, failed, 429 and overdue unfinished requests share the denominator; raw payloads never enter metrics', () => {
  const result = requestSlis([start('ok'), end('ok', 200), start('failed'), end('failed', 500), start('limited'), end('limited', 429), start('killed'),
    { ...start('fresh'), timestamp: new Date(now - 1_000).toISOString() }, { ...start('outside'), timestamp: new Date(now - 3_600_000).toISOString() },
    { ...end('orphan', 200), body: 'SECRET' }, 'malformed'], now)
  assert.deepEqual(result.login, { total: 4, successful: 1, timedOut: 1, rateLimited: 1, successRatio: .25, p95Ms: 500 })
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  const alerts = actionableAlerts({ requests: result, database: { databaseAvailable: 1, staleWake: 2, uncertainEffect: 1, dueTotal: 2, dueSuccessful: 1, dispatchTotal: 2, dispatchStarted: 0 } })
  assert.deepEqual(alerts.map(alert => alert.id), ['staleWake', 'uncertainEffect', 'due-on-time', 'dispatch-start', 'login-request-success'])
  assert.equal(actionableAlerts({ requests: {}, database: { databaseAvailable: 0 } })[0].id, 'database-unavailable')
})

test('real internal HTTP sink receives one firing and recovery; failed sink remains visible and retryable', async () => {
  const received = []
  let refuse = false
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    received.push(JSON.parse(body)); response.writeHead(refuse ? 503 : 204); response.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const sink = `http://127.0.0.1:${server.address().port}/internal-alerts`
    const alerts = actionableAlerts({ requests: {}, database: { databaseAvailable: 0 } })
    let result = await notifyAlerts(alerts, { sink, now })
    assert.equal(result.healthy, true); assert.equal(received.length, 1)
    result = await notifyAlerts(alerts, { sink, now: now + 60_000, state: result.state })
    assert.equal(received.length, 1)
    result = await notifyAlerts([], { sink, now: now + 120_000, state: result.state })
    assert.equal(received.at(-1).state, 'resolved')
    refuse = true
    result = await notifyAlerts(alerts, { sink, now: now + 180_000, state: result.state })
    assert.equal(result.healthy, false)
    const before = received.length
    result = await notifyAlerts(alerts, { sink, now: now + 180_001, state: result.state })
    assert.equal(received.length, before + 1); assert.equal(result.healthy, false)
    refuse = false
    result = await notifyAlerts(alerts, { sink, now: now + 180_002, state: result.state })
    assert.equal(result.healthy, true)
    assert.deepEqual(Object.keys(received[0]).sort(), ['action', 'id', 'observedAt', 'owner', 'runbook', 'state', 'value', 'version'])
  } finally { await new Promise(resolve => server.close(resolve)) }
  for (const url of ['https://example.com/alerts', 'http://localhost/alerts', 'http://user:secret@127.0.0.1/alerts']) assert.throws(() => internalSink(url), /opsInternalSinkRequired/)
})

test('real HTTP status and failure logs feed the request SLI without copying request data', async () => {
  const lines = [], marker = 'never-log-request-or-provider-data'
  const handler = withRequestLog('/api/coordinator/messages', async request => {
    if (new URL(request.url).pathname === '/failed') throw Error(marker)
    return new Response(null, { status: new URL(request.url).pathname === '/limited' ? 429 : 200 })
  }, line => lines.push(line))
  const server = createServer(async (request, response) => {
    try {
      const result = await handler(new Request(`http://127.0.0.1${request.url}`, { headers: request.headers }))
      response.writeHead(result.status); response.end()
    } catch { response.writeHead(500); response.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    for (const [path, status] of [['/ok', 200], ['/limited', 429], ['/failed', 500]])
      assert.equal((await fetch(`${origin}${path}?sensitive=${marker}`, { headers: { authorization: `Bearer ${marker}`, cookie: `session=${marker}` } })).status, status)
    // Observe the source logger's actual start/completion pairs in an eligible
    // window; this is an HTTP component fixture, not a real provider/business run.
    const metric = requestSlis(lines, Date.now() + 180_000).chat
    assert.equal(metric.total, 3); assert.equal(metric.successful, 1); assert.equal(metric.rateLimited, 1); assert.equal(metric.timedOut, 0)
    assert.equal(metric.successRatio, 1 / 3)
    assert.equal(actionableAlerts({ requests: { chat: metric }, database: { databaseAvailable: 1 } })[0].id, 'chat-request-success')
    assert.ok(!lines.join('\n').includes(marker))
  } finally { await new Promise(resolve => server.close(resolve)) }
})
