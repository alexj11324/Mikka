// The existing bounded coordinator-traces queries, plus one exact trace lookup.
// Only span metadata is selected. The baseline workflow id is a supplied correlate,
// not an asserted PostHog attribute or a fabricated join.
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const TRACE = Object.freeze({ from: '2026-11-06T19:12:15Z', until: '2026-11-06T19:12:45Z',
  traceId: '96e5da44b7e53a0e09a9cc512f3b3522', workflowRunId: 'wrun_41M6S4DDPT0GXRWK0JQRX06QSW' })
const PROJECT = '670821'
const HOST = 'https://us.posthog.com'
const sqlDate = value => value.slice(0, 19).replace('T', ' ')
const baseWhere = `service_name = 'mikka-web'
  AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), nullIf(resource_attributes['deployment.environment'], '')) = 'production'
  AND timestamp >= toDateTime('${sqlDate(TRACE.from)}', 'UTC') AND timestamp < toDateTime('${sqlDate(TRACE.until)}', 'UTC')`
const coordinatorWhere = `${baseWhere}
  AND positionCaseInsensitive(attributes['mikka.route'], 'coordinator') > 0`
const sampleColumns = ['utc', 'trace_id', 'span_id', 'route', 'name', 'duration_ms', 'status_code']
const samples = where => `SELECT formatDateTime(toTimeZone(timestamp, 'UTC'), '%Y-%m-%d %H:%i:%S') AS utc,
  lower(hex(tryBase64Decode(trace_id))) AS trace_id,
  lower(hex(tryBase64Decode(span_id))) AS span_id,
  attributes['mikka.route'] AS route, name,
  round(duration_nano / 1000000, 2) AS duration_ms, status_code
FROM posthog.trace_spans WHERE ${where}
ORDER BY timestamp LIMIT 150`
export const QUERIES = Object.freeze([
  { name: 'coordinator_stage_aggregates', columns: ['route', 'name', 'sampled_count', 'mean_ms', 'max_ms'], sql: `
SELECT attributes['mikka.route'] AS route, name, count() AS sampled_count,
  round(avg(duration_nano) / 1000000, 2) AS mean_ms,
  round(max(duration_nano) / 1000000, 2) AS max_ms
FROM posthog.trace_spans WHERE ${coordinatorWhere}
GROUP BY route, name ORDER BY max_ms DESC LIMIT 60` },
  { name: 'coordinator_stage_samples', columns: sampleColumns, sql: samples(coordinatorWhere) },
  { name: 'exact_baseline_trace', columns: sampleColumns,
    sql: samples(`${baseWhere}\n  AND lower(hex(tryBase64Decode(trace_id))) = '${TRACE.traceId}'`) },
])

export async function readTraces({ env = process.env, fetchImpl = globalThis.fetch, checkpoint = true } = {}) {
  const report = { schemaVersion: 1, issue: 1506, phase: 'posthog-traces', project: PROJECT,
    from: TRACE.from, until: TRACE.until, traceId: TRACE.traceId, workflowRunId: TRACE.workflowRunId,
    workflowCorrelation: 'supplied_baseline_metadata_not_a_PostHog_join', status: 'observed',
    sampled: true, actualSamplingRateNotAssumed: true, modelCacheCountersObserved: false, productionWrites: 0, queries: [] }
  const rawKey = env.POSTHOG_PERSONAL_API_KEY
  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  // PostHog documents a Bearer personal API key, not a restricted client-side
  // character alphabet: https://posthog.com/docs/api/personal-api-keys
  // Only non-secret shape diagnostics are retained; no prefix, value or hash.
  report.credentialShape = { exists: typeof rawKey === 'string' && rawKey.length > 0,
    startsPhx: typeof rawKey === 'string' && rawKey.startsWith('phx_'),
    hasWhitespace: typeof rawKey === 'string' && /\s/.test(rawKey), length: typeof rawKey === 'string' ? rawKey.length : 0 }
  if ((env.MIKKA_TRACE_FROM && env.MIKKA_TRACE_FROM !== TRACE.from) || (env.MIKKA_TRACE_UNTIL && env.MIKKA_TRACE_UNTIL !== TRACE.until)) {
    report.status = 'incomplete'; report.error = 'trace_window_invalid'
  } else if (!key) {
    report.status = 'incomplete'; report.error = 'trace_credential_missing'
  } else if (/^phc(?:_|-)/i.test(key) || key.length > 8192 || /[\r\n\u0000]/.test(key)) {
    report.status = 'incomplete'; report.error = 'trace_credential_invalid'
  } else for (const query of QUERIES) {
    const row = { name: query.name, columns: query.columns, status: 'failed' }
    report.queries.push(row)
    try {
      const response = await fetchImpl(`${HOST}/api/projects/${PROJECT}/query/`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query: { kind: 'HogQLQuery', query: query.sql }, name: `issue-1506-${query.name}`, refresh: 'force_blocking' }),
      })
      row.httpStatus = response.status
      if (!response.ok) { await response.body?.cancel(); throw new Error('trace_http_failed') }
      const result = await response.json()
      if (!Array.isArray(result.results) || result.results.length > 150 || !Array.isArray(result.columns)
        || JSON.stringify(result.columns) !== JSON.stringify(query.columns)) throw new Error('trace_result_invalid')
      const safeText = value => typeof value === 'string' && value.length <= 240 && /^[A-Za-z0-9_ .:/\[\]<>(),?@#=+{}$\-]*$/.test(value)
      if (result.results.some(values => !Array.isArray(values) || values.length !== query.columns.length
        || values.some(value => !(typeof value === 'number' && Number.isFinite(value)) && !safeText(value)))) throw new Error('trace_result_invalid')
      if (query.name === 'exact_baseline_trace' && result.results.some(values => values[1] !== TRACE.traceId)) throw new Error('trace_result_invalid')
      row.rows = result.results
      row.status = 'observed'
    } catch (error) {
      row.error = ['trace_http_failed', 'trace_result_invalid'].includes(error?.message) ? error.message : 'trace_request_failed'
      report.status = 'incomplete'
    }
  }
  const exact = report.queries.find(query => query.name === 'exact_baseline_trace')
  report.targetTraceObserved = exact?.status === 'observed' && exact.rows.length > 0
  report.absenceMeaning = 'sampling_or_export_or_filter_may_hide_spans;absence_is_not_zero_latency_or_cache_evidence'
  if (checkpoint) {
    mkdirSync('issue-1506-readonly-report', { recursive: true })
    writeFileSync('issue-1506-readonly-report/coordinator-traces.json', JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await readTraces()
  console.log(JSON.stringify(report))
  if (report.status !== 'observed') process.exitCode = 1
}
