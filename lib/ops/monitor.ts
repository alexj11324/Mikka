import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { actionableAlerts, databaseSignals, notifyAlerts } from '../../scripts/ops/monitor.mjs'

type State = Record<string, { active?: boolean; lastSent?: number; lastFailed?: number; lastRecordedAt?: number; notifiedActive?: boolean }>

/** Existing minute cron records aggregates locally even when no notification forwarding is configured. */
export async function collectOperationalSignals(pool: Pool, options: { sink?: string; now?: Date } = {}) {
  const now = options.now ?? new Date()
  let signals: Record<string, number>
  try { signals = await databaseSignals(pool, now) } catch { signals = { databaseAvailable: 0 } }
  const alerts = actionableAlerts({ requests: {}, database: signals })
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'")
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka-ops-monitor',0))")
    const previous: State = (await client.query('SELECT state FROM ops_monitor_observations ORDER BY "observedAt" DESC,id DESC LIMIT 1')).rows[0]?.state ?? {}
    const state: State = structuredClone(previous), active = new Set(alerts.map((alert: { id: string }) => alert.id))
    const transitions = []
    for (const id of new Set([...Object.keys(state), ...active])) {
      const old = state[id] ?? {}, isActive = active.has(id)
      if (isActive !== Boolean(old.active) || isActive && now.getTime() - (old.lastRecordedAt ?? 0) >= 30 * 60_000) {
        transitions.push({ id, state: isActive ? 'firing' : 'resolved', observedAt: now.toISOString() })
        state[id] = { ...old, active: isActive, lastRecordedAt: now.getTime() }
      }
    }
    let notificationStatus: 'not_configured' | 'delivered' | 'failed' = 'not_configured'
    let deliveryState: State = state
    if (options.sink) {
      // Delivery uses its own successful-send state, not the DB-recorded active state.
      const priorDelivery = Object.fromEntries(Object.entries(previous).map(([id, value]) => [id, { ...value, active: value.notifiedActive ?? false }]))
      const result = await notifyAlerts(alerts, { sink: options.sink, now: now.getTime(), state: priorDelivery })
      notificationStatus = result.healthy ? 'delivered' : 'failed'
      deliveryState = structuredClone(state)
      for (const [id, value] of Object.entries(result.state as State)) deliveryState[id] = { ...state[id], lastSent: value.lastSent, lastFailed: value.lastFailed, notifiedActive: value.active }
    }
    const id = randomUUID()
    await client.query('INSERT INTO ops_monitor_observations(id,"observedAt",signals,alerts,transitions,state,"notificationStatus") VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, now, JSON.stringify(signals), JSON.stringify(alerts), JSON.stringify(transitions), JSON.stringify(deliveryState), notificationStatus])
    await client.query('COMMIT')
    return { id, observedAt: now.toISOString(), databaseAvailable: signals.databaseAvailable === 1, signals, alerts, transitions, notificationStatus,
      requestLogCollection: 'runtime_log_collector_required', persisted: true }
  } catch {
    await client.query('ROLLBACK').catch(() => {})
    throw Error('opsMonitorPersistenceUnavailable')
  } finally { client.release() }
}
