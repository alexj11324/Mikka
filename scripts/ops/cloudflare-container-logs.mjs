import { run as egressReport } from './egress-monitor.mjs'
import { WINDOW_MS } from './request-outcomes.mjs'
import { run as outcomeReport } from './runtime-outcomes.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const fields = ['msg', 'timestamp', 'invocationId', 'route', 'status', 'outcome', 'error', 'statement', 'bytes', 'rows', 'sampleRate']
const payloadKinds = new Set(['api_request_started', 'api_request', 'db_sample'])
const limit = 1000
const maxQueries = 10
const fail = code => { throw Error(code) }

export function containerApplicationId(value) {
  if (typeof value !== 'string') fail('container_application_invalid')
  const id = value.replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/, '$1-$2-$3-$4-$5')
  if (!uuid.test(id)) fail('container_application_invalid')
  return id
}

/** A Container application has its own log stream. deploymentId in a
 * Container event identifies an instance, not a deployed product version. */
export async function readContainerWindow({ application, environment, now, read }) {
  const app = containerApplicationId(application)
  if (!['production', 'staging'].includes(environment) || !Number.isSafeInteger(now)) fail('container_window_invalid')
  const start = now - WINDOW_MS, found = new Map()
  let pages = 0, records = 0
  async function visit(from, to) {
    if (++pages > maxQueries) fail('container_log_query_budget_exceeded')
    const result = await read({
      queryId: 'mikka-container-runtime-window', view: 'events', limit, timeframe: { from, to },
      parameters: { datasets: ['containers'], filters: [{ key: '$metadata.service', type: 'string', operation: 'eq', value: app }] },
    })
    const section = result?.events, rows = section?.events
    if (!Array.isArray(rows) || rows.length > limit || !Number.isSafeInteger(section.count) ||
      section.count < rows.length || result.statistics?.abr_level !== 1) fail('container_log_response_incomplete')
    // Cloudflare can return count == limit on a truncated window. Never use
    // the count as a complete denominator or advance past equal timestamps.
    if (rows.length === limit || section.count !== rows.length) {
      if (to - from <= 1 || pages >= maxQueries) fail('container_log_window_saturated')
      const mid = from + Math.floor((to - from) / 2)
      await visit(from, mid)
      await visit(mid, to)
      return
    }
    for (const row of rows) {
      if (row.dataset !== 'containers' || row.$metadata?.type !== 'cf-container' ||
        row.$metadata?.service !== app || row.$containers?.applicationId !== app ||
        !row.$metadata?.id || typeof row.$metadata.id !== 'string' ||
        !Number.isSafeInteger(row.timestamp) || row.timestamp < from || row.timestamp > to) fail('container_log_scope_mismatch')
      if (row.timestamp === now) continue
      if (row.$metadata.truncated || row.$containers.truncated) fail('container_log_records_truncated')
      const value = row.source
      if (typeof value === 'string' && /api_request|db_sample/.test(value)) fail('container_log_record_malformed')
      if (!value || typeof value !== 'object' || !payloadKinds.has(value.msg)) continue
      // Drop provider metadata, raw URLs, SQL, bodies and identities before
      // forwarding structured entries to the existing report consumers.
      const message = JSON.stringify(Object.fromEntries(fields.filter(key => Object.hasOwn(value, key))
        .map(key => [key, key === 'error' ? Boolean(value.error) : value[key]])))
      const record = { deploymentId: app, environment, message, truncated: row.$metadata.truncated === true }
      const previous = found.get(row.$metadata.id)
      if (previous && (previous.message !== message || previous.truncated !== record.truncated)) fail('container_log_id_conflict')
      found.set(row.$metadata.id, record)
    }
    records += rows.length
  }
  await visit(start, now)
  return { applicationId: app, environment, start, end: now, pages, records, events: [...found.values()] }
}

/** The protected caller verifies the live release and returns its immutable
 * application identity on each side of the read. A source change discards
 * the complete window before it reaches either report or any alert sink. */
export async function collectContainerReports({ target, read, neonToken, fetchImpl = fetch, now = Date.now() }) {
  const before = await target()
  if (!/^[a-f0-9]{40}$/.test(before.source) || !uuid.test(before.apiVersion)) fail('container_release_invalid')
  const window = await readContainerWindow({ application: before.application, environment: before.environment, read, now })
  const [outcomes, egress] = await Promise.all([
    outcomeReport({ now, containerWindow: window }),
    egressReport({ now, containerWindow: window, neonToken, fetchImpl }),
  ])
  const after = await target()
  if (before.source !== after.source || before.apiVersion !== after.apiVersion || before.environment !== after.environment ||
    window.applicationId !== containerApplicationId(after.application)) fail('container_release_changed')
  return { source: before.source, apiVersion: before.apiVersion, applicationId: window.applicationId, outcomes, egress }
}
