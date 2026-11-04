import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { api, activeAlias, aggregate, metricQuery, metricRows, TEAM, PROJECT, PRODUCTION_ALIAS } from './deployment-regression.mjs'
import { NEON_PROJECT, NEON_ORG } from './egress-monitor.mjs'

const HOUR = 3600000
const COUNT = 'vercel.function_invocation.count'
const CPU = 'vercel.function_invocation.function_cpu_time_ms'
const fail = code => { throw Error(code) }
const iso = value => new Date(value).toISOString()
const safeCode = error => /^[a-z][a-z0-9_]{0,100}$/.test(error?.message ?? '') ? error.message : 'collection_failed'
const keys = ['role', 'from', 'to', 'deploymentId', 'expectedBuild', 'workloadDigest', 'concurrentTasks']

/** Inputs describe one completed UTC hour, never a rolling or inferred window. */
export function fixedHour(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) fail('window_input_invalid')
  if (!['connectivity-smoke', 'before', 'after', 'idle'].includes(raw.role)) fail('window_role_invalid')
  if (![raw.from, raw.to].every(value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:00:00(?:\.000)?Z$/.test(value))) fail('window_utc_hour_required')
  const start = Date.parse(raw.from), end = Date.parse(raw.to)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== HOUR || start % HOUR || end > now || start < now - 168 * HOUR) fail('window_range_invalid')
  if (iso(start).replace('.000Z', 'Z') !== raw.from.replace('.000Z', 'Z') || iso(end).replace('.000Z', 'Z') !== raw.to.replace('.000Z', 'Z')) fail('window_calendar_invalid')
  if (!/^dpl_[A-Za-z0-9]{1,100}$/.test(raw.deploymentId ?? '')) fail('deployment_id_invalid')
  if (raw.expectedBuild != null && !/^[a-f0-9]{40}$/.test(raw.expectedBuild)) fail('build_sha_invalid')
  if (raw.workloadDigest != null && !/^[a-f0-9]{64}$/.test(raw.workloadDigest)) fail('workload_digest_invalid')
  if (raw.role !== 'connectivity-smoke' && !raw.expectedBuild) fail('expected_build_required')
  if (['before', 'after'].includes(raw.role) && (!raw.workloadDigest || !Number.isSafeInteger(raw.concurrentTasks) || raw.concurrentTasks < 1)) fail('workload_identity_required')
  if (raw.role === 'idle' && raw.concurrentTasks !== 0) fail('idle_concurrency_must_be_zero')
  if (raw.role === 'connectivity-smoke' && raw.concurrentTasks != null) fail('smoke_is_not_a_task_window')
  return { role: raw.role, start, end, from: iso(start), to: iso(end), deploymentId: raw.deploymentId,
    expectedBuild: raw.expectedBuild ?? null, workloadDigest: raw.workloadDigest ?? null, concurrentTasks: raw.concurrentTasks ?? null }
}

/** Whitelist deployment identity only; no environment values or raw metadata. */
export function selectedDeployment(raw, window) {
  const id = raw?.id ?? raw?.uid, sha = raw?.gitSource?.sha ?? raw?.meta?.githubCommitSha ?? null
  if (id !== window.deploymentId || raw.projectId !== PROJECT || raw.target !== 'production' || raw.readyState !== 'READY') fail('deployment_scope_invalid')
  if (sha !== null && !/^[a-f0-9]{40}$/.test(sha)) fail('deployment_sha_invalid')
  if (raw.meta?.githubCommitSha && sha !== raw.meta.githubCommitSha) fail('deployment_sha_conflict')
  if (window.expectedBuild && sha !== window.expectedBuild) fail('deployment_build_mismatch')
  if (!Number.isSafeInteger(raw.ready) || raw.ready <= 0) fail('deployment_ready_time_invalid')
  if (window.role !== 'connectivity-smoke' && raw.ready > window.start) fail('deployment_not_ready_at_window_start')
  return { id, sha, readyAt: iso(raw.ready) }
}

