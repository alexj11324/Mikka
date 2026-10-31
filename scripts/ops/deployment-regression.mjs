import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
export const PRODUCTION_ALIAS = 'app.aspectlylabs.com'
export const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH'
export const SCOPE = { ownerId: TEAM, projectIds: [PROJECT] }
export const POLICY = { windowMs: 300_000, warmupMs: 120_000, minimumInvocations: 20,
  cpuRatio: 2, cpuDeltaMs: 100, errorRateDelta: .05, maximumTrafficRatio: 2, maximumRouteShareDelta: .2 }
const CPU = 'vercel.function_invocation.function_cpu_time_ms'
const COUNT = 'vercel.function_invocation.count'
const GROUP_LIMIT = 100
const fail = code => { throw new Error(code) }
const iso = value => new Date(value).toISOString()

export function deployment(raw) {
  const id = raw?.id ?? raw?.uid, sha = raw?.gitSource?.sha ?? raw?.meta?.githubCommitSha, ready = raw?.ready
  if (!/^dpl_[A-Za-z0-9]+$/.test(id) || !/^[a-f0-9]{40}$/.test(sha) ||
      !Number.isSafeInteger(ready) || ready <= 0 || raw.target !== 'production' || raw.readyState !== 'READY' ||
      (raw.projectId !== undefined && raw.projectId !== PROJECT) || raw.aliasAssigned !== true ||
      (raw.meta?.githubCommitSha && raw.meta.githubCommitSha !== sha)) fail('deployment_metadata_invalid')
  const assignedAt = raw.aliasAssignedAt
  if (!Number.isSafeInteger(assignedAt) || assignedAt < ready) fail('deployment_activation_invalid')
  return { id, sha, ready, assignedAt, url: typeof raw.url === 'string' && /^[a-z0-9-]{1,200}\.vercel\.app$/.test(raw.url) ? raw.url : undefined }
}

export function activeAlias(raw) {
  if (raw?.alias !== PRODUCTION_ALIAS || raw.projectId !== PROJECT || !/^dpl_[A-Za-z0-9]+$/.test(raw.deploymentId) ||
      !Number.isSafeInteger(raw.updatedAt) || raw.updatedAt <= 0) fail('production_alias_invalid')
  return { hostname: PRODUCTION_ALIAS, deploymentId: raw.deploymentId, updatedAt: raw.updatedAt }
}

export function comparisonWindows(before, after, now = Date.now()) {
  const activation = after.assignedAt ?? after.ready
  const end = Math.floor(activation / POLICY.windowMs) * POLICY.windowMs
  const start = Math.ceil((activation + POLICY.warmupMs) / POLICY.windowMs) * POLICY.windowMs
  if (before.id === after.id || (before.assignedAt ?? before.ready) > end - POLICY.windowMs || (before.assignedAt ?? before.ready) >= activation) fail('deployment_boundary_invalid')
  const windows = { before: { start: end - POLICY.windowMs, end }, after: { start, end: start + POLICY.windowMs } }
  if (windows.after.end > now) fail('window_not_complete')
  return windows
}

// Body follows the current Vercel CLI's canonical /metrics/v1 query; verified against live CPU/count aggregates.
export function metricQuery(metric, aggregation, id, window) {
  if (!/^dpl_[A-Za-z0-9]+$/.test(id)) fail('deployment_id_invalid')
  return { scope: SCOPE, timeRange: { start: iso(window.start), end: iso(window.end) }, bucketSeconds: 300,
    groupBy: ['route', 'httpStatus'], filter: `environment:production AND deploymentId:"${id}"`,
    metrics: { value: { metric, aggregation } }, outputs: ['value'],
    seriesSelection: { limit: GROUP_LIMIT, mode: 'exact', rankBy: [{ metric: 'value', direction: 'desc' }] } }
}

