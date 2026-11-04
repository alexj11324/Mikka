import test from 'node:test'
import assert from 'node:assert/strict'
import { collectHour, fixedHour, neonHour, selectedDeployment, markdown, metricContract, metricDimensions } from './acceptance-egress-hour.mjs'
import { TEAM, PROJECT, PRODUCTION_ALIAS } from './deployment-regression.mjs'
import { NEON_PROJECT, NEON_ORG } from './egress-monitor.mjs'

const now = Date.parse('2026-11-04T13:00:00Z')
const input = { role: 'connectivity-smoke', from: '2026-11-04T10:00:00Z', to: '2026-11-04T11:00:00Z', deploymentId: 'dpl_syntheticHistorical' }
const window = fixedHour(input, now)
const sha = 'a'.repeat(40)
const metadata = { id: input.deploymentId, projectId: PROJECT, target: 'production', readyState: 'READY', ready: Date.parse('2026-11-04T09:00:00Z'), gitSource: { sha } }
const alias = { alias: PRODUCTION_ALIAS, projectId: PROJECT, deploymentId: 'dpl_syntheticCurrent', updatedAt: now - 300000 }
const rawNeon = bytes => ({ projects: [{ project_id: NEON_PROJECT, periods: [{ period_start: '2026-11-01T00:00:00Z',
  consumption: [{ timeframe_start: input.from, timeframe_end: input.to, metrics: [{ metric_name: 'public_network_transfer_bytes', value: bytes }] }] }] }] })
const point = (route, httpStatus, value) => ({ dimensions: { route, httpStatus }, values: { value } })
const COUNT = 'vercel.function_invocation.count', CPU = 'vercel.function_invocation.function_cpu_time_ms'
const catalog = (metric, countOnly = false, legacy = false) => ({ metrics: [{ id: metric, unit: metric === COUNT ? 'count' : 'milliseconds',
  aggregations: metric === COUNT ? countOnly ? ['count'] : ['count', 'sum'] : ['sum'],
  dimensions: ['route', 'environment', legacy ? 'http_status' : 'httpStatus', legacy ? 'deployment_id' : 'deploymentId'] }], pagination: { hasMore: false, nextCursor: null } })

test('catalog selects invocation sum when available, count only when required, and explicit shared dimension names', () => {
  assert.equal(metricContract(catalog(COUNT), COUNT).aggregation, 'sum')
  assert.equal(metricContract(catalog(COUNT, true), COUNT).aggregation, 'count')
  assert.deepEqual(metricDimensions(metricContract(catalog(COUNT, false, true), COUNT), metricContract(catalog(CPU, false, true), CPU)),
    { route: 'route', environment: 'environment', httpStatus: 'http_status', deploymentId: 'deployment_id' })
  assert.throws(() => metricDimensions(metricContract(catalog(COUNT), COUNT), metricContract(catalog(CPU, false, true), CPU)), /dimensions_unavailable/)
  const bad = catalog(COUNT); bad.metrics[0].unit = 'bytes'
  assert.throws(() => metricContract(bad, COUNT), /count_unit_invalid/)
  assert.throws(() => metricContract({ ...catalog(COUNT), pagination: { hasMore: true } }, COUNT), /catalog_incomplete/)
})

test('explicit UTC completed hour and fixed scope reject invalid inputs before any network read', async () => {
  for (const patch of [
    { from: '2026-11-04T10:30:00Z' }, { to: '2026-11-04T12:00:00Z' }, { from: '2026-11-04T13:00:00Z', to: '2026-11-04T14:00:00Z' },
    { from: '2026-10-01T10:00:00Z', to: '2026-10-01T11:00:00Z' }, { projectId: 'other' }, { teamId: 'other' }, { prompt: 'never accepted' },
    { deploymentId: 'dpl_bad" OR environment:preview' }, { role: 'before' }, { concurrentTasks: 1 },
  ]) {
    let requests = 0
    const result = await collectHour({ input: { ...input, ...patch }, now, fetchImpl: async () => { requests++; throw Error('unexpected') } })
    assert.equal(result.status, 'insufficient'); assert.equal(requests, 0); assert.equal(result.productionAcceptance, false)
  }
  assert.throws(() => fixedHour({ ...input, from: '2026-02-30T10:00:00Z', to: '2026-02-30T11:00:00Z' }, Date.parse('2026-03-03T00:00:00Z')))
  assert.throws(() => fixedHour({ ...input, role: 'idle', expectedBuild: sha, concurrentTasks: 1 }, now), /idle_concurrency/)
  assert.equal(fixedHour({ ...input, role: 'before', expectedBuild: sha, workloadDigest: 'b'.repeat(64), concurrentTasks: 1 }, now).concurrentTasks, 1)
})

