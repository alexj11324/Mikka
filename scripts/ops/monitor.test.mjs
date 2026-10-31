import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { actionableAlerts, internalSink, notifyAlerts, requestSlis } from './monitor.mjs'

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
