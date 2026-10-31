import { readFile, writeFile, rename } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { Pool } from 'pg'

export const WINDOW_MS = 15 * 60_000, REQUEST_DEADLINE_MS = 120_000
const groupFor = route => route === '/api/auth/[...all]' ? 'login' : route === '/api/coordinator/messages' ? 'chat' : 'api'

/** Completed 4xx remain failures: this SLI measures the user's successful request, not server availability. */
export function requestSlis(lines, now = Date.now()) {
  const starts = new Map(), ends = new Map()
  for (const line of lines) {
    let entry
    try { entry = typeof line === 'string' ? JSON.parse(line) : line } catch { continue }
    if (!entry || !['api_request_started', 'api_request'].includes(entry.msg)) continue
    if (typeof entry.invocationId !== 'string' || typeof entry.route !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) continue
    if (entry.msg === 'api_request_started') starts.set(entry.invocationId, entry)
    else ends.set(entry.invocationId, entry)
  }
  const result = {}
  for (const [id, start] of starts) {
    const at = Date.parse(start.timestamp)
    // Grace for unfinished requests; overdue starts stay in the denominator.
    if (at < now - WINDOW_MS || at > now - REQUEST_DEADLINE_MS) continue
    const group = groupFor(start.route), end = ends.get(id)
    const metric = result[group] ??= { total: 0, successful: 0, timedOut: 0, rateLimited: 0, durations: [] }
    metric.total++
    if (!end || !Number.isFinite(end.durationMs) || end.durationMs > REQUEST_DEADLINE_MS) metric.timedOut++
    else {
      metric.durations.push(end.durationMs)
      if (end.status >= 200 && end.status < 400) metric.successful++
      if (end.status === 429) metric.rateLimited++
    }
  }
  for (const metric of Object.values(result)) {
    metric.durations.sort((a, b) => a - b)
    metric.successRatio = metric.successful / metric.total
    metric.p95Ms = metric.durations[Math.max(0, Math.ceil(metric.durations.length * .95) - 1)] ?? null
    delete metric.durations
  }
  return result
}

/** Read-only aggregate queries; bodies, provider errors, owner IDs and secret references never leave the database. */
export async function databaseSignals(pool, now = new Date()) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    const { rows: [row] } = await client.query(`SELECT
      (SELECT count(*)::int FROM coordinator_events WHERE "deliveredAt" IS NULL AND (tier IS NULL OR tier<>'background') AND "createdAt" < $1::timestamptz-interval '5 minutes') AS "staleWake",
      (SELECT count(*)::int FROM agent_runs WHERE status IN ('preparing','running','finishing') AND "leaseExpiresAt" < $1::timestamptz-interval '2 minutes') AS "expiredRunLease",
      (SELECT count(*)::int FROM operation_ledger WHERE status='uncertain') AS "uncertainEffect",
      (SELECT count(*)::int FROM operation_ledger WHERE status='executing' AND "updatedAt" < $1::timestamptz-interval '5 minutes') AS "staleEffect",
      (SELECT count(*)::int FROM byos_secret_artifacts a WHERE a."deletedAt" IS NULL AND a."notBefore" < $1::timestamptz-interval '5 minutes'
        AND NOT EXISTS (SELECT 1 FROM byos_connections c WHERE a.name IN (c."secretName",c."accessSecretName",c."stagedSecretName",c."stagedAccessName"))) AS "overdueSecretCleanup",
      (SELECT count(*)::int FROM schedule_occurrences WHERE due_at >= $1::timestamptz-interval '15 minutes' AND due_at <= $1::timestamptz-interval '2 minutes' AND execution_decision='execute') AS "dueTotal",
      (SELECT count(*)::int FROM schedule_occurrences WHERE due_at >= $1::timestamptz-interval '15 minutes' AND due_at <= $1::timestamptz-interval '2 minutes' AND execution_decision='execute' AND status='succeeded' AND finished_at <= due_at+interval '2 minutes') AS "dueSuccessful",
      (SELECT count(*)::int FROM agent_runs WHERE "createdAt" >= $1::timestamptz-interval '15 minutes' AND "createdAt" <= $1::timestamptz-interval '2 minutes') AS "dispatchTotal",
      (SELECT count(*)::int FROM agent_runs WHERE "createdAt" >= $1::timestamptz-interval '15 minutes' AND "createdAt" <= $1::timestamptz-interval '2 minutes' AND "startedAt" <= "createdAt"+interval '2 minutes') AS "dispatchStarted"
      `, [now])
    await client.query('COMMIT')
    return { databaseAvailable: 1, ...row }
  } catch {
    try { await client.query('ROLLBACK') } catch { /* preserve unavailable result */ }
    return { databaseAvailable: 0 }
  } finally { client.release() }
}