test('Neon retains exact returned bucket boundaries and never invents zero for delayed data', () => {
  const value = neonHour(rawNeon(42000), window)
  assert.equal(value.bytes, 42000); assert.equal(value.reportedThrough, '2026-11-04T11:00:00.000Z')
  assert.equal(value.coverage, 'requested_hour_returned'); assert.equal(value.scope, 'project_all_branches')
  assert.equal(neonHour(rawNeon(0), window).bytes, 0)
  const empty = rawNeon(1); empty.projects[0].periods[0].consumption = []
  assert.equal(neonHour(empty, window).bytes, null)
  assert.equal(neonHour(empty, window).reportedThrough, null)
  const partial = rawNeon(1); partial.projects[0].periods[0].consumption[0].timeframe_end = '2026-11-04T10:30:00Z'
  assert.equal(neonHour(partial, window).coverage, 'requested_hour_incomplete')
  const duplicate = rawNeon(1); duplicate.projects[0].periods.push(structuredClone(duplicate.projects[0].periods[0]))
  assert.throws(() => neonHour(duplicate, window), /neon_duplicate_hour/)
  const foreign = rawNeon(1); foreign.projects[0].project_id = 'another-project'
  assert.throws(() => neonHour(foreign, window), /neon_project_scope/)
  const invalid = rawNeon(1); invalid.projects[0].periods[0].consumption[0].metrics = []
  assert.throws(() => neonHour(invalid, window), /neon_bucket_invalid/)
})

function provider({ changeAlias = false, excluded = false, error = false, incomplete = false, countOnly = false, legacy = false } = {}) {
  const calls = []
  let aliases = 0
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url); calls.push({ origin: parsed.origin, pathname: parsed.pathname, method: init.method })
    if (parsed.origin === 'https://console.neon.tech') {
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error')
      assert.equal(init.headers.authorization, 'Bearer synthetic-neon-secret')
      assert.equal(parsed.pathname, '/api/v2/consumption_history/v2/projects')
      assert.equal(parsed.searchParams.get('org_id'), NEON_ORG); assert.equal(parsed.searchParams.get('project_ids'), NEON_PROJECT)
      assert.equal(parsed.searchParams.get('from'), window.from); assert.equal(parsed.searchParams.get('to'), window.to)
      assert.equal(parsed.searchParams.get('granularity'), 'hourly'); assert.equal(parsed.searchParams.get('metrics'), 'public_network_transfer_bytes')
      const value = rawNeon(42000); value.private_unknown = 'synthetic-secret-never-exported'
      if (incomplete) value.projects[0].periods[0].consumption = []
      return Response.json(value)
    }
    assert.equal(parsed.origin, 'https://api.vercel.com'); assert.equal(parsed.searchParams.get('teamId'), TEAM)
    assert.equal(init.headers.authorization, 'Bearer synthetic-vercel-secret'); assert.equal(init.redirect, 'error')
    if (parsed.pathname.startsWith('/v4/aliases/')) {
      assert.equal(init.method, 'GET'); aliases++
      return Response.json({ ...alias, updatedAt: alias.updatedAt + (changeAlias && aliases > 1 ? 1 : 0) })
    }
    if (parsed.pathname.startsWith('/v13/deployments/')) {
      assert.equal(init.method, 'GET')
      return Response.json({ ...metadata, env: ['synthetic-secret-never-exported'], private_unknown: 'synthetic-secret-never-exported' })
    }
    assert.equal(parsed.pathname, '/metrics/v1')
    if (init.method === 'GET') {
      const metric = parsed.searchParams.get('search')
      assert.ok([COUNT, CPU].includes(metric)); assert.equal(parsed.searchParams.get('kind'), 'system')
      assert.equal(parsed.searchParams.get('activeSince'), window.from)
      return Response.json(catalog(metric, countOnly, legacy))
    }
    assert.equal(init.method, 'POST')
    const body = JSON.parse(init.body)
    assert.deepEqual(body.scope, { ownerId: TEAM, projectIds: [PROJECT] })
    assert.deepEqual(body.groupBy, ['route', legacy ? 'http_status' : 'httpStatus'])
    assert.equal(body.filter, 'environment:production AND ' + (legacy ? 'deployment_id' : 'deploymentId') + ':"' + input.deploymentId + '"')
    assert.deepEqual(body.timeRange, { start: window.from, end: window.to })
    assert.equal(body.seriesSelection.mode, 'exact')
    if (error) return new Response('synthetic-secret-never-exported', { status: 403 })
    const count = body.metrics.value.metric === COUNT
    assert.ok(count ? (countOnly ? ['count'] : ['sum', 'count']).includes(body.metrics.value.aggregation) : body.metrics.value.aggregation === 'sum')
    const countValue = countOnly || body.metrics.value.aggregation === 'sum' ? 60 : 6
    const summary = [point('/[locale]', '200', count ? countValue : 600), point('/api/factory/tasks', '200', count ? countValue : 300)]
    if (legacy) for (const row of summary) { row.dimensions.http_status = row.dimensions.httpStatus; delete row.dimensions.httpStatus }
    return Response.json({ summary,
      ...(excluded ? { meta: { excludedIntervals: [{ start: input.from, end: input.to }] } } : {}),
      private_unknown: 'synthetic-secret-never-exported' })
  }
  return { fetchImpl, calls }
}
const collect = async options => {
  const source = provider(options)
  const report = await collectHour({ input, now, fetchImpl: source.fetchImpl, vercelToken: 'synthetic-vercel-secret', neonToken: 'synthetic-neon-secret' })
  return { report, calls: source.calls }
}

