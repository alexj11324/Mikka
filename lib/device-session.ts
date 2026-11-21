import 'server-only'
import { LEASED_RUN_STATUSES } from './run-retry'
import type { PoolClient } from 'pg'
import { SESSION_LEASE_MS, type DeviceSessionReport } from '@mikka/protocol/device'
import { db, pool } from './db'
import { afterJob } from './background'
import { armDueTimerSoon } from './due-timer'
import { ownerListChanged, runListChanged } from './live/lists'
import { runChanged } from './live/panels'
import { deviceSessionOpenSql, gatewayDeviceOnline } from './device-presence'

/**
 * The device session (decision 2026-11-17-2215). A daemon is usable only while
 * it holds its gateway WebSocket; the gateway reports when the socket opens
 * (`connected`) and closes (`disconnected`). This module is the only writer of
 * the session columns on `devices`.
 *
 * Ordering: the socket that opened last owns the session. A `connected` for an
 * older socket, or a `disconnected` for a socket that is not the current one
 * (a late close of a replaced socket), changes nothing. Reports are idempotent:
 * the gateway retries each until it is acknowledged.
 */
export async function applyDeviceSessionReport(deviceId: string, report: DeviceSessionReport): Promise<{ applied: boolean }> {
  return report.state === 'connected' ? sessionConnected(deviceId, report) : sessionDisconnected(deviceId, report)
}

/** Presence changes what the device list, the task runs waiting on a device and the threads' machine show. */
const PRESENCE_LISTS = ['device_list', 'task_run_list', 'thread_list'] as const

async function sessionConnected(deviceId: string, report: DeviceSessionReport): Promise<{ applied: boolean }> {
  // A newer socket wins; the same socket again is a retry and changes nothing
  // once its close is recorded (a retried `connected` must not reopen it).
  const { rows: [device] } = await pool.query<{ ownerId: string; enabled: boolean; wasOnline: boolean }>(`
    WITH prior AS (SELECT id, ${deviceSessionOpenSql('devices')} AS "wasOnline" FROM devices WHERE id=$1 AND "removedAt" IS NULL FOR UPDATE)
    UPDATE devices d SET "sessionOpenedAt"=$2::timestamptz, "sessionSocketId"=$3, "sessionClosedAt"=NULL,
      "lastSeenAt"=GREATEST(coalesce(d."lastSeenAt",$2::timestamptz),$2::timestamptz), "updatedAt"=now()
    FROM prior WHERE d.id=prior.id AND (d."sessionOpenedAt" IS NULL OR d."sessionOpenedAt" < $2::timestamptz
      OR (d."sessionOpenedAt"=$2::timestamptz AND d."sessionClosedAt" IS NULL))
    RETURNING d."ownerId", d.enabled, prior."wasOnline"`, [deviceId, report.at, report.socketId])
  if (!device) return { applied: false }
  // Live leases last as long as the session. Revocation, stop and policy
  // changes end a lease when they happen (lib/run-policy-stop.ts and friends).
  const extended = await pool.query<{ id: string }>(`UPDATE agent_runs SET "leaseExpiresAt"=now()+make_interval(secs => $3::double precision/1000), "updatedAt"=now()
    WHERE "deviceId"=$1 AND status=ANY($2::text[]) AND "stopRequestedAt" IS NULL AND "leaseExpiresAt">now() RETURNING id`,
  [deviceId, [...LEASED_RUN_STATUSES], SESSION_LEASE_MS])
  if (extended.rowCount) armDueTimerSoon('run-recovery')
  await ownerListChanged(db, device.ownerId, PRESENCE_LISTS)
  const { factoryLifecycleEnabled } = await import('./factory/runtime')
  if (factoryLifecycleEnabled()) {
    afterJob('after:factory-dispatch-recovery', async () => {
      const { factoryDispatchRecovery } = await import('./factory/dispatch-recovery-server')
      await factoryDispatchRecovery.deviceOnline(device.ownerId, deviceId, !device.wasOnline)
    }, { orRun: true })
  }
  return { applied: true }
}

