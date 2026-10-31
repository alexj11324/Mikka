import assert from 'node:assert/strict'
import test from 'node:test'
import { activeAlias, aggregate, api, compare, comparisonWindows, deployment, markdown, metricQuery, metricRows, POLICY, PRODUCTION_ALIAS, PROJECT, run, SCOPE } from './deployment-regression.mjs'

const ready = Date.parse('2026-10-31T12:01:00Z')
const before = { id: 'dpl_before', sha: 'a'.repeat(40), ready: ready - 3_600_000 }
const after = { id: 'dpl_after', sha: 'b'.repeat(40), ready }
const totals = (requests = 20, cpu = 100, errorRate = 0, route = '/api/tasks') => ({ requests, errors: Math.round(requests * errorRate), cpuMs: requests * cpu, cpuPerRequestMs: cpu, errorRate,
  groups: [{ route, httpStatus: '200', requests, cpuMs: requests * cpu, cpuPerRequestMs: cpu }] })

test('UTC windows are equal, aligned, nonoverlapping, complete, and outside warmup', () => {
  const result = comparisonWindows(before, after, ready + 600_000)
  assert.deepEqual(result, { before: { start: Date.parse('2026-10-31T11:55:00Z'), end: Date.parse('2026-10-31T12:00:00Z') },
    after: { start: Date.parse('2026-10-31T12:05:00Z'), end: Date.parse('2026-10-31T12:10:00Z') } })
  assert.throws(() => comparisonWindows(before, after, result.after.end - 1), /window_not_complete/)
  assert.doesNotThrow(() => comparisonWindows(before, after, result.after.end))
  assert.throws(() => comparisonWindows({ ...before, ready: result.before.start + 1 }, after, ready + 600_000), /boundary/)
  assert.throws(() => comparisonWindows(after, after, ready + 600_000), /boundary/)
  assert.throws(() => deployment({ id: after.id, meta: { githubCommitSha: after.sha }, ready: 'invalid' }), /metadata/)
})

test('initial CPU threshold requires both strict ratio and absolute delta; sample boundary is inclusive', () => {
  assert.equal(compare(totals(), totals(20, 200)).status, 'pass')
  assert.equal(compare(totals(20, 50), totals(20, 150)).status, 'pass')
  assert.equal(compare(totals(), totals(20, 201)).status, 'regression')
  assert.equal(compare(totals(20, 0), totals(20, 101)).status, 'regression')
  assert.equal(compare(totals(19), totals()).status, 'insufficient')
  assert.equal(compare(totals(), totals(0)).status, 'insufficient')
  assert.equal(compare({ ...totals(0), groups: [] }, { ...totals(0), groups: [] }).status, 'insufficient')
})

test('traffic, routes, status, samples and error growth cannot masquerade as improvement', () => {
  assert.equal(compare(totals(), totals(41)).status, 'not_comparable')
  assert.equal(compare(totals(), totals(20, 1, 0, '/api/different')).status, 'not_comparable')
  assert.equal(compare(totals(), { ...totals(20, 1), groups: [{ ...totals().groups[0], httpStatus: '500' }] }).status, 'not_comparable')
  assert.equal(compare(totals(1000), totals(1000, 1, .05)).status, 'pass')
  assert.deepEqual(compare(totals(1000), totals(1000, 1, .051)).reasons, ['server_error_rate_increased'])
  assert.equal(compare(totals(1000, 100, .35), totals(1000, 100, .4)).status, 'pass')
  assert.equal(compare(totals(1000, 100, .35), totals(1000, 100, .401)).status, 'regression')
  const a = { ...totals(40), groups: [{ ...totals(40).groups[0], requests: 10 }, { ...totals(40).groups[0], route: '/api/other', requests: 30 }] }
  assert.equal(compare(a, a).status, 'insufficient')
  const b = { ...a, groups: [{ ...a.groups[0], requests: 30 }, { ...a.groups[1], requests: 10 }] }
  assert.equal(compare(a, b).status, 'not_comparable')
})

test('query has proven project scope and only deployment/environment filters and route/status groups', () => {
  const query = metricQuery('vercel.function_invocation.count', 'count', after.id, { start: ready, end: ready + POLICY.windowMs })
  assert.deepEqual(query.scope, SCOPE)
  assert.equal(query.filter, 'environment:production AND deploymentId:"dpl_after"')
  assert.deepEqual(query.timeRange, { start: new Date(ready).toISOString(), end: new Date(ready + POLICY.windowMs).toISOString() })
  assert.deepEqual(query.metrics, { value: { metric: 'vercel.function_invocation.count', aggregation: 'count' } })
  assert.equal(query.bucketSeconds, 300)
  assert.deepEqual(query.groupBy, ['route', 'httpStatus'])
  assert.throws(() => metricQuery('x', 'sum', "dpl_' injection", { start: ready, end: ready + 1 }), /id_invalid/)
})

