import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { api, activeAlias, TEAM, PROJECT, PRODUCTION_ALIAS } from './deployment-regression.mjs'

export const NEON_PROJECT = 'autumn-fire-21908520'
export const NEON_ORG = 'org-sweet-lab-80289846'
export const WINDOW_MS = 15 * 60_000
// The Launch plan's allowance: 500 GB of public network transfer per project per month, then $0.10/GB (Alex, 2026-11-06).
export const MONTHLY_BUDGET_BYTES = 500_000_000_000
// A day's share of the month's allowance.
export const DAILY_BUDGET_BYTES = Math.round(MONTHLY_BUDGET_BYTES / 30)
const iso = n => new Date(n).toISOString()
const fail = code => { throw Error(code) }
const safeError = e => /^[a-z_]+$/.test(e?.message) ? e.message : 'collection_failed'

/** Provider totals and sampled JSON sizes are different measurements; never add them together. */
export function neonUsage(raw, now = Date.now()) {
  const project = raw?.projects?.find(p => p.project_id === NEON_PROJECT)
  // The request filters to one project. Neon's cursor marks the last returned
  // item even on the final page; its presence does not mean more data exists.
  if (!project || raw.projects.length !== 1) fail('neon_usage_incomplete')
  const periods = project.periods.filter(p => Date.parse(p.period_start) <= now && (!p.period_end || Date.parse(p.period_end) > now))
  if (periods.length !== 1) fail('neon_period_unavailable')
  const period = periods[0], buckets = new Map()
  for (const bucket of period.consumption) {
    const start = Date.parse(bucket.timeframe_start), end = Date.parse(bucket.timeframe_end)
    const value = bucket.metrics?.find(m => m.metric_name === 'public_network_transfer_bytes')?.value
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isSafeInteger(value) || value < 0 || buckets.has(start)) fail('neon_usage_invalid')
    buckets.set(start, { start, end, value })
  }
  if (!buckets.size) fail('neon_usage_not_reported')
  const all = [...buckets.values()], latest = Math.max(...all.map(b => b.end))
  const latestHour = all.find(b => b.end === latest)
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0)
  return { periodStart: period.period_start, plan: period.period_plan,
    periodBytes: all.reduce((n, b) => n + b.value, 0),
    todayBytes: all.filter(b => b.start >= dayStart).reduce((n, b) => n + b.value, 0),
    latestBucketBytes: latestHour.value, reportedThrough: iso(latest),
    latestBucketStart: iso(latestHour.start), latestBucketEnd: iso(latestHour.end),
    stale: now - latest > 3 * 3_600_000,
    dailyBudgetBytes: DAILY_BUDGET_BYTES, monthlyBudgetBytes: MONTHLY_BUDGET_BYTES }
}

