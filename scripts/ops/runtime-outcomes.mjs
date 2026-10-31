import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { activeAlias, api, PROJECT, PRODUCTION_ALIAS, TEAM } from './deployment-regression.mjs'
import { emptyOutcomeMetric, requestOutcomes, WINDOW_MS } from './request-outcomes.mjs'

export const ROUTES = ['/v1/devices/[deviceId]/fs/requests', '/v1/devices/[deviceId]/commands', '/api/webhooks/github']
export const POLICY = { windowMs: WINDOW_MS, requestGraceMs: 120_000, pageSize: 1000, maximumPages: 10 }
const iso = value => new Date(value).toISOString()
const fail = code => { throw new Error(code) }
const marked = entry => ['empty', 'work', 'ignored'].includes(entry.outcome)

export function logQuery(deploymentId, now, cursor) {
  if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId) || !Number.isSafeInteger(now)) fail('runtime_scope_invalid')
  return { event: 'vercel.log', scope: { ownerId: TEAM, projectIds: [PROJECT] },
    timeRange: { start: iso(now - WINDOW_MS), end: iso(now) },
    select: ['deploymentId', 'environment', 'message', 'truncated'], order: 'desc', limit: POLICY.pageSize,
    filter: `deploymentId:"${deploymentId}" AND environment:production AND (api_request OR api_request_started)`,
    ...(cursor ? { cursor } : {}) }
}

/** Only fixed route templates and known logger fields cross this boundary. */
export function readEntries(events, deploymentId) {
  const entries = [], counts = { truncated: 0, malformed: 0 }
  for (const event of events) {
    if (event.deploymentId !== deploymentId || event.environment !== 'production') fail('runtime_event_scope_mismatch')
    if (event.truncated === true) { counts.truncated++; continue }
    if (typeof event.message !== 'string') { counts.malformed++; continue }
    for (const line of event.message.split('\n').filter(line => line.trim())) {
      let entry
      try { entry = JSON.parse(line) } catch { counts.malformed++; continue }
      if (!entry || !ROUTES.includes(entry.route) || !['api_request_started', 'api_request'].includes(entry.msg)) continue
      entries.push({ route: entry.route, msg: entry.msg, timestamp: entry.timestamp, invocationId: entry.invocationId,
        status: entry.status, outcome: entry.outcome, ...(entry.error ? { error: true } : {}) })
    }
  }
  return { entries, counts }
}

export function coverageFor(entries, now) {
  const starts = new Map(), ends = new Map(), counts = { matureStarts: 0, missingCompletions: 0, unmarkedSuccessful: 0, unwindowed: 0 }
  for (const entry of entries) {
    if (!Number.isFinite(Date.parse(entry.timestamp)) || typeof entry.invocationId !== 'string') { counts.unwindowed++; continue }
    ;(entry.msg === 'api_request_started' ? starts : ends).set(entry.invocationId, entry)
  }
  for (const end of ends.values()) {
    const at = Date.parse(end.timestamp)
    if (at >= now - WINDOW_MS && at <= now && end.status >= 200 && end.status < 400 && !marked(end)) counts.unmarkedSuccessful++
  }
  for (const [id, start] of starts) {
    const at = Date.parse(start.timestamp)
    if (at < now - WINDOW_MS || at > now - POLICY.requestGraceMs) continue
    counts.matureStarts++
    const end = ends.get(id), finished = Date.parse(end?.timestamp)
    if (!end || end.route !== start.route || finished < at || finished > now) counts.missingCompletions++
  }
  return counts
}

