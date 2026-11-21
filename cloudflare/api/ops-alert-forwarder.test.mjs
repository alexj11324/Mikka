import assert from 'node:assert/strict'
import test from 'node:test'
import { internalSink, notifyAlerts, operationalAlertAssessment } from '../../scripts/ops/monitor.mjs'
import { applicationEnvironment } from './ingress/environment.mjs'
import { configureOpsAlertForwarder } from './ops-alert-forwarder.mjs'

const webhook = 'https://hooks.slack.com/services/T00000000/B00000000/FIXTURE_ONLY'
const now = Date.parse('2026-11-21T12:00:00Z')

test('hosted monitor sends firing and recovery through loopback and retries provider failure', async t => {
  const env = applicationEnvironment({ OPS_ALERT_SLACK_WEBHOOK_URL: webhook })
  const realFetch = globalThis.fetch, sent = []
  let status = 429
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(String(url), webhook)
    assert.equal(options.redirect, 'error')
    assert.equal(options.method, 'POST')
    sent.push(JSON.parse(options.body))
    return Promise.resolve(new Response('provider response must not be copied', { status }))
  })
  const server = await configureOpsAlertForwarder(env)
  t.after(() => new Promise(resolve => server.close(resolve)))
  const sink = env.OPS_INTERNAL_ALERT_SINK
  assert.equal(internalSink(sink).hostname, '127.0.0.1')
  assert.equal(Object.hasOwn(env, 'OPS_ALERT_SLACK_WEBHOOK_URL'), false)
  const { alerts, assessed } = operationalAlertAssessment({ requests: {}, database: { databaseAvailable: 0 } })
  const [alert] = alerts
  const notify = (events, state, time) => notifyAlerts(events, { assessed, state, now: time, sink, fetchImpl: realFetch })
  const firing = [{ ...alert, action: 'private data', runbook: 'https://untrusted.example/<@channel>' }]
  const failed = await notify(firing, {}, now)
  assert.equal(failed.healthy, false)
  assert.equal(failed.state[alert.id].lastSent, undefined)
  status = 200
  const retried = await notify(firing, failed.state, now + 1)
  assert.equal(retried.healthy, true)
  assert.equal(retried.state[alert.id].lastSent, now + 1)
  assert.equal((await notify([], retried.state, now + 2)).healthy, true)
  assert.equal(sent.length, 3)
  assert.match(sent[1].text, /FIRING.*database-unavailable/)
  assert.match(sent[2].text, /RESOLVED.*database-unavailable/)
  assert.doesNotMatch(JSON.stringify(sent), /private data|untrusted\.example|provider response|FIXTURE_ONLY/)
})

test('relay is opt-in and rejects an invalid destination without retaining it in the error', async () => {
  const env = applicationEnvironment({})
  assert.equal(await configureOpsAlertForwarder(env), undefined)
  assert.equal(env.OPS_INTERNAL_ALERT_SINK, undefined)
  for (const bad of ['http://hooks.slack.com/services/T/B/TEST', 'https://hooks.slack.com.example/services/T/B/TEST',
    'https://hooks.slack.com/services/T/B/TEST?destination=example', 'https://hooks.slack.com/services/T/B/TEST\n']) {
    await assert.rejects(configureOpsAlertForwarder({ OPS_ALERT_SLACK_WEBHOOK_URL: bad }), { message: 'opsAlertSlackWebhookInvalid' })
  }
})

test('only bounded JSON at the private loopback path reaches the provider', async t => {
  const env = { OPS_ALERT_SLACK_WEBHOOK_URL: webhook }
  const realFetch = globalThis.fetch
  const outbound = t.mock.method(globalThis, 'fetch', () => Promise.resolve(new Response('ok')))
  const server = await configureOpsAlertForwarder(env)
  t.after(() => new Promise(resolve => server.close(resolve)))
  const sink = env.OPS_INTERNAL_ALERT_SINK
  const headers = { 'content-type': 'application/json' }
  const event = { version: 1, id: 'bad id <@channel>', state: 'firing', observedAt: new Date(now).toISOString(), value: 1 }
  assert.equal((await realFetch(new URL('/alerts', sink), { method: 'POST', headers, body: JSON.stringify(event) })).status, 404)
  assert.equal((await realFetch(sink)).status, 405)
  assert.equal((await realFetch(sink, { method: 'POST', headers, body: '{' })).status, 400)
  assert.equal((await realFetch(sink, { method: 'POST', headers, body: JSON.stringify(event) })).status, 400)
  const chunks = new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(4097, 32)); c.close() } })
  assert.equal((await realFetch(sink, { method: 'POST', headers, body: chunks, duplex: 'half' })).status, 413)
  assert.equal(outbound.mock.callCount(), 0)
})