/** Whitelist aggregate fields. Raw log messages, SQL, user IDs and values never enter reports. */
export function summarize(events, deploymentId, now = Date.now(), environment = 'production') {
  const groups = new Map(), requests = new Map(), seen = new Set()
  let samples = 0, sampledBytes = 0, truncated = 0, malformed = 0
  for (const event of events) {
    if (event.deploymentId !== deploymentId || event.environment !== environment) fail('log_scope_mismatch')
    if (event.truncated) { truncated++; continue }
    for (const line of (typeof event.message === 'string' ? event.message : '').split('\n')) {
      let e
      try { e = JSON.parse(line) } catch { if (line.trim()) malformed++; continue }
      // Older samples lack timestamps/rate; report them as unusable rather than assuming coverage.
      const at = Date.parse(e.timestamp)
      if (!Number.isFinite(at) || at < now - WINDOW_MS || at >= now) continue
      if (e.msg === 'api_request' && typeof e.invocationId === 'string' && /^\/[A-Za-z0-9_/[\].-]+$/.test(e.route)) {
        if (seen.has(e.invocationId)) continue
        seen.add(e.invocationId)
        const r = requests.get(e.route) ?? { route: e.route, count: 0, errors: 0 }
        r.count++; if (e.status >= 500) r.errors++
        requests.set(e.route, r)
      }
      if (e.msg !== 'db_sample') continue
      if (!/^[a-f0-9]{12}$/.test(e.statement) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || !Number.isSafeInteger(e.rows) || e.rows < 0 || !(e.sampleRate > 0 && e.sampleRate <= 1)) { malformed++; continue }
      // A route template, or a background job label (after:…, cron:…, workflow:…; lib/background.ts).
      const route = typeof e.route === 'string' && /^(?:\/[A-Za-z0-9_/[\].-]+|(?:after|cron|workflow):[A-Za-z0-9_/.-]+)$/.test(e.route) ? e.route : null
      const key = JSON.stringify([route, e.statement]), g = groups.get(key) ?? { route, statement: e.statement, samples: 0, sampledBytes: 0, estimatedBytes: 0, rows: 0 }
      g.samples++; g.sampledBytes += e.bytes; g.estimatedBytes += e.bytes / e.sampleRate; g.rows += e.rows
      groups.set(key, g); samples++; sampledBytes += e.bytes
    }
  }
  return { samples, sampledBytes, truncated, malformed, requests: [...requests.values()],
    queries: [...groups.values()].sort((a,b) => b.estimatedBytes - a.estimatedBytes).slice(0, 30),
    measurement: 'sampled_json_result_bytes_not_wire_bytes', collection: 'best_effort' }
}