export function actionableAlerts({ requests, database }) {
  const alerts = []
  const add = (id, value, action) => alerts.push({ id, value, owner: 'repository-maintainers', runbook: 'docs/operations/observability.md', action })
  if (database.databaseAvailable !== 1) add('database-unavailable', 1, 'Check database connectivity and pool saturation; keep uncertain actions quarantined.')
  else {
    for (const key of ['staleWake', 'expiredRunLease', 'uncertainEffect', 'staleEffect', 'overdueSecretCleanup'])
      if (database[key] > 0) add(key, database[key], key.includes('Effect') ? 'Reconcile provider receipt and ledger before retrying any external effect.' : 'Inspect the existing worker and durable retry/cleanup queue; resume only the original authorized work.')
    for (const [total, successful, name] of [['dueTotal', 'dueSuccessful', 'due-on-time'], ['dispatchTotal', 'dispatchStarted', 'dispatch-start']])
      if (database[total] > 0 && database[successful] / database[total] < .99) add(name, database[successful] / database[total], 'Inspect worker heartbeat, lease and durable queue; failed and unfinished work remain in this denominator.')
  }
  for (const [group, metric] of Object.entries(requests)) {
    if (metric.total > 0 && metric.successRatio < .99) add(`${group}-request-success`, metric.successRatio, 'Inspect status classes, worker and dependency health; investigate 429 and timeouts without copying request data.')
    if (metric.p95Ms > 10_000) add(`${group}-request-latency`, metric.p95Ms, 'Check request latency and database/worker saturation; API response time does not prove stream or run completion.')
  }
  return alerts
}

export function internalSink(raw) {
  const url = new URL(raw)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw Error('opsInternalSinkRequired')
  return url
}

/** A failed delivery never advances lastSent, so retries cannot silently suppress a page. */
export async function notifyAlerts(alerts, { state = {}, sink, now = Date.now(), fetchImpl = fetch }) {
  const target = internalSink(sink), next = structuredClone(state), deliveries = []
  const current = new Map(alerts.map(alert => [alert.id, alert]))
  for (const id of new Set([...Object.keys(next), ...current.keys()])) {
    const previous = next[id] ?? {}, active = current.has(id)
    if (!active && !previous.active) continue
    if (active && previous.active && now - (previous.lastSent ?? 0) < 30 * 60_000) continue
    const event = { version: 1, id, state: active ? 'firing' : 'resolved', observedAt: new Date(now).toISOString(),
      ...(current.get(id) ?? { owner: 'repository-maintainers', runbook: 'docs/operations/observability.md', action: 'Confirm recovery against the original failing signal.' }) }
    try {
      const response = await fetchImpl(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(3_000), redirect: 'error' })
      if (!response.ok) throw Error('opsAlertDeliveryFailed')
      next[id] = { active, lastSent: now }; deliveries.push({ id, state: event.state, delivered: true })
    } catch {
      // No endpoint or upstream error body in logs.
      next[id] = { ...previous, lastFailed: now }; deliveries.push({ id, state: event.state, delivered: false })
    }
  }
  return { state: next, deliveries, healthy: deliveries.every(delivery => delivery.delivered) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [logs, stateFile] = process.argv.slice(2)
  if (!logs || !stateFile || !process.env.OPS_DATABASE_URL || !process.env.OPS_INTERNAL_ALERT_SINK) throw Error('opsMonitorInputsRequired')
  const pool = new Pool({ connectionString: process.env.OPS_DATABASE_URL, max: 1, connectionTimeoutMillis: 5_000 })
  let database
  try { database = await databaseSignals(pool) } catch { database = { databaseAvailable: 0 } } finally { await pool.end() }
  const requests = requestSlis((await readFile(logs, 'utf8')).split('\n'))
  let state = {}
  try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw Error('opsAlertStateInvalid') }
  const result = await notifyAlerts(actionableAlerts({ requests, database }), { state, sink: process.env.OPS_INTERNAL_ALERT_SINK })
  await writeFile(`${stateFile}.tmp`, JSON.stringify(result.state), { mode: 0o600 }); await rename(`${stateFile}.tmp`, stateFile)
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), requests, database, deliveries: result.deliveries, healthy: result.healthy }))
  if (!result.healthy) process.exitCode = 1
}
