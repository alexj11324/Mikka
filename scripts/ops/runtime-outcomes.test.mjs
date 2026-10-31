import assert from 'node:assert/strict'
import test from 'node:test'
import { PROJECT, PRODUCTION_ALIAS, TEAM } from './deployment-regression.mjs'
import { logQuery, markdown, POLICY, readEntries, ROUTES, run } from './runtime-outcomes.mjs'

const now = Date.parse('2026-10-31T12:00:00.123Z'), deploymentId = 'dpl_active'
const alias = { alias: PRODUCTION_ALIAS, projectId: PROJECT, deploymentId, updatedAt: now - 600_000 }
const start = (id, route = ROUTES[0], at = now - 180_000) => ({ msg: 'api_request_started', invocationId: id, route, timestamp: new Date(at).toISOString() })
const end = (id, outcome = 'empty', status = 200, route = ROUTES[0]) => ({ ...start(id, route), msg: 'api_request', outcome, status })
const event = entry => ({ deploymentId, environment: 'production', message: JSON.stringify(entry), truncated: false })
const page = (entries, pagination = { hasMore: false, nextCursor: null }, meta = {}) => ({ events: entries.map(event), pagination, meta })
function fixture(pages, aliases = [alias, alias]) {
  const calls = [], queue = [...pages], targets = [...aliases]
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options })
    if (url.pathname.startsWith('/v4/aliases/')) return Response.json(targets.shift())
    const result = queue.shift()
    return result instanceof Response ? result : Response.json(result)
  } }
}

test('REST query uses exact millisecond ISO bounds, immutable production scope and minimal fields', () => {
  const query = logQuery(deploymentId, now)
  assert.deepEqual(query.timeRange, { start: '2026-10-31T11:45:00.123Z', end: '2026-10-31T12:00:00.123Z' })
  assert.deepEqual(query.scope, { ownerId: TEAM, projectIds: [PROJECT] })
  assert.deepEqual(query.select, ['deploymentId', 'environment', 'message', 'truncated'])
  assert.match(query.filter, /deploymentId:"dpl_active" AND environment:production/)
  assert.throws(() => logQuery('SECRET', now), /runtime_scope_invalid/)
})

test('bounded paginated collection retains only fixed route aggregates; duplicate lines do not double-count requests', async () => {
  const io = fixture([page([end('empty')], { hasMore: true, nextCursor: 'page2' }), page([start('empty'), start('empty'), start('work', ROUTES[1]), end('work', 'work', 200, ROUTES[1]), start('ignored', ROUTES[2]), end('ignored', 'ignored', 204, ROUTES[2]),
    { ...start('elsewhere', '/private/SECRET_PATH'), body: 'SECRET_BODY' }])])
  const report = await run({ token: 'SECRET_TOKEN', now, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'pass')
  assert.equal(report.healthy, true)
  assert.equal(report.pages, 2)
  assert.equal(report.outcomes[ROUTES[0]].count, 1)
  assert.equal(report.outcomes[ROUTES[0]].emptyRatio, 1)
  assert.equal(report.outcomes[ROUTES[1]].work, 1)
  assert.equal(report.outcomes[ROUTES[2]].ignored, 1)
  assert.equal(report.coverage.matureStarts, 3)
  assert.equal(report.sampling, 'best_effort')
  assert.ok(!JSON.stringify(report).includes('SECRET'))
  assert.ok(!markdown(report).includes('SECRET'))
  assert.equal(io.calls[1].options.headers['x-vercel-observability-query-reason'], 'cli/logs-runtime')
  assert.equal(JSON.parse(io.calls[2].options.body).cursor, 'page2')
  assert.equal(io.calls[0].url, io.calls.at(-1).url)
})

test('excluded intervals, truncation, malformed lines and missing outcomes remain insufficient with no empty inference', async () => {
  const io = fixture([{ events: [event(start('missing')), event(start('legacy')), event({ ...end('legacy'), outcome: undefined }),
    { ...event(end('truncated')), truncated: true }, { ...event(end('bad')), message: 'SECRET_UNPARSEABLE' }],
    pagination: { hasMore: false, nextCursor: null }, meta: { excludedIntervals: [{ start: 'private', end: 'private' }] } }])
  const report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'insufficient')
  assert.equal(report.healthy, false)
  for (const reason of ['runtime_intervals_excluded', 'runtime_records_truncated', 'runtime_records_malformed', 'runtime_completions_missing', 'runtime_outcomes_missing']) assert.ok(report.reasons.includes(reason), reason)
  assert.equal(report.outcomes[ROUTES[0]].empty, 0)
  assert.equal(report.outcomes[ROUTES[0]].emptyRatio, null)
  assert.ok(!JSON.stringify(report).includes('SECRET'))
  assert.ok(!JSON.stringify(report).includes('private'))
})