export async function run({ vercelToken, neonToken, now = Date.now(), fetchImpl = fetch, providerOnly = false, includeProviderUsage = true, containerWindow = /** @type {Awaited<ReturnType<typeof import('./cloudflare-container-logs.mjs').readContainerWindow>> | undefined} */ (undefined) }) {
  if (providerOnly && containerWindow || !includeProviderUsage && !containerWindow) fail('container_window_invalid')
  const report = { version: 1, observedAt: iso(now), windowStart: iso(now-WINDOW_MS), environment: containerWindow?.environment ?? 'production', reasons: [], status: 'insufficient',
    collectorSource: providerOnly ? 'cloudflare_provider_fallback' : 'github_runtime_collector', collectionScope: providerOnly ? 'provider' : 'provider_and_runtime' }
  const read = (path, body) => api(path, { token: vercelToken, body, fetchImpl, headers: { 'x-vercel-observability-query-reason': 'cli/logs-runtime' } })
  if (!providerOnly) try {
    if (containerWindow) {
      const { applicationId, environment, start, end, events } = containerWindow
      if (start !== now - WINDOW_MS || end !== now) fail('container_window_invalid')
      report.collectorSource = 'cloudflare_container_runtime'
      report.deploymentId = applicationId
      report.runtime = summarize(events, applicationId, now, environment)
    } else {
      if (!vercelToken) fail('vercel_token_unavailable')
      const alias = activeAlias(await read(`/v4/aliases/${PRODUCTION_ALIAS}`)), events = [], cursors = new Set()
      report.deploymentId = alias.deploymentId
      let cursor
      for (let page = 0; ; page++) {
        const response = await read('/v1/observability/events', { event: 'vercel.log', scope: { ownerId: TEAM, projectIds: [PROJECT] },
          timeRange: { start: iso(now-WINDOW_MS), end: iso(now) }, select: ['deploymentId','environment','message','truncated'],
          order: 'desc', limit: 1000, filter: `deploymentId:"${alias.deploymentId}" AND environment:production AND (db_sample OR api_request)`, ...(cursor ? {cursor} : {}) })
        if (!Array.isArray(response.events) || typeof response.pagination?.hasMore !== 'boolean') fail('log_response_invalid')
        events.push(...response.events)
        if (response.meta?.excludedIntervals?.length) fail('log_intervals_excluded')
        if (!response.pagination.hasMore) break
        const next = response.pagination.nextCursor
        if (page >= 9 || !next || cursors.has(next)) fail('log_pagination_incomplete')
        cursors.add(next); cursor = next
      }
      const after = activeAlias(await read(`/v4/aliases/${PRODUCTION_ALIAS}`))
      if (after.deploymentId !== alias.deploymentId || after.updatedAt !== alias.updatedAt) fail('deployment_changed')
      report.runtime = summarize(events, alias.deploymentId, now)
    }
    if (report.runtime.truncated || report.runtime.malformed) report.reasons.push('log_records_incomplete')
    if (!report.runtime.samples) report.reasons.push('no_database_samples')
  } catch(e) { report.reasons.push(safeError(e)) }
  if (!includeProviderUsage) {
    report.collectionScope = 'runtime'
    report.status = 'not_requested'
    return report
  }
  try {
    if (!neonToken) fail('neon_token_unavailable')
    const usage = async (from, granularity) => {
      const q = new URLSearchParams({org_id: NEON_ORG, project_ids: NEON_PROJECT, from: iso(from), to: iso(now), granularity, metrics: 'public_network_transfer_bytes'})
      const response = await fetchImpl(`https://console.neon.tech/api/v2/consumption_history/v2/projects?${q}`, {
        headers: {authorization: `Bearer ${neonToken}`}, redirect: 'error', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) fail('neon_usage_unavailable')
      return response.json()
    }
    const monthStart = new Date(now); monthStart.setUTCDate(1); monthStart.setUTCHours(0,0,0,0)
    const [dailyRaw, hourlyRaw] = await Promise.all([usage(monthStart.getTime(), 'daily'), usage(now-24*3_600_000, 'hourly')])
    const recent = neonUsage(hourlyRaw, now), dayStart = new Date(now).setUTCHours(0,0,0,0)
    // Neon rounds daily `to` down to midnight: today is supplied by hourly
    // buckets. An upgrade today legitimately has no completed daily buckets.
    let completedDays = 0
    if (Date.parse(recent.periodStart) < dayStart) {
      const month = neonUsage(dailyRaw, now)
      if (month.periodStart !== recent.periodStart) fail('neon_billing_period_changed')
      completedDays = month.periodBytes
    }
    report.neon = {...recent, periodBytes: completedDays + recent.todayBytes, latestHourBytes: recent.latestBucketBytes}
    if (report.neon.stale) report.reasons.push('neon_usage_stale')
  } catch(e) { report.reasons.push(safeError(e)) }
  report.status = report.reasons.length ? 'insufficient' : 'ok'
  return report
}

/** One snapshot per run; bounded aggregates, no per-request external calls. */
export async function publish(report, token, fetchImpl = fetch) {
  if (report.environment && report.environment !== 'production') fail('production_telemetry_required')
  if (report.collectionScope === 'runtime') fail('provider_snapshot_not_collected')
  if (!token) fail('posthog_token_unavailable')
  const properties = { distinct_id: 'mikka-operations', $process_person_profile: false, environment: 'production',
    collector_source: report.collectorSource, collection_scope: report.collectionScope,
    collection_healthy: report.reasons.every(reason => reason === 'no_database_samples') ? 1 : 0,
    provider_healthy: report.neon && !report.neon.stale ? 1 : 0,
    ...(report.collectionScope === 'provider' ? {} : { samples: report.runtime?.samples ?? 0,
      sampled_bytes: report.runtime?.sampledBytes ?? 0, request_count: report.runtime?.requests.reduce((n,r)=>n+r.count,0) ?? 0 }),
    ...(report.neon ? { period_bytes: report.neon.periodBytes, today_bytes: report.neon.todayBytes,
      latest_hour_bytes: report.neon.latestHourBytes,
      // Capture time can lag the provider's hour; preserve the actual bucket.
      latest_hour_start: report.neon.latestBucketStart, latest_hour_end: report.neon.latestBucketEnd,
      daily_budget_ratio: report.neon.todayBytes / DAILY_BUDGET_BYTES,
      monthly_budget_ratio: report.neon.periodBytes / MONTHLY_BUDGET_BYTES } : {}) }
  const batch = [{event:'mikka_ops_snapshot',timestamp:report.observedAt,properties}]
  batch.push(...runtimeEvents(report))
  await sendBatch(batch, token, fetchImpl)
}

function runtimeEvents(report) {
  const batch = []
  for (const q of report.runtime?.queries ?? []) batch.push({event:'mikka_ops_query_sample',timestamp:report.observedAt,
    properties:{distinct_id:'mikka-operations',$process_person_profile:false,environment:'production',route:q.route,statement:q.statement,
      samples:q.samples,sampled_bytes:q.sampledBytes,estimated_json_bytes:q.estimatedBytes,rows:q.rows}})
  for (const r of report.runtime?.requests ?? []) batch.push({event:'mikka_ops_route_requests',timestamp:report.observedAt,
    properties:{distinct_id:'mikka-operations',$process_person_profile:false,environment:'production',route:r.route,count:r.count,errors:r.errors}})
  return batch
}

async function sendBatch(batch, token, fetchImpl) {
  const response = await fetchImpl('https://us.i.posthog.com/batch/', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: {'content-type':'application/json'}, body: JSON.stringify({api_key: token, batch}) })
  if (!response.ok) fail('telemetry_delivery_failed')
}