/** Do not turn a missing, partial, duplicate or mixed-plan hour into zero bytes. */
export function neonHour(raw, window) {
  if (!Array.isArray(raw?.projects) || raw.projects.length !== 1 || raw.projects[0]?.project_id !== NEON_PROJECT) fail('neon_project_scope_invalid')
  const periods = raw.projects[0].periods
  if (!Array.isArray(periods)) fail('neon_periods_invalid')
  const buckets = [], seen = new Set()
  for (const period of periods) {
    const periodStart = Date.parse(period.period_start)
    if (!Number.isFinite(periodStart) || !Array.isArray(period.consumption)) fail('neon_period_invalid')
    for (const item of period.consumption) {
      const start = Date.parse(item.timeframe_start), end = Date.parse(item.timeframe_end)
      const metrics = Array.isArray(item.metrics) ? item.metrics.filter(metric => metric.metric_name === 'public_network_transfer_bytes') : []
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < window.start || end > window.end || metrics?.length !== 1
        || !Number.isSafeInteger(metrics[0].value) || metrics[0].value < 0) fail('neon_bucket_invalid')
      const key = start + ':' + end
      if (seen.has(key)) fail('neon_duplicate_hour')
      seen.add(key)
      buckets.push({ from: iso(start), to: iso(end), bytes: metrics[0].value, periodStart: iso(periodStart) })
    }
  }
  buckets.sort((a, b) => a.from.localeCompare(b.from))
  const complete = buckets.length === 1 && buckets[0].from === window.from && buckets[0].to === window.to
  return { projectId: NEON_PROJECT, orgId: NEON_ORG, metric: 'public_network_transfer_bytes', granularity: 'hourly',
    requestedFrom: window.from, requestedTo: window.to, reportedThrough: buckets.length ? buckets.at(-1).to : null,
    coverage: complete ? 'requested_hour_returned' : 'requested_hour_incomplete', bytes: complete ? buckets[0].bytes : null,
    buckets, scope: 'project_all_branches', finality: 'returned_provider_bucket_not_an_independent_billing_finality_receipt' }
}

/** Canonical CLI consults this catalog: count units prefer sum, then count.
 * Dimension names are passed through; the legacy snake_case spellings are not
 * implicitly mapped by the CLI. Keep the observed schema in the receipt. */
export function metricContract(raw, metric) {
  if (raw?.pagination?.hasMore !== false || !Array.isArray(raw.metrics)) fail('vercel_catalog_incomplete')
  const matches = raw.metrics.filter(value => value.id === metric)
  if (matches.length !== 1) fail('vercel_metric_unavailable')
  const found = matches[0]
  if (!Array.isArray(found.aggregations) || !Array.isArray(found.dimensions)) fail('vercel_catalog_invalid')
  if (typeof found.unit !== 'string' || !/^[a-z_]{1,32}$/.test(found.unit)) fail('vercel_unit_invalid')
  if (metric === COUNT && found.unit !== 'count') fail('vercel_count_unit_invalid')
  const aggregations = ['sum', 'count'].filter(value => found.aggregations.includes(value))
  const aggregation = aggregations[0]
  if (!aggregation || (metric === CPU && aggregation !== 'sum')) fail('vercel_aggregation_unavailable')
  const dimensions = ['route', 'environment', 'httpStatus', 'http_status', 'deploymentId', 'deployment_id'].filter(value => found.dimensions.includes(value))
  if (!dimensions.includes('route') || !dimensions.includes('environment')) fail('vercel_dimensions_unavailable')
  return { metric, unit: found.unit, aggregation, supportedAggregations: aggregations, dimensions }
}

export function metricDimensions(count, cpu) {
  const common = values => values.find(value => count.dimensions.includes(value) && cpu.dimensions.includes(value))
  const httpStatus = common(['httpStatus', 'http_status']), deploymentId = common(['deploymentId', 'deployment_id'])
  if (!httpStatus || !deploymentId) fail('vercel_dimensions_unavailable')
  return { route: 'route', httpStatus, deploymentId, environment: 'environment' }
}

function queryMetrics(metric, aggregation, window, dimensions) {
  return { ...metricQuery(metric, aggregation, window.deploymentId, window), groupBy: ['route', dimensions.httpStatus],
    filter: `environment:production AND ${dimensions.deploymentId}:"${window.deploymentId}"` }
}

