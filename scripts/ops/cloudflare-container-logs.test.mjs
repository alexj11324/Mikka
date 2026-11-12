import assert from 'node:assert/strict'
import test from 'node:test'
import { readContainerWindow, collectContainerReports } from './cloudflare-container-logs.mjs'
import { publish } from './egress-monitor.mjs'
import { WINDOW_MS } from './request-outcomes.mjs'

const id = 'd2364de7-f356-4fd6-b73f-604064ef68ff'
const apiVersion = 'bf586107-988a-42d1-9367-3e74ecfebe67'
const now = Date.parse('2026-11-10T18:00:00Z')
const start = now - WINDOW_MS
const scope = { source: 'a'.repeat(40), apiVersion, application: id, environment: 'staging' }
const outcomeRoute = '/v1/devices/[deviceId]/commands'
function event(msg, number, timestamp, extra) {
  return { dataset: 'containers', timestamp, $metadata: { id: String(number), type: 'cf-container', service: id },
    $containers: { applicationId: id, deploymentId: 'f'.repeat(64) },
    source: { msg, invocationId: 'request-1', timestamp: new Date(timestamp).toISOString(), route: outcomeRoute, ...extra } }
}
const raw = [
  event('api_request_started', 1, start + 1000, { rawUserData: 'REDACT-THIS' }),
  event('api_request', 2, start + 1100, { outcome: 'work', status: 200 }),
  event('db_sample', 3, start + 1020, { statement: 'abcdef123456', bytes: 600, rows: 2, sampleRate: 0.5, sql: 'REDACT-THIS' }),
]
function page(events, count = events.length) { return { events: { count, events }, statistics: { abr_level: 1 } } }
const options = { environment: 'staging', application: id.replaceAll('-', ''), now }
test('one scoped Container query feeds the existing outcome and egress consumers; private application logs remain local', async () => {
  let reads = 0, targets = 0
  const read = async query => {
    reads++
    assert.deepEqual(query.timeframe, { from: start, to: now })
    assert.deepEqual(query.parameters, { datasets: ['containers'], filters: [{ key: '$metadata.service', type: 'string', operation: 'eq', value: id }] })
    return page(raw)
  }
  const result = await collectContainerReports({ target: () => {targets++; return scope}, read, now })
  assert.equal(reads, 1)
  assert.equal(targets, 2)
  assert.equal(result.outcomes.status, 'pass')
  assert.equal(result.outcomes.outcomes[outcomeRoute].work, 1)
  assert.equal(result.outcomes.coverage.missingCompletions, 0)
  assert.equal(result.egress.runtime.requests[0].count, 1)
  assert.equal(result.egress.runtime.queries[0].estimatedBytes, 1200)
  assert.deepEqual(result.egress.reasons, ['neon_token_unavailable'])
  assert.ok(!JSON.stringify(result).includes('REDACT-THIS'))
  await assert.rejects(publish(result.egress,'unused',()=>assert.fail()), /production_telemetry_required/)
})
test('a full native page is subdivided and deduplicated at the shared millisecond; an inseparable burst fails closed', async () => {
  const mid = start + WINDOW_MS / 2
  const row = event('api_request_started', 4, mid)
  const read = ({timeframe}) => timeframe.from === start && timeframe.to === now ?
    page(Array(1000).fill(row)) : page([row])
  const window = await readContainerWindow({ ...options, read })
  assert.equal(window.pages, 3)
  assert.equal(window.events.length, 1)
  await assert.rejects(readContainerWindow({ ...options, read: () => page(Array(1000).fill(row)) }), /saturated|budget_exceeded/)
})
test('scope, provider omissions and truncated rows cannot turn into a healthy zero', async () => {
  for (const bad of [
    { ...raw[0], dataset: 'cloudflare-workers' },
    { ...raw[0], $metadata: { ...raw[0].$metadata, service: 'other' } },
    { ...raw[0], $containers: { ...raw[0].$containers, applicationId: 'other' } },
    { ...raw[0], timestamp: now + 1 },
    { ...raw[0], source: 'partial {"msg":"api_request"' },
    { ...raw[0], $metadata: { ...raw[0].$metadata, truncated: true } },
  ]) await assert.rejects(readContainerWindow({ ...options, read: () => page([bad]) }))
  await assert.rejects(readContainerWindow({ ...options, read: () => ({ events: { events: [], count: 0 }, statistics: { abr_level: 4 } }) }))
  await assert.rejects(readContainerWindow({ ...options, read: () => page([raw[0], { ...raw[0], source: { ...raw[0].source, status: 201 } }]) }), /id_conflict/)
  for (const changed of [{source:'b'.repeat(40)},{application:apiVersion},{apiVersion:id},{environment:'production'}]) {
    let i=0
    await assert.rejects(collectContainerReports({ target:()=>i++ ? {...scope,...changed} : scope, read:()=>page(raw), now }), /release_changed/)
  }
})

test('one native observation window retains the login/chat/API deadlines and thresholds', async () => {
  const rows = []
  const add = (route, invocationId, offset, status, durationMs) => {
    const at = start + offset
    rows.push(event('api_request_started', rows.length + 1, at, { route, invocationId }))
    if (status !== null) rows.push(event('api_request', rows.length + 1, at + durationMs,
      { route, invocationId, status, durationMs }))
  }
  add('/api/auth/[...all]', 'login-ok', 1000, 200, 11000)
  add('/api/auth/[...all]', 'login-limited', 2000, 429, 5)
  add('/api/coordinator/messages', 'chat-timeout', 3000, null, 0)
  add('/api/other', 'api-ok', 4000, 204, 13)
  add('/api/other', 'last-minute', WINDOW_MS - 30000, 200, 60000)
  add('/api/other', 'next-window', WINDOW_MS + 1000, 200, 10)
  let logs = 0, metrics = 0
  const result = await collectContainerReports({
    target: () => scope, read: ({timeframe}) => {
      assert.deepEqual(timeframe, { from: start, to: now + 120000 })
      logs++; return page(rows)
    }, now, observedAt: now + 120000,
    capacity: { account: 'a'.repeat(32), read: () => {
      metrics++
      return { data: { viewer: { accounts: [{ usage: [], memory: [] }] } } }
    } },
  })
  assert.equal(logs, 1)
  assert.equal(metrics, 1)
  const health = result.health.requestHealth
  assert.deepEqual(health.requests.login, { total: 2, successful: 1, timedOut: 0, rateLimited: 1, successRatio: .5, p95Ms: 11000 })
  assert.deepEqual(health.requests.chat, { total: 1, successful: 0, timedOut: 1, rateLimited: 0, successRatio: 0, p95Ms: null })
  assert.equal(health.status, 'observed')
  assert.equal(result.outcomes.records, rows.filter(row => row.timestamp < now).length)
  assert.equal(health.requests.api.total, 2)
  assert.equal(health.requests.api.successful, 2)
  assert.deepEqual(health.alerts.map(a => a.id).sort(), ['api-request-latency','chat-request-success','login-request-latency','login-request-success'])
  assert.ok(!health.assessed.includes('chat-request-latency'))
  assert.deepEqual(health.assessed.filter(id => id.startsWith('api-')).sort(), ['api-request-latency','api-request-success'])
})