/** Publish only Cloudflare runtime attribution. The existing scheduled provider
 * accounting job remains the sole publisher of mikka_ops_snapshot. */
export async function publishRuntimeAttribution(report, promotion, token, fetchImpl = fetch) {
  if (report.environment !== 'production' || report.collectionScope !== 'runtime' ||
    report.status !== 'not_requested' || report.neon || report.collectorSource !== 'cloudflare_container_runtime')
    fail('runtime_attribution_scope_invalid')
  if (!/^[1-9][0-9]{0,15}-[a-f0-9]{64}$/.test(promotion) || !token) fail('runtime_attribution_source_invalid')
  const end = Date.parse(report.observedAt)
  if (!Number.isSafeInteger(end) || end % WINDOW_MS !== 0 || Date.parse(report.windowStart) !== end - WINDOW_MS)
    fail('runtime_attribution_window_invalid')
  const batch = runtimeEvents(report).map(event => {
    // Supply the same PostHog UUID on an ambiguous retry of the same logical point.
    const hash = createHash('sha256').update(JSON.stringify([promotion,end,event.event,event.properties.route,
      event.properties.statement ?? null])).digest('hex')
    return { ...event, uuid:hash.slice(0,8)+'-'+hash.slice(8,12)+'-5'+hash.slice(13,16)+'-8'+hash.slice(17,20)+'-'+hash.slice(20,32) }
  })
  if (batch.length) await sendBatch(batch, token, fetchImpl)
  return batch.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const providerOnly=process.argv.length===3 && process.argv[2]==='--provider-only'
  if(process.argv.length!==2 && !providerOnly) fail('invalid_collector_mode')
  const report = await run({vercelToken:providerOnly?undefined:process.env.VERCEL_TEAM_TOKEN || process.env.VERCEL_TOKEN,
    neonToken:process.env.NEON_API_KEY,providerOnly})
  if(providerOnly) report.collectorSource='github_runtime_collector'
  try { await publish(report, process.env.NEXT_PUBLIC_POSTHOG_KEY) } catch(e) {report.reasons.push(safeError(e)); report.status='insufficient'}
  await mkdir('egress-monitor-report',{recursive:true})
  await writeFile('egress-monitor-report/report.json', JSON.stringify(report,null,2))
  const summary = `Database egress monitor: ${report.status}. Samples: ${report.runtime?.samples ?? 0}. Provider bytes: ${report.neon?.periodBytes ?? 'unavailable'}. Reasons: ${report.reasons.join(', ') || 'none'}.\n`
  console.log(summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  if (report.reasons.some(reason => reason !== 'no_database_samples')) process.exitCode=1
}