export async function run({ token, now = Date.now(), fetchImpl = fetch }) {
  const report = { version: 1, status: 'insufficient', reasons: [], observedAt: iso(now),
    window: { start: iso(now - WINDOW_MS), end: iso(now) }, sampling: 'best_effort', policy: POLICY,
    scope: { ownerId: TEAM, projectId: PROJECT, environment: 'production' }, pages: 0, records: 0,
    excludedIntervals: 0, truncated: 0, malformed: 0, outcomes: Object.fromEntries(ROUTES.map(route => [route, emptyOutcomeMetric()])) }
  const entries = []
  const read = (path, body) => api(path, { token, body, fetchImpl, headers: { 'x-vercel-observability-query-reason': 'cli/logs-runtime' } })
  try {
    if (!token) fail('vercel_token_unavailable')
    const before = activeAlias(await read(`/v4/aliases/${PRODUCTION_ALIAS}`))
    report.scope.deploymentId = before.deploymentId
    report.scope.aliasUpdatedAt = before.updatedAt
    const cursors = new Set()
    let cursor
    for (;;) {
      const page = await read('/v1/observability/events', logQuery(before.deploymentId, now, cursor))
      if (!Array.isArray(page?.events) || typeof page.pagination?.hasMore !== 'boolean' ||
        !(page.pagination.nextCursor === null || typeof page.pagination.nextCursor === 'string') ||
        (page.meta?.excludedIntervals !== undefined && !Array.isArray(page.meta.excludedIntervals))) fail('runtime_response_invalid')
      report.pages++; report.records += page.events.length
      report.excludedIntervals += page.meta?.excludedIntervals?.length ?? 0
      const parsed = readEntries(page.events, before.deploymentId)
      entries.push(...parsed.entries); report.truncated += parsed.counts.truncated; report.malformed += parsed.counts.malformed
      if (!page.pagination.hasMore) break
      if (report.pages >= POLICY.maximumPages) fail('runtime_page_budget_exceeded')
      const next = page.pagination.nextCursor
      if (!next || cursors.has(next)) fail('runtime_pagination_incomplete')
      cursors.add(next); cursor = next
    }
    const after = activeAlias(await read(`/v4/aliases/${PRODUCTION_ALIAS}`))
    if (before.deploymentId !== after.deploymentId || before.updatedAt !== after.updatedAt) fail('runtime_deployment_changed')
  } catch (error) {
    report.reasons.push(error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'runtime_collection_unavailable')
  }
  Object.assign(report.outcomes, requestOutcomes(entries, now))
  report.coverage = coverageFor(entries, now)
  if (report.excludedIntervals) report.reasons.push('runtime_intervals_excluded')
  if (report.truncated) report.reasons.push('runtime_records_truncated')
  if (report.malformed) report.reasons.push('runtime_records_malformed')
  if (report.coverage.unwindowed) report.reasons.push('runtime_records_unwindowed')
  if (report.coverage.missingCompletions) report.reasons.push('runtime_completions_missing')
  if (report.coverage.unmarkedSuccessful) report.reasons.push('runtime_outcomes_missing')
  if (!Object.values(report.outcomes).some(metric => metric.empty + metric.work + metric.ignored > 0)) report.reasons.push('runtime_no_classified_samples')
  report.status = report.reasons.length ? 'insufficient' : 'pass'
  report.healthy = report.reasons.every(reason => reason === 'runtime_no_classified_samples')
  return report
}

export function markdown(report) {
  const lines = [`## Runtime outcomes: ${report.status}`, '', `Reasons: ${report.reasons.join(', ') || 'none'}.`,
    '', `UTC window: ${report.window.start} → ${report.window.end}; deployment: ${report.scope.deploymentId ?? 'unavailable'}.`,
    '', 'Vercel runtime pagination is best effort; equal-timestamp page boundaries can repeat or skip records. Counts describe observed structured logs, not a complete request or billing denominator.',
    '', '| Route | Requests observed | Completed pairs | Empty | Work | Ignored | Unknown | Empty ratio | Outcome coverage |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
  for (const [route, metric] of Object.entries(report.outcomes)) lines.push(`| ${route} | ${metric.count} | ${metric.completed} | ${metric.empty} | ${metric.work} | ${metric.ignored} | ${metric.unknown} | ${metric.emptyRatio === null ? 'unknown' : (metric.emptyRatio * 100).toFixed(2) + '%'} | ${metric.coverage === null ? 'unknown' : (metric.coverage * 100).toFixed(2) + '%'} |`)
  lines.push('', 'Empty ratio alone does not trigger an alert. Missing samples, exclusions, truncated records and collection failures remain insufficient evidence.', '')
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await run({ token: process.env.VERCEL_TEAM_TOKEN }), summary = markdown(report)
  await mkdir('runtime-outcomes-report', { recursive: true })
  await writeFile('runtime-outcomes-report/report.json', JSON.stringify(report, null, 2) + '\n')
  await writeFile('runtime-outcomes-report/summary.md', summary)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary)
  console.log(JSON.stringify({ status: report.status, reasons: report.reasons }))
  if (!report.healthy) {
    console.error('::error::Runtime outcome coverage is insufficient; repository-maintainers must inspect runtime-outcomes-report/report.json and the operational runbook.')
    process.exitCode = 1
  } else if (report.status !== 'pass') console.warn('::warning::No classified runtime samples in this window; outcome ratios remain unknown.')
}