test('only expected aggregate fields leave the boundary; malformed and truncated samples fail closed', () => {
  const metric = 'vercel.function_invocation.count'
  const row = { dimensions: { route: '/api/tasks/[id]', httpStatus: '200' }, values: { value: 20 }, payload: 'SECRET' }
  const count = metricRows({ summary: [row] }, metric, 'count')
  const cpu = metricRows({ summary: [{ ...row, values: { value: 1000 } }] }, 'vercel.function_invocation.function_cpu_time_ms', 'sum')
  const result = aggregate(cpu, count)
  assert.equal(result.cpuPerRequestMs, 50)
  assert.ok(!JSON.stringify(result).includes('SECRET'))
  for (const response of [{}, { summary: [{ ...row, dimensions: { ...row.dimensions, httpStatus: null } }] }, { summary: [{ ...row, values: { value: null } }] }, { summary: [row, row] }, { summary: Array(100).fill(row) }])
    assert.throws(() => metricRows(response, metric, 'count'))
  assert.throws(() => aggregate(new Map(), count), /scope_mismatch/)
})

test('API failures never echo upstream payloads, token or exceptions', async () => {
  await assert.rejects(api('/v2/observability/query', { token: 'SECRET', fetchImpl: async () => { throw Error('SECRET') } }), /^Error: vercel_api_network_unavailable$/)
  await assert.rejects(api('/v2/observability/query', { token: 'SECRET', fetchImpl: async () => ({ ok: false, status: 403, text: () => 'SECRET' }) }), /^Error: vercel_api_http_403$/)
  await assert.rejects(api('https://example.com', { token: 'SECRET' }), /origin_invalid/)
})

function fixture({ changed = false, aliasChanged = false, assignmentChanged = false } = {}) {
  let aliasReads = 0, detailReads = 0
  const raw = item => ({ ...item, projectId: PROJECT, meta: { githubCommitSha: item.sha }, target: 'production', readyState: 'READY', aliasAssigned: true, aliasAssignedAt: item.ready, url: item.id === after.id ? 'immutable.vercel.app' : 'before.vercel.app' })
  return async (url, options) => {
    const path = new URL(url).pathname
    let value
    if (path.startsWith('/v4/aliases/')) value = { alias: PRODUCTION_ALIAS, projectId: PROJECT, deploymentId: aliasChanged && aliasReads++ > 0 ? before.id : after.id, updatedAt: ready }
    else if (path === '/v6/deployments') value = { deployments: new URL(url).searchParams.get('limit') === '1' && changed ? [{ uid: 'dpl_new' }] : [{ uid: after.id }, { uid: before.id }] }
    else if (path === `/v13/deployments/${after.id}` || path.endsWith('immutable.vercel.app')) value = { ...raw(after), aliasAssignedAt: assignmentChanged && detailReads++ > 0 ? ready + 1 : ready }
    else if (path === `/v13/deployments/${before.id}`) value = raw(before)
    else if (path === '/metrics/v1') {
      const query = JSON.parse(options.body)
      value = { summary: [{ dimensions: { route: '/api/tasks', httpStatus: '200' }, values: { value: query.metrics.value.aggregation === 'count' ? 20 : 2000 } }] }
    } else throw Error('UNEXPECTED_SECRET_ENDPOINT')
    return { ok: true, json: async () => value }
  }
}

test('read-only full path pins deployment, rejects event/race mismatch, emits aggregate report', async () => {
  const opts = { token: 'SECRET', now: ready + 600_000, fetchImpl: fixture() }
  const report = await run(opts)
  assert.equal(report.status, 'pass')
  assert.equal(report.deployments.after.id, after.id)
  assert.ok(!JSON.stringify(report).includes('SECRET'))
  assert.ok(markdown(report).includes('No automatic rollback'))
  assert.equal((await run({ ...opts, fetchImpl: fixture({ changed: true }) })).reasons[0], 'deployment_changed_during_comparison')
  assert.equal((await run({ ...opts, fetchImpl: fixture({ aliasChanged: true }) })).reasons[0], 'deployment_changed_during_comparison')
  assert.equal((await run({ ...opts, fetchImpl: fixture({ assignmentChanged: true }) })).reasons[0], 'deployment_changed_during_comparison')
  assert.throws(() => activeAlias({ alias: PRODUCTION_ALIAS, projectId: 'other', deploymentId: after.id, updatedAt: ready }), /alias_invalid/)
  const event = { deployment: { environment: 'Production', sha: after.sha }, deployment_status: { state: 'success', target_url: 'https://immutable.vercel.app' } }
  assert.equal((await run({ ...opts, eventName: 'deployment_status', event })).status, 'pass')
  event.deployment.sha = before.sha
  assert.equal((await run({ ...opts, eventName: 'deployment_status', event })).reasons[0], 'deployment_event_mismatch')
  event.deployment.sha = after.sha; event.deployment_status.target_url = 'https://mutable-alias.vercel.app'
  assert.equal((await run({ ...opts, eventName: 'deployment_status', event })).reasons[0], 'deployment_event_reference_unavailable')
  delete event.deployment_status.target_url
  assert.equal((await run({ ...opts, eventName: 'deployment_status', event })).reasons[0], 'deployment_event_reference_unavailable')
})