test('fresh pending starts and rejected requests are unknown without being mislabeled empty or stale', async () => {
  const io = fixture([page([start('valid'), end('valid'), start('pending', ROUTES[0], now - 1_000), start('rejected'), end('rejected', undefined, 401)])])
  const report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'pass')
  assert.equal(report.coverage.missingCompletions, 0)
  assert.equal(report.coverage.unmarkedSuccessful, 0)
  assert.equal(report.outcomes[ROUTES[0]].empty, 1)
  assert.equal(report.outcomes[ROUTES[0]].unknown, 2)
  assert.equal(report.outcomes[ROUTES[0]].coverage, 1 / 3)
})

test('an unmarked successful completion exposes missing instrumentation even if its start was not collected', async () => {
  const io = fixture([page([start('valid'), end('valid'), { ...end('orphan'), outcome: undefined }])])
  const report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'insufficient')
  assert.equal(report.healthy, false)
  assert.equal(report.coverage.unmarkedSuccessful, 1)
  assert.ok(report.reasons.includes('runtime_outcomes_missing'))
  assert.equal(report.outcomes[ROUTES[0]].unknown, 1)
})

test('no samples and failures expose null ratios and fixed reasons, never upstream secrets', async () => {
  let io = fixture([page([])])
  let report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'insufficient')
  assert.deepEqual(report.reasons, ['runtime_no_classified_samples'])
  assert.equal(report.healthy, true)
  for (const metric of Object.values(report.outcomes)) { assert.equal(metric.emptyRatio, null); assert.equal(metric.coverage, null) }
  io = fixture([new Response('SECRET_ERROR', { status: 403 })])
  report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.ok(report.reasons.includes('vercel_api_http_403'))
  assert.equal(report.healthy, false)
  assert.ok(!JSON.stringify(report).includes('SECRET'))
})

test('deployment changes, cursor loops and collection budgets fail coverage instead of reporting complete', async () => {
  let io = fixture([page([start('ok'), end('ok')])], [alias, { ...alias, updatedAt: alias.updatedAt + 1 }])
  let report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.equal(report.status, 'insufficient')
  assert.ok(report.reasons.includes('runtime_deployment_changed'))
  io = fixture([page([], { hasMore: true, nextCursor: 'same' }), page([], { hasMore: true, nextCursor: 'same' })])
  report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.ok(report.reasons.includes('runtime_pagination_incomplete'))
  io = fixture(Array.from({ length: POLICY.maximumPages }, (_, index) => page([], { hasMore: true, nextCursor: String(index) })))
  report = await run({ token: 'token', now, fetchImpl: io.fetchImpl })
  assert.equal(report.pages, POLICY.maximumPages)
  assert.ok(report.reasons.includes('runtime_page_budget_exceeded'))
  assert.throws(() => readEntries([{ ...event(end('wrong')), deploymentId: 'dpl_other' }], deploymentId), /runtime_event_scope_mismatch/)
})
