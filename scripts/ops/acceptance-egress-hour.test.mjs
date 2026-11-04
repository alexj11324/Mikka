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

function provider({ changeAlias = false, excluded = false, error = false, incomplete = false, countOnly = false, legacy = false,
  observation = false, missingSummary = false, unknownKey = false, truncated = false, duplicate = false, missingDeployment = false, empty = false, cpuMismatch = false } = {}) {
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
      return Response.json({ ...alias, ...(observation && changeAlias && aliases > 1 ? { deploymentId: 'dpl_syntheticChanged' } : {}), updatedAt: alias.updatedAt + (changeAlias && aliases > 1 ? 1 : 0) })
    }
    if (parsed.pathname.startsWith('/v13/deployments/')) {
      assert.equal(init.method, 'GET')
      return Response.json({ ...metadata, ...(observation ? { id: parsed.pathname.split('/').at(-1), ready: now - 60000 } : {}), env: ['synthetic-secret-never-exported'], private_unknown: 'synthetic-secret-never-exported' })
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
    if (!(observation && truncated && body.groupBy?.length !== 3))
      assert.deepEqual(body.groupBy, ['route', legacy ? 'http_status' : 'httpStatus', ...(observation ? [legacy ? 'deployment_id' : 'deploymentId'] : [])])
    assert.equal(body.filter, observation ? 'environment:production' : 'environment:production AND ' + (legacy ? 'deployment_id' : 'deploymentId') + ':"' + input.deploymentId + '"')
    assert.deepEqual(body.timeRange, { start: window.from, end: window.to })
    if (body.groupBy?.length) assert.equal(body.seriesSelection.mode, 'exact')
    if (error) return new Response('synthetic-secret-never-exported', { status: 403 })
    const count = body.metrics.value.metric === COUNT
    assert.ok(count ? (countOnly ? ['count'] : ['sum', 'count']).includes(body.metrics.value.aggregation) : body.metrics.value.aggregation === 'sum')
    const countValue = countOnly || body.metrics.value.aggregation === 'sum' ? 60 : 6
    let summary = [point('/[locale]', '200', count ? countValue : 600), point('/api/factory/tasks', '200', count ? countValue : 300)]
    if (observation) {
      summary = [point('/[locale]', '200', count ? countValue : 600), point('/[locale]', '200', count ? countValue / 2 : 300), point('/api/factory/tasks', '503', count ? 5 : 20)]
      for (const [index, row] of summary.entries()) row.dimensions[legacy ? 'deployment_id' : 'deploymentId'] = index ? 'dpl_windowSecond' : 'dpl_windowFirst'
      if (missingDeployment) delete summary[0].dimensions[legacy ? 'deployment_id' : 'deploymentId']
      if (duplicate) summary.push(structuredClone(summary[0]))
      if (cpuMismatch && !count) summary.pop()
      if (truncated) summary = Array.from({ length: 100 }, (_, index) => ({ ...summary[0], dimensions: { ...summary[0].dimensions, [legacy ? 'deployment_id' : 'deploymentId']: 'dpl_' + index } }))
      if (empty) summary = []
    }
    if (legacy) for (const row of summary) { row.dimensions.http_status = row.dimensions.httpStatus; delete row.dimensions.httpStatus }
    const unknown = unknownKey ? { ['synthetic-secret-key-' + 'x'.repeat(10000)]: 'synthetic-secret-value' } : {}
    return Response.json({ ...unknown, ...(missingSummary ? { data: { summary, ...unknown } } : { summary }),
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

const observationInput = { role: 'observation', scope: 'project-production', from: input.from, to: input.to }
const observe = async options => {
  const source = provider({ observation: true, ...options })
  const report = await collectHour({ input: observationInput, now, fetchImpl: source.fetchImpl, vercelToken: 'synthetic-vercel-secret', neonToken: 'synthetic-neon-secret' })
  return { report, calls: source.calls }
}

test('project observation has a separate explicit scope and cannot bypass fixed-task identity checks', async () => {
  assert.deepEqual(fixedHour(observationInput, now), { ...observationInput, start: window.start, end: window.end, from: window.from, to: window.to })
  for (const patch of [{ scope: 'other' }, { deploymentId: input.deploymentId }, { expectedBuild: sha },
    { workloadDigest: 'b'.repeat(64) }, { concurrentTasks: 1 }, { projectId: 'other' }]) {
    let requests = 0
    const report = await collectHour({ input: { ...observationInput, ...patch }, now, fetchImpl: async () => { requests++; throw Error('unexpected') } })
    assert.equal(report.status, 'insufficient'); assert.equal(requests, 0)
  }
  for (const role of ['before', 'after', 'idle', 'connectivity-smoke']) {
    const validFixed = { ...input, role, expectedBuild: sha, workloadDigest: 'b'.repeat(64), concurrentTasks: role === 'idle' ? 0 : 1 }
    assert.throws(() => fixedHour({ ...validFixed, scope: 'project-production' }, now), /fixed_window_scope_invalid/)
    if (role === 'before' || role === 'after') {
      assert.throws(() => fixedHour({ ...validFixed, workloadDigest: undefined }, now), /workload_identity_required/)
      assert.throws(() => fixedHour({ ...validFixed, deploymentId: undefined }, now), /deployment_id_invalid/)
      assert.throws(() => fixedHour({ ...validFixed, expectedBuild: undefined }, now), /expected_build_required/)
    }
  }
})

test('project production retains multiple deployments per route and rolls up only their returned invocation counts', async () => {
  const { report, calls } = await observe()
  assert.equal(report.status, 'collected'); assert.equal(report.productionAcceptance, false)
  assert.equal(report.vercel.scope, 'project-production'); assert.equal(report.vercel.requests, 95)
  assert.equal(report.vercel.cpuMs, 920); assert.equal(report.vercel.errors, 5)
  assert.deepEqual(report.vercel.deploymentIds, ['dpl_windowFirst', 'dpl_windowSecond'])
  assert.equal(report.vercel.groups.length, 3)
  assert.deepEqual(report.vercel.groups.slice(0, 2).map(row => [row.deploymentId, row.route, row.requests]),
    [['dpl_windowFirst', '/[locale]', 60], ['dpl_windowSecond', '/[locale]', 30]])
  assert.equal(report.vercel.routes[0].route, '/[locale]'); assert.equal(report.vercel.routes[0].requests, 90)
  assert.equal(report.vercel.routes[1].httpStatus, '503')
  assert.equal(report.vercel.groupLimit, 100); assert.equal(report.vercel.coverage, 'returned_groups_below_query_limit')
  assert.equal(calls.length, 9)
  assert.ok(!JSON.stringify(report).includes('synthetic-secret')); assert.ok(!markdown(report).includes('synthetic-secret'))
  assert.ok(markdown(report).includes('all production deployments')); assert.ok(markdown(report).includes('dpl_windowSecond'))
  assert.ok(report.limitations.some(text => text.includes('never a fixed-task')))
})

test('an alias/build change is recorded as collection context without narrowing the completed production hour', async () => {
  const { report } = await observe({ changeAlias: true, countOnly: true, legacy: true })
  assert.equal(report.status, 'collected'); assert.equal(report.vercel.requests, 95)
  assert.equal(report.vercel.metricContract.count.aggregation, 'count')
  assert.equal(report.vercel.contextAtCollection.aliasChanged, true)
  assert.equal(report.vercel.contextAtCollection.before.alias.deploymentId, 'dpl_syntheticCurrent')
  assert.equal(report.vercel.contextAtCollection.after.alias.deploymentId, 'dpl_syntheticChanged')
  assert.ok(Date.parse(report.vercel.contextAtCollection.before.deployment.readyAt) > window.end)
  assert.deepEqual(report.vercel.deploymentIds, ['dpl_windowFirst', 'dpl_windowSecond'])
})

test('project observations preserve insufficient coverage, truncation, duplicates and denied reads instead of claiming zero or complete totals', async () => {
  for (const [options, reason] of [
    [{ truncated: true }, 'metric_groups_missing_or_truncated'],
    [{ empty: true }, 'vercel_no_groups_reported'],
    [{ missingDeployment: true }, 'metric_deployment_dimension_invalid'],
    [{ duplicate: true }, 'metric_duplicate_group'],
    [{ cpuMismatch: true }, 'cpu_request_scope_mismatch'],
    [{ excluded: true }, 'vercel_metric_intervals_excluded'],
    [{ error: true }, 'vercel_api_http_403'],
  ]) {
    const { report } = await observe(options)
    assert.equal(report.status, 'insufficient'); assert.ok(report.reasons.includes(reason), reason)
    assert.equal(report.vercel, undefined); assert.equal(report.productionAcceptance, false)
    assert.ok(!JSON.stringify(report).includes('synthetic-secret'))
  }
  const { report } = await observe({ incomplete: true })
  assert.equal(report.status, 'insufficient'); assert.ok(report.reasons.includes('neon_requested_hour_not_reported'))
  assert.equal(report.vercel.requests, 95); assert.equal(report.neon.bytes, null)
})

test('failed project observation records actual response shape without claiming truncation or exporting values', async () => {
  const missing = (await observe({ missingSummary: true })).report
  const truncated = (await observe({ truncated: true })).report
  assert.deepEqual(missing.reasons, ['metric_groups_missing_or_truncated'])
  assert.deepEqual(truncated.reasons, ['metric_groups_missing_or_truncated'])
  assert.deepEqual(missing.vercelResponseShape.count.summary, { type: 'undefined' })
  assert.deepEqual(missing.vercelResponseShape.count.data, { type: 'object', keyCount: 1, unknownKeyCount: 0, keys: ['summary'] })
  assert.deepEqual(truncated.vercelResponseShape.count.summary, { type: 'array', length: 100 })
  assert.deepEqual(truncated.vercelResponseShape.cpu.summary, { type: 'array', length: 100 })
  assert.equal(truncated.vercelResponseShape.queryGroupLimit, 100)
  assert.deepEqual(truncated.vercelResponseShape.count.dimensions.keys, ['route', 'httpStatus', 'deploymentId'])
  const unknown = (await observe({ missingSummary: true, unknownKey: true })).report
  assert.deepEqual(unknown.vercelResponseShape.count.data, { type: 'object', keyCount: 2, unknownKeyCount: 1, keys: ['summary'] })
  assert.equal(unknown.vercelResponseShape.count.response.unknownKeyCount, 2)
  for (const report of [missing, truncated, unknown]) {
    assert.equal(report.status, 'insufficient')
    assert.equal(report.productionAcceptance, false)
    assert.equal(report.vercel, undefined)
    const serialized = JSON.stringify(report.vercelResponseShape)
    assert.ok(!serialized.includes('synthetic-secret'))
    assert.ok(!serialized.includes('/[locale]'))
    assert.ok(!serialized.includes('dpl_'))
  }
})

function partitionProvider({ groupsPerDeployment = 60, deploymentCount = 2, legacy = false, countOnly = false,
  drift = false, missingRoute = false, wrongScope = false, duplicateDeployment = false, excludedPartition = false,
  missingCpuDeployment = false } = {}) {
  const other = provider({ observation: true, legacy, countOnly }), queries = []
  const dep = legacy ? 'deployment_id' : 'deploymentId', status = legacy ? 'http_status' : 'httpStatus'
  const rows = Array.from({ length: deploymentCount }, (_, d) => Array.from({ length: groupsPerDeployment }, (_, i) => ({
    dimensions: { route: '/api/synthetic/' + i, [status]: i % 9 ? '200' : '503', [dep]: 'dpl_partition' + d },
    requests: i + d + 1, cpuMs: (i + 1) * 2.25 + d,
  }))).flat()
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname !== '/metrics/v1' || init?.method !== 'POST') return other.fetchImpl(url, init)
    const body = JSON.parse(init.body); queries.push(body)
    assert.deepEqual(body.scope, { ownerId: TEAM, projectIds: [PROJECT] })
    assert.deepEqual(body.timeRange, { start: window.from, end: window.to })
    assert.equal(body.bucketSeconds, 300)
    const count = body.metrics.value.metric === COUNT
    assert.equal(body.metrics.value.aggregation, count && countOnly ? 'count' : 'sum')
    const grouped = body.groupBy ?? []
    assert.ok([0, 1, 3].includes(grouped.length))
    if (grouped.length) {
      assert.equal(body.seriesSelection.mode, 'exact'); assert.equal(body.seriesSelection.limit, 100)
      assert.deepEqual(grouped, grouped.length === 1 ? [dep] : ['route', status, dep])
    } else { assert.equal(body.seriesSelection, undefined); assert.equal(body.groupBy, undefined) }
    const match = body.filter.match(new RegExp('^environment:production AND ' + dep + ':"(dpl_partition[0-9]+)"$'))
    assert.ok(body.filter === 'environment:production' || match)
    if (grouped.length < 3) assert.equal(body.filter, 'environment:production')
    let selected = match ? rows.filter(row => row.dimensions[dep] === match[1]) : rows
    if (match && missingRoute) selected = selected.slice(1)
    const reduced = new Map()
    for (const row of selected) {
      const dimensions = Object.fromEntries(grouped.map(key => [key, row.dimensions[key]])), key = JSON.stringify(dimensions)
      const current = reduced.get(key) ?? { dimensions, values: { value: 0 } }
      current.values.value += count ? row.requests : row.cpuMs; reduced.set(key, current)
    }
    let summary = [...reduced.values()].sort((a, b) => b.values.value - a.values.value).slice(0, 100)
    if (!grouped.length && count && drift) summary[0].values.value++
    if (grouped.length === 1 && duplicateDeployment) summary.push(structuredClone(summary[0]))
    if (grouped.length === 1 && !count && missingCpuDeployment) summary.pop()
    if (match && wrongScope) summary[0].dimensions[dep] = 'dpl_foreign'
    return Response.json({ summary, series: [], ...(match && excludedPartition ? { meta: { excludedIntervals: [{}] } } : {}) })
  }
  return { fetchImpl, queries, expectedRequests: rows.reduce((sum, row) => sum + row.requests, 0),
    expectedCpuMs: rows.reduce((sum, row) => sum + row.cpuMs, 0), groups: rows.length }
}

const observePartitions = async options => {
  const source = partitionProvider(options)
  const report = await collectHour({ input: observationInput, now, fetchImpl: source.fetchImpl,
    vercelToken: 'synthetic-vercel-secret', neonToken: 'synthetic-neon-secret' })
  return { report, source }
}

test('a capped project hour is recovered by disjoint deployment queries with unchanged scope and reconciled totals', async () => {
  for (const options of [{}, { legacy: true, countOnly: true }]) {
    const { report, source } = await observePartitions(options)
    assert.equal(report.status, 'collected', report.reasons.join(',')); assert.equal(report.productionAcceptance, false)
    assert.equal(report.vercel.coverage, 'disjoint_deployments_reconciled_to_project_totals')
    assert.equal(report.vercel.groups.length, source.groups); assert.equal(source.groups, 120)
    assert.equal(report.vercel.requests, source.expectedRequests); assert.equal(report.vercel.cpuMs, source.expectedCpuMs)
    assert.equal(report.vercel.reconciliation.totalRequests, source.expectedRequests)
    assert.equal(report.vercel.reconciliation.totalCpuMs, source.expectedCpuMs)
    assert.deepEqual(report.vercel.reconciliation.partitions.map(p => p.groups), [60, 60])
    assert.equal(report.vercel.reconciliation.from, window.from); assert.equal(report.vercel.reconciliation.to, window.to)
    assert.equal(report.vercelResponseShape.count.summary.length, 100)
    assert.equal(report.vercelResponseShape.partitioning.partitions.length, 2)
    assert.equal(source.queries.length, 10)
    assert.ok(!JSON.stringify(report).includes('synthetic-secret'))
    assert.ok(!JSON.stringify(report.vercelResponseShape).includes('dpl_partition'))
  }
})

test('partition limits, incomplete sums, mixed scopes, duplicates and missing metric groups remain insufficient', async () => {
  for (const [options, reason] of [
    [{ groupsPerDeployment: 100 }, 'metric_groups_missing_or_truncated'],
    [{ deploymentCount: 17, groupsPerDeployment: 7 }, 'metric_partition_limit_exceeded'],
    [{ drift: true }, 'metric_partition_totals_mismatch'],
    [{ missingRoute: true }, 'metric_partition_totals_mismatch'],
    [{ wrongScope: true }, 'metric_partition_scope_invalid'],
    [{ duplicateDeployment: true }, 'metric_duplicate_group'],
    [{ excludedPartition: true }, 'vercel_metric_intervals_excluded'],
    [{ missingCpuDeployment: true }, 'cpu_request_scope_mismatch'],
  ]) {
    const { report, source } = await observePartitions(options)
    assert.equal(report.status, 'insufficient'); assert.deepEqual(report.reasons, [reason])
    assert.equal(report.vercel, undefined); assert.equal(report.productionAcceptance, false)
    assert.ok(source.queries.length <= 10); assert.ok(report.neon.bytes > 0)
  }
})