export function metricRows(response, metric) {
  if (!Array.isArray(response?.summary) || response.summary.length >= GROUP_LIMIT) fail('metric_groups_missing_or_truncated')
  const rows = new Map()
  for (const point of response.summary) {
    const row = point.dimensions
    // Only route templates and status codes leave the API boundary; never request paths or payloads.
    if (typeof row?.route !== 'string' || !/^\/[A-Za-z0-9_./\[\]()-]{0,250}$/.test(row.route) ||
        !/^[1-5]\d\d$/.test(String(row.httpStatus))) fail('metric_dimensions_invalid')
    const value = point.values?.value
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (metric === COUNT && !Number.isSafeInteger(value))) fail('metric_value_invalid')
    const key = JSON.stringify([row.route, String(row.httpStatus)])
    if (rows.has(key)) fail('metric_duplicate_group')
    rows.set(key, { route: row.route, httpStatus: String(row.httpStatus), value })
  }
  return rows
}

export function aggregate(cpu, counts) {
  if (cpu.size !== counts.size || [...cpu.keys()].some(key => !counts.has(key))) fail('cpu_request_scope_mismatch')
  const groups = [...counts].map(([key, item]) => ({ route: item.route, httpStatus: item.httpStatus,
    requests: item.value, cpuMs: cpu.get(key).value, cpuPerRequestMs: item.value ? cpu.get(key).value / item.value : null }))
  const requests = groups.reduce((sum, row) => sum + row.requests, 0)
  const cpuMs = groups.reduce((sum, row) => sum + row.cpuMs, 0)
  const errors = groups.filter(row => Number(row.httpStatus) >= 500).reduce((sum, row) => sum + row.requests, 0)
  return { requests, errors, cpuMs, cpuPerRequestMs: requests ? cpuMs / requests : null,
    errorRate: requests ? errors / requests : null, groups }
}

export function compare(before, after) {
  const result = { status: 'insufficient', reasons: [], before, after }
  const pairs = new Map(before.groups.map(row => [JSON.stringify([row.route, row.httpStatus]), row]))
  if (!before.requests || !after.requests) result.reasons.push('no_invocations')
  if (before.requests < POLICY.minimumInvocations || after.requests < POLICY.minimumInvocations) result.reasons.push('sample_below_minimum')
  if (result.reasons.length) return result
  // Error growth is actionable even when changed status groups prevent a CPU comparison.
  const errorGrowth = BigInt(after.errors) * BigInt(before.requests) - BigInt(before.errors) * BigInt(after.requests)
  // Compare integer counts so an exact 5 percentage point increase stays on the boundary.
  if (errorGrowth * 100n > BigInt(Math.round(POLICY.errorRateDelta * 100)) * BigInt(before.requests) * BigInt(after.requests)) return { ...result, status: 'regression', reasons: ['server_error_rate_increased'] }
  if (before.groups.length !== after.groups.length || after.groups.some(row => !pairs.has(JSON.stringify([row.route, row.httpStatus]))))
    return { ...result, status: 'not_comparable', reasons: ['route_or_status_groups_changed'] }
  const trafficRatio = after.requests / before.requests
  if (trafficRatio > POLICY.maximumTrafficRatio || trafficRatio < 1 / POLICY.maximumTrafficRatio)
    return { ...result, status: 'not_comparable', reasons: ['traffic_volume_changed'] }
  const regressions = []
  for (const current of after.groups) {
    const prior = pairs.get(JSON.stringify([current.route, current.httpStatus]))
    if (prior.requests < POLICY.minimumInvocations || current.requests < POLICY.minimumInvocations) result.reasons.push('group_sample_below_minimum')
    if (Math.abs(prior.requests / before.requests - current.requests / after.requests) > POLICY.maximumRouteShareDelta) result.reasons.push('traffic_mix_changed')
    if (current.cpuPerRequestMs > prior.cpuPerRequestMs * POLICY.cpuRatio && current.cpuPerRequestMs - prior.cpuPerRequestMs > POLICY.cpuDeltaMs)
      regressions.push({ route: current.route, httpStatus: current.httpStatus })
  }
  if (result.reasons.includes('traffic_mix_changed')) return { ...result, status: 'not_comparable', reasons: [...new Set(result.reasons)] }
  if (result.reasons.length) return { ...result, reasons: [...new Set(result.reasons)] }
  return { ...result, status: regressions.length ? 'regression' : 'pass', reasons: regressions.length ? ['cpu_per_invocation_increased'] : [], regressions }
}