function checkedMetrics(raw, metric, dimensions) {
  if (raw?.meta?.excludedIntervals?.length) fail('vercel_metric_intervals_excluded')
  return metricRows({ ...raw, summary: raw?.summary?.map(point => ({ ...point,
    dimensions: { route: point.dimensions?.route, httpStatus: point.dimensions?.[dimensions.httpStatus] } })) }, metric)
}

export async function collectHour({ input, vercelToken, neonToken, now = Date.now(), fetchImpl = fetch }) {
  let window
  const report = { version: 1, observedAt: iso(now), status: 'insufficient', productionAcceptance: false, reasons: [],
    scope: { teamId: TEAM, vercelProjectId: PROJECT, neonProjectId: NEON_PROJECT, neonOrgId: NEON_ORG },
    provenance: { checkerSha: /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA ?? '') ? process.env.GITHUB_SHA : 'local',
      workflowRunId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') ? process.env.GITHUB_RUN_ID : null },
    limitations: ['Workload duration, model provenance and visible client behavior require separate observation.',
      'Neon project totals include every branch and other traffic; Vercel groups cover only the selected production deployment.',
      'Historical connectivity smoke is never a before, after or idle acceptance window.'] }
  try { window = fixedHour(input, now); report.window = window } catch (error) { report.reasons.push(safeCode(error)); return report }
  const read = (path, body) => api(path, { token: vercelToken, body, fetchImpl })
  const values = await Promise.allSettled([
    (async () => {
      if (!vercelToken) fail('vercel_token_unavailable')
      const [before, selected] = await Promise.all([
        read('/v4/aliases/' + PRODUCTION_ALIAS).then(activeAlias),
        read('/v13/deployments/' + window.deploymentId).then(raw => selectedDeployment(raw, window)),
      ])
      const [countContract, cpuContract] = await Promise.all([COUNT, CPU].map(async metric => metricContract(await read('/metrics/v1?' +
        new URLSearchParams({ kind: 'system', limit: '250', search: metric, activeSince: window.from })), metric)))
      const dimensions = metricDimensions(countContract, cpuContract)
      const alternate = window.role === 'connectivity-smoke' && countContract.supportedAggregations.length === 2
        ? countContract.supportedAggregations.find(value => value !== countContract.aggregation) : null
      const [counts, cpu, alternateCounts] = await Promise.all([
        read('/metrics/v1', queryMetrics(COUNT, countContract.aggregation, window, dimensions)),
        read('/metrics/v1', queryMetrics(CPU, cpuContract.aggregation, window, dimensions)),
        alternate ? read('/metrics/v1', queryMetrics(COUNT, alternate, window, dimensions)) : null,
      ])
      const [after, selectedAfter] = await Promise.all([
        read('/v4/aliases/' + PRODUCTION_ALIAS).then(activeAlias),
        read('/v13/deployments/' + window.deploymentId).then(raw => selectedDeployment(raw, window)),
      ])
      if (before.deploymentId !== after.deploymentId || before.updatedAt !== after.updatedAt || JSON.stringify(selected) !== JSON.stringify(selectedAfter)) fail('deployment_changed_during_collection')
      const countRows = checkedMetrics(counts, COUNT, dimensions)
      const collected = aggregate(checkedMetrics(cpu, CPU, dimensions), countRows)
      const alternateRows = alternateCounts ? checkedMetrics(alternateCounts, COUNT, dimensions) : null
      const aggregationCheck = alternateRows ? { selectedAggregation: countContract.aggregation, alternateAggregation: alternate,
        selectedTotal: collected.requests, alternateTotal: [...alternateRows.values()].reduce((sum, row) => sum + row.value, 0),
        groupsMatch: alternateRows.size === countRows.size && [...countRows].every(([key, value]) => alternateRows.get(key)?.value === value.value),
        diagnosticOnly: true } : null
      return { deployment: selected, aliasAtCollection: before, aliasMatchedSelectedAtCollection: before.deploymentId === selected.id,
        measurement: 'function_invocation_observability_aggregates', metricContract: { count: countContract, cpu: cpuContract, dimensions,
          selectionBasis: 'current_vercel_cli_catalog_default_for_count_unit' }, aggregationCheck, ...collected }
    })(),
    (async () => {
      if (!neonToken) fail('neon_token_unavailable')
      const query = new URLSearchParams({ org_id: NEON_ORG, project_ids: NEON_PROJECT, from: window.from, to: window.to,
        granularity: 'hourly', metrics: 'public_network_transfer_bytes' })
      let response
      try { response = await fetchImpl('https://console.neon.tech/api/v2/consumption_history/v2/projects?' + query,
        { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000), headers: { authorization: 'Bearer ' + neonToken } }) }
      catch { fail('neon_api_network_unavailable') }
      if (!response.ok) fail('neon_api_http_' + response.status)
      let raw
      try { raw = await response.json() } catch { fail('neon_api_response_invalid') }
      return neonHour(raw, window)
    })(),
  ])
  for (const [index, result] of values.entries()) {
    if (result.status === 'fulfilled') report[index === 0 ? 'vercel' : 'neon'] = result.value
    else report.reasons.push(safeCode(result.reason))
  }
  if (report.neon && report.neon.coverage !== 'requested_hour_returned') report.reasons.push('neon_requested_hour_not_reported')
  report.status = report.reasons.length ? 'insufficient' : 'collected'
  return report
}

