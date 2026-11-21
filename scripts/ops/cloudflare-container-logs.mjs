import { capacityWindow, legacyFilesystemBudget, routeWindow } from './cloudflare-capacity.mjs'
import { run as egressReport } from './egress-monitor.mjs'
import { REQUEST_DEADLINE_MS, requestSlis, requestAlertAssessment } from './monitor.mjs'
import { WINDOW_MS } from './request-outcomes.mjs'
import { run as outcomeReport } from './runtime-outcomes.mjs'

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const fields = ['msg', 'timestamp', 'invocationId', 'route', 'status', 'durationMs', 'outcome', 'error', 'statement', 'bytes', 'rows', 'sampleRate']
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
export async function readContainerWindow({ application, environment, now, read, completionGrace = false }) {
  const app = containerApplicationId(application)
  if (!['production', 'staging'].includes(environment) || !Number.isSafeInteger(now)) fail('container_window_invalid')
  const start = now - WINDOW_MS, through = now + (completionGrace ? REQUEST_DEADLINE_MS : 0), found = new Map()
  const seen = new Set(), cursors = new Set()
  let pages = 0, records = 0, expected = 0
  /** @type {string | undefined} */
  let offset
  for (;;) {
    if (++pages > maxQueries) fail('container_log_query_budget_exceeded')
    const result = await read({
      queryId: 'mikka-container-runtime-window', view: 'events', limit, timeframe: { from: start, to: through },
      ...(offset ? { offset, offsetDirection: 'next' } : {}),
      parameters: { datasets: ['containers'], filters: [{ key: '$metadata.service', type: 'string', operation: 'eq', value: app }] },
    })
    const section = result?.events, rows = section?.events
    if (!Array.isArray(rows) || rows.length > limit || !Number.isSafeInteger(section.count) ||
      section.count < rows.length || !result.statistics || typeof result.statistics !== 'object' ||
      (result.statistics.abr_level ?? 1) !== 1) fail('container_log_response_incomplete')
    expected = Math.max(expected, section.count)
    const previousSize = seen.size
    for (const row of rows) {
      if (row.dataset !== 'containers' || row.$metadata?.type !== 'cf-container' ||
        row.$metadata?.service !== app || row.$containers?.applicationId !== app ||
        !row.$metadata?.id || typeof row.$metadata.id !== 'string' ||
        !Number.isSafeInteger(row.timestamp) || row.timestamp < start || row.timestamp > through) fail('container_log_scope_mismatch')
      const id = row.$metadata.id
      if (!seen.has(id)) {
        seen.add(id)
        if (row.timestamp < now) records++
      }
      if (row.timestamp === through) continue
      if (row.$metadata.truncated || row.$containers.truncated) fail('container_log_records_truncated')
      const value = row.source
      if (typeof value === 'string' && /api_request|db_sample/.test(value)) fail('container_log_record_malformed')
      if (!value || typeof value !== 'object' || !payloadKinds.has(value.msg)) continue
      if (row.timestamp >= now && value.msg !== 'api_request') continue
      // Drop provider metadata, raw URLs, SQL, bodies and identities before
      // forwarding structured entries to the existing report consumers.
      const message = JSON.stringify(Object.fromEntries(fields.filter(key => Object.hasOwn(value, key))
        .map(key => [key, key === 'error' ? Boolean(value.error) : value[key]])))
      const record = { deploymentId: app, environment, message, truncated: row.$metadata.truncated === true }
      const previous = found.get(id)
      if (previous && (previous.at !== row.timestamp || previous.event.message !== message)) fail('container_log_id_conflict')
      found.set(id, { at: row.timestamp, event: record })
    }
    if (rows.length < limit && seen.size >= expected) break
    if (seen.size === previousSize) fail('container_log_response_incomplete')
    // Workers Observability takes the last event ID as its top-level offset.
    const next = rows.at(-1).$metadata.id
    if (cursors.has(next)) fail('container_log_response_incomplete')
    cursors.add(next)
    offset = next
  }
  const rows = [...found.values()]
  return { applicationId: app, environment, start, end: now, pages, records,
    events: rows.filter(row => row.at < now).map(row => row.event),
    ...(completionGrace ? { requestEvents: rows.map(row => row.event) } : {}) }
}

/** The protected caller verifies the live release and returns its immutable
 * application identity on each side of the read. A source change discards
 * the complete window before it reaches either report or any alert sink. */
export async function collectContainerReports({ target, read, capacity = undefined, neonToken, includeProviderUsage = true, fetchImpl = fetch, now = Date.now(), observedAt = now }) {
  const before = await target()
  if (!/^[a-f0-9]{40}$/.test(before.source) || !uuid.test(before.apiVersion)) fail('container_release_invalid')
  const mature = Boolean(capacity) && observedAt >= now + REQUEST_DEADLINE_MS
  const window = await readContainerWindow({ application: before.application, environment: before.environment,
    read, now, completionGrace: mature })
  const [outcomes, egress] = await Promise.all([
    outcomeReport({ now, containerWindow: window }),
    egressReport({ now, containerWindow: window, neonToken, includeProviderUsage, fetchImpl }),
  ])
  let health
  if(capacity){
    const { account, read:readCapacity }=capacity
    const resources=await capacityWindow({application:window.applicationId,account,start:window.start,end:window.end,read:readCapacity})
    const traffic=routeWindow(window.events,window.start,window.end)
    const fiveMinuteWindows=resources.windows.map(item=>({capacity:item,traffic:routeWindow(window.events,item.start,item.end),
      filesystem:legacyFilesystemBudget(window.events,item.start,item.end)}))
    // Starts use the same complete quarter as CPU. Its last two minutes may finish in the grace interval.
    const through = window.end + REQUEST_DEADLINE_MS
    const malformed = mature && routeWindow(window.requestEvents, window.start, through).malformed > 0
    const requests = mature && !malformed ? requestSlis(window.requestEvents.map(event => event.message), through,
      { from: window.start, until: window.end }) : {}
    const status = !mature ? 'awaiting_deadline' : malformed ? 'malformed' : Object.keys(requests).length ? 'observed' : 'no_starts'
    const requestHealth = { status, from: window.start, until: window.end, deadlineMs: REQUEST_DEADLINE_MS,
      requests, ...requestAlertAssessment(requests) }
    health={capacity:resources,traffic,fiveMinuteWindows,requestHealth}
  }
  const after = await target()
  if (before.source !== after.source || before.apiVersion !== after.apiVersion || before.environment !== after.environment ||
    window.applicationId !== containerApplicationId(after.application)) fail('container_release_changed')
  return { source: before.source, apiVersion: before.apiVersion, applicationId: window.applicationId, outcomes, egress, ...(health ? {health} : {}) }
}