export async function api(path, { token, body, headers = {}, fetchImpl = fetch }) {
  const url = new URL(path, 'https://api.vercel.com')
  if (url.origin !== 'https://api.vercel.com') fail('api_origin_invalid')
  url.searchParams.set('teamId', TEAM)
  let response
  try {
    response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: { ...headers, authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000), redirect: 'error' })
  } catch { fail('vercel_api_network_unavailable') }
  if (!response.ok) fail(`vercel_api_http_${response.status}`)
  try { return await response.json() } catch { fail('vercel_api_response_invalid') }
}

export function markdown(report) {
  const lines = [`## Deployment resource comparison: ${report.status}`, '', `Reasons: ${report.reasons.join(', ') || 'none'}.`,
    '', 'Scope: Vercel function-invocation observability aggregates; production, project Mikka, route template + HTTP status. This is sampled observability, not a complete billing total.',
    '', 'Initial policy (project choice, not an industry standard): 20 invocations per group, CPU >2× and >100 ms/invocation increase; server errors >5 percentage points; traffic within 2× and group shares within 20 percentage points.']
  if (report.productionAlias) lines.push('', `Production alias: ${report.productionAlias.hostname} → \`${report.productionAlias.deploymentId}\`; assignment version ${report.productionAlias.updatedAt}.`)
  for (const name of ['before', 'after']) {
    const item = report.deployments?.[name], window = report.windows?.[name], metrics = report[name]
    if (item) lines.push('', `${name}: \`${item.id}\`, SHA \`${item.sha}\`, READY ${iso(item.ready)}.`)
    if (item?.assignedAt) lines.push(`Production alias assignment: ${iso(item.assignedAt)}.`)
    if (window) lines.push(`UTC window: ${iso(window.start)} → ${iso(window.end)} (end exclusive).`)
    if (metrics) lines.push(`CPU: ${metrics.cpuMs.toFixed(2)} ms; invocations: ${metrics.requests}; CPU/invocation: ${metrics.cpuPerRequestMs?.toFixed(2) ?? 'unavailable'} ms; server error rate: ${metrics.errorRate === null ? 'unavailable' : (metrics.errorRate * 100).toFixed(2) + '%'}.`)
  }
  if (report.regressions?.length) lines.push('', `Regressed groups: ${report.regressions.map(row => `\`${row.route}\` (${row.httpStatus})`).join(', ')}.`)
  lines.push('', 'Duration and memory: not evaluated. No automatic rollback: database migration compatibility is unverified.')
  if (report.rollback) lines.push(`Prior deployment candidate (verify health and migration compatibility): \`${report.rollback.id}\`.`, `Operator command after verification: \`${report.rollback.command}\`.`)
  lines.push('', `Checker SHA: \`${report.provenance.checkerSha}\`; workflow run: ${report.provenance.runUrl}.`, '')
  return lines.join('\n')
}