export function markdown(report) {
  const lines = ['## Fixed-hour egress collection: ' + report.status, '', 'Production acceptance: not established by this collector.',
    '', 'Reasons: ' + (report.reasons.join(', ') || 'none') + '.']
  if (report.window) lines.push('', 'Role: ' + report.window.role + '.', 'UTC window (end exclusive): ' + report.window.from + ' → ' + report.window.to + '.',
    'Selected deployment: ' + report.window.deploymentId + '.', 'Expected build: ' + (report.window.expectedBuild ?? 'not supplied for connectivity smoke') + '.')
  if (report.vercel) {
    lines.push('', 'Vercel invocations: ' + report.vercel.requests + '; CPU ms: ' + report.vercel.cpuMs + '; HTTP 5xx: ' + report.vercel.errors + '.',
      'Invocation aggregation: ' + report.vercel.metricContract.count.aggregation + '; provider status dimension: ' + report.vercel.metricContract.dimensions.httpStatus + '.',
      '', '| Route template | HTTP status | Invocations | CPU ms |', '| --- | ---: | ---: | ---: |')
    for (const row of report.vercel.groups) lines.push('| ' + row.route + ' | ' + row.httpStatus + ' | ' + row.requests + ' | ' + row.cpuMs + ' |')
    if (report.vercel.aggregationCheck) lines.push('', 'Connectivity diagnostic only: ' + JSON.stringify(report.vercel.aggregationCheck) + '.')
  }
  if (report.neon) lines.push('', 'Neon hour bytes: ' + (report.neon.bytes ?? 'not reported') + '. Reported through: ' + (report.neon.reportedThrough ?? 'unavailable') + '.',
    'Coverage: ' + report.neon.coverage + '; scope: all branches in the fixed project.')
  lines.push('', ...report.limitations.map(value => '- ' + value), '')
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--config') fail('usage_config_required')
    const content = await readFile(process.argv[3], 'utf8')
    if (content.length > 4096) fail('window_input_oversized')
    let input
    try { input = JSON.parse(content) } catch { fail('window_input_invalid') }
    report = await collectHour({ input, vercelToken: process.env.VERCEL_TEAM_TOKEN || process.env.VERCEL_TOKEN, neonToken: process.env.NEON_API_KEY })
  } catch (error) { report = { version: 1, status: 'insufficient', productionAcceptance: false, reasons: [safeCode(error)], limitations: [] } }
  await mkdir('fixed-hour-egress-report', { recursive: true })
  await writeFile('fixed-hour-egress-report/report.json', JSON.stringify(report, null, 2) + '\n')
  const summary = markdown(report)
  await writeFile('fixed-hour-egress-report/summary.md', summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(JSON.stringify({ status: report.status, role: report.window?.role ?? null, reasons: report.reasons }))
  if (report.status !== 'collected') process.exitCode = 1
}