async function sessionDisconnected(deviceId: string, report: DeviceSessionReport): Promise<{ applied: boolean }> {
  const client = await pool.connect()
  let ownerId: string, ended: string[]
  try {
    await client.query('BEGIN')
    // The device row is locked before the runs, the same order a claim takes,
    // so a claim either sees the closed session or its run's lease is ended here.
    const { rows: [device] } = await client.query<{ ownerId: string }>(`UPDATE devices SET "sessionClosedAt"=GREATEST($2::timestamptz,"sessionOpenedAt"),
        "lastSeenAt"=GREATEST(coalesce("lastSeenAt",$2::timestamptz),$2::timestamptz), "updatedAt"=now()
      WHERE id=$1 AND "sessionSocketId"=$3 AND "sessionOpenedAt" IS NOT NULL AND "sessionClosedAt" IS NULL
      RETURNING "ownerId"`, [deviceId, report.at, report.socketId])
    if (!device) { await client.query('COMMIT'); return { applied: false } }
    ownerId = device.ownerId
    // The run-recovery sweep (lib/run-leases.ts) retries these elsewhere or fails them.
    const runs = await client.query<{ id: string }>(`UPDATE agent_runs SET "leaseExpiresAt"=LEAST("leaseExpiresAt",clock_timestamp()), "updatedAt"=clock_timestamp()
      WHERE "deviceId"=$1 AND status=ANY($2::text[]) AND "leaseExpiresAt">clock_timestamp() RETURNING id`, [deviceId, [...LEASED_RUN_STATUSES]])
    ended = runs.rows.map(row => row.id)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally { client.release() }
  for (const runId of ended) { await runListChanged(db, runId); await runChanged(db, runId) }
  if (ended.length) armDueTimerSoon('run-recovery')
  await ownerListChanged(db, ownerId, PRESENCE_LISTS)
  return { applied: true }
}

const GATEWAY_STATUS_CONCURRENCY = 20

/**
 * Run-recovery backstop (decision 2026-11-17-2215): the gateway retries each
 * report until it is acknowledged, but a report can still be lost (a gateway
 * restart). For each device whose session the database holds open while it
 * has leased runs, ask the gateway; a device it reports offline gets a
 * `disconnected` for its current socket. Runs only in the run-recovery cron
 * sweep, at its existing cadence: it adds no poll of its own.
 */
export async function closeLostDeviceSessions(now = new Date()): Promise<{ checked: number; closed: number }> {
  const { rows } = await pool.query<{ id: string; sessionSocketId: string }>(`SELECT d.id, d."sessionSocketId" FROM devices d
    WHERE ${deviceSessionOpenSql('d')} AND d."sessionSocketId" IS NOT NULL AND d."removedAt" IS NULL
      AND EXISTS (SELECT 1 FROM agent_runs r WHERE r."deviceId"=d.id AND r.status=ANY($1::text[]) AND r."leaseExpiresAt">now())
    ORDER BY d."sessionOpenedAt" LIMIT 200`, [[...LEASED_RUN_STATUSES]])
  // Each status call may wait out its timeout, so they run a few at a time: one
  // by one, a stalled gateway would hold the sweep past the cron's budget before
  // the lease sweep that follows it. An unanswered status proves nothing; the
  // next sweep asks again.
  const offline: typeof rows = []
  const pending = rows.values()
  await Promise.all(Array.from({ length: Math.min(GATEWAY_STATUS_CONCURRENCY, rows.length) }, async () => {
    for (const device of pending) if (await gatewayDeviceOnline(device.id) === false) offline.push(device)
  }))
  let closed = 0
  for (const device of offline) {
    if ((await applyDeviceSessionReport(device.id, { state: 'disconnected', at: now.toISOString(), socketId: device.sessionSocketId })).applied) closed++
  }
  return { checked: rows.length, closed }
}

/**
 * Inside a claim transaction: whether the device's session is open, holding
 * the device row (FOR SHARE) until the claim commits. A `disconnected` report
 * locks the same row first, so it either sees the claimed run and ends its
 * lease, or the claim sees the closed session and leases nothing.
 */
export async function deviceSessionHeld(tx: Pick<PoolClient, 'query'>, deviceId: string): Promise<boolean> {
  const { rowCount } = await tx.query(`SELECT 1 FROM devices d WHERE d.id=$1 AND ${deviceSessionOpenSql('d')} FOR SHARE`, [deviceId])
  return rowCount === 1
}