export async function run({ token, event = {}, eventName, now = Date.now(), fetchImpl = fetch }) {
  const report = { version: 1, status: 'insufficient', reasons: [], observedAt: iso(now), scope: SCOPE, policy: POLICY,
    provenance: { checkerSha: /^[a-f0-9]{40}$/.test(process.env.DEPLOYMENT_COMPARISON_CHECKER_SHA ?? '') ? process.env.DEPLOYMENT_COMPARISON_CHECKER_SHA : 'local', runUrl: process.env.GITHUB_RUN_ID ? `https://github.com/alexj11324/Mikka/actions/runs/${process.env.GITHUB_RUN_ID}` : 'local' } }
  const read = (path, body) => api(path, { token, body, fetchImpl })
  try {
    if (!token) fail('vercel_token_unavailable')
    const active = activeAlias(await read(`/v4/aliases/${PRODUCTION_ALIAS}`))
    report.productionAlias = active
    const listed = await read(`/v6/deployments?projectId=${PROJECT}&target=production&state=READY&limit=100`)
    if (!Array.isArray(listed.deployments) || listed.deployments.length < 2) fail('deployment_pair_unavailable')
    const details = await Promise.all(listed.deployments.slice(0, 3).map(item => read(`/v13/deployments/${encodeURIComponent(item.uid ?? item.id)}`)))
    const candidates = details.filter(item => item.aliasAssigned === true).map(deployment).sort((a, b) => b.assignedAt - a.assignedAt)
    const after = candidates.find(item => item.id === active.deploymentId)
    if (!after || (listed.deployments[0]?.uid ?? listed.deployments[0]?.id) !== after.id) fail('active_deployment_is_not_latest_ready')
    const before = candidates.find(item => item.assignedAt < after.assignedAt)
    if (!before) fail('deployment_pair_unavailable')
    report.deployments = { before, after }
    report.rollback = { id: before.id, command: `vercel rollback ${before.id} --scope mikka-dev` }
    if (eventName === 'deployment_status') {
      if (event.deployment_status?.state !== 'success' || event.deployment?.environment !== 'Production' || event.deployment?.sha !== after.sha)
        fail('deployment_event_mismatch')
      // Same-SHA redeploys need an immutable event reference; a SHA alone does not identify a deployment.
      const target = event.deployment_status?.target_url
      let host
      try { const url = new URL(target); if (url.protocol === 'https:' && url.hostname.endsWith('.vercel.app')) host = url.hostname } catch { /* no immutable deployment URL */ }
      if (!host || host !== after.url) fail('deployment_event_reference_unavailable')
      const pinned = deployment(await read(`/v13/deployments/${encodeURIComponent(host)}`))
      if (pinned.id !== after.id || pinned.sha !== event.deployment.sha) fail('deployment_event_mismatch')
    }
    const windows = comparisonWindows(before, after, now)
    report.windows = windows
    const values = await Promise.all(['before', 'after'].map(async name => {
      const id = report.deployments[name].id, window = windows[name]
      const [cpu, counts] = await Promise.all([read('/metrics/v1', metricQuery(CPU, 'sum', id, window)), read('/metrics/v1', metricQuery(COUNT, 'count', id, window))])
      return aggregate(metricRows(cpu, CPU), metricRows(counts, COUNT))
    }))
    // Re-read after queries so a deployment completed during the run cannot be silently accepted.
    const [latest, activeAfter, metadataAfter] = await Promise.all([
      read(`/v6/deployments?projectId=${PROJECT}&target=production&state=READY&limit=1`),
      read(`/v4/aliases/${PRODUCTION_ALIAS}`).then(activeAlias),
      read(`/v13/deployments/${after.id}`).then(deployment),
    ])
    if ((latest.deployments?.[0]?.uid ?? latest.deployments?.[0]?.id) !== after.id ||
        activeAfter.deploymentId !== active.deploymentId || activeAfter.updatedAt !== active.updatedAt ||
        metadataAfter.sha !== after.sha || metadataAfter.assignedAt !== after.assignedAt) fail('deployment_changed_during_comparison')
    Object.assign(report, compare(...values))
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'comparison_unavailable'
    report.status = 'insufficient'; report.reasons = [code]
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let event = {}
  try { if (process.env.GITHUB_EVENT_PATH) event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')) } catch { /* invalid event fails pinning */ }
  const report = await run({ token: process.env.VERCEL_TEAM_TOKEN, event, eventName: process.env.GITHUB_EVENT_NAME })
  const summary = markdown(report)
  await mkdir('deployment-comparison-report', { recursive: true })
  await writeFile('deployment-comparison-report/report.json', JSON.stringify(report, null, 2) + '\n')
  await writeFile('deployment-comparison-report/summary.md', summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(JSON.stringify({ status: report.status, reasons: report.reasons }))
  if (report.status === 'regression') { console.error('::error::Deployment resource regression; inspect the aggregate report and verify database compatibility before operator rollback.'); process.exitCode = 1 }
  else if (report.status !== 'pass') console.warn(`::warning::Deployment comparison ${report.status}: ${report.reasons.join(', ')}`)
}