test('canonical metrics and provider reads stay scoped and output only aggregate fields', async () => {
  const { report, calls } = await collect()
  assert.equal(report.status, 'collected'); assert.equal(report.productionAcceptance, false)
  assert.equal(report.window.role, 'connectivity-smoke')
  assert.equal(report.vercel.requests, 120); assert.equal(report.vercel.cpuMs, 900); assert.equal(report.neon.bytes, 42000)
  assert.equal(report.vercel.aliasMatchedSelectedAtCollection, false)
  assert.equal(report.vercel.metricContract.count.aggregation, 'sum')
  assert.deepEqual(report.vercel.aggregationCheck, { selectedAggregation: 'sum', alternateAggregation: 'count', selectedTotal: 120, alternateTotal: 12, groupsMatch: false, diagnosticOnly: true })
  assert.equal(calls.length, 10)
  assert.ok(!JSON.stringify(report).includes('synthetic-secret'))
  assert.ok(!markdown(report).includes('synthetic-secret'))
  assert.ok(markdown(report).includes('Production acceptance: not established'))
})

test('catalog-supported count-only and snake_case dimensions retain the same fixed query scope', async () => {
  const { report, calls } = await collect({ countOnly: true, legacy: true })
  assert.equal(report.status, 'collected'); assert.equal(report.vercel.requests, 120)
  assert.equal(report.vercel.metricContract.count.aggregation, 'count')
  assert.equal(report.vercel.metricContract.dimensions.httpStatus, 'http_status')
  assert.equal(report.vercel.aggregationCheck, null); assert.equal(calls.length, 9)
})

test('alias changes, omitted intervals, provider refusals and missing hourly buckets fail closed without raw errors', async () => {
  for (const [options, reason] of [
    [{ changeAlias: true }, 'deployment_changed_during_collection'],
    [{ excluded: true }, 'vercel_metric_intervals_excluded'],
    [{ error: true }, 'vercel_api_http_403'],
    [{ incomplete: true }, 'neon_requested_hour_not_reported'],
  ]) {
    const { report } = await collect(options)
    assert.equal(report.status, 'insufficient'); assert.ok(report.reasons.includes(reason))
    assert.equal(report.productionAcceptance, false); assert.ok(!JSON.stringify(report).includes('synthetic-secret'))
  }
})

test('deployment verification rejects another project and mismatched expected build', () => {
  assert.throws(() => selectedDeployment({ ...metadata, projectId: 'other' }, window), /deployment_scope_invalid/)
  assert.throws(() => selectedDeployment(metadata, { ...window, expectedBuild: 'b'.repeat(40) }), /deployment_build_mismatch/)
  assert.throws(() => selectedDeployment({ ...metadata, ready: window.start + 1 }, { ...window, role: 'before' }), /deployment_not_ready/)
})
