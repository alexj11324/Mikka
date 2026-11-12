import type { Pool } from 'pg'
import { afterJob } from '@/lib/background'
import { setTimeout as delay } from 'node:timers/promises'
import { deviceGatewayEndpoint } from './device-gateway-client'
import { afterDatabaseCommit } from './db/commit-effects'
import { DEVICE_WORK_CHANNEL, notifyChannel } from './db/listen'
import { gatewayConfig } from './builtin-gateway/config'

/** Wakes this device's waiting commands long poll (the gateway-down fallback).
 * Sent with each gateway wake: with the gateway configured, every write that
 * gives a device work reaches notifyDeviceWork, so the long poll may wait on
 * LISTEN (lib/device-link.ts deviceWorkSubscription). */
async function notifyLongPoll(deviceId: string) {
  try {
    const { pool, withoutDatabaseClient } = await import('./db/request-scope')
    await withoutDatabaseClient(() => notifyChannel(pool, DEVICE_WORK_CHANNEL, [deviceId]))
  } catch { console.warn('[device-gateway] long poll notification failed', { deviceId }) }
}

/** A wake is idempotent; retry transient failures without dropping committed work. */
async function sendWake(deviceId: string, endpoint: NonNullable<ReturnType<typeof deviceGatewayEndpoint>>) {
  if (endpoint.mode === 'builtin') {
    try { const { builtinGateway } = await import('./builtin-gateway/runtime'); await builtinGateway()?.hub.work(deviceId) }
    catch { console.warn('[device-gateway] builtin work notification failed', { deviceId }) }
    return
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await delay(attempt * 250)
    try {
      const response = await fetch(endpoint.url, {
        method: 'POST', headers: { authorization: `Bearer ${endpoint.secret}` },
        redirect: 'error', signal: AbortSignal.timeout(3_000),
      })
      await response.body?.cancel()
      if (response.ok) return
      if (response.status < 500 && response.status !== 429) break
    } catch { /* retry the signal; never send the work or credential to logs */ }
  }
  console.warn('[device-gateway] work notification failed', { deviceId })
}

/**
 * Call only after the owning transaction commits. after() keeps the signal
 * alive after the HTTP response; it is not a transaction commit hook (nested
 * after callbacks can start immediately). Work stays in authorized routes.
 * Non-Next hosts use the platform's waitUntil lifecycle instead.
 */
export function notifyDeviceWork(deviceId: string | null | undefined) {
  if (!deviceId) return
  const endpoint = deviceGatewayEndpoint(deviceId, 'push')
  if (!endpoint) return
  afterJob('after:device-wake', async () => { await Promise.all([sendWake(deviceId, endpoint), notifyLongPoll(deviceId)]) }, { orRun: true })
}

/** A read RPC waits for its device response before returning. Deferring its
 * wake with after() would deadlock an idle push-only daemon. The request's
 * transaction has already committed (and sent the ordinary PG notification). */
export async function wakeDeviceWorkNow(deviceId: string) {
  const endpoint = deviceGatewayEndpoint(deviceId, 'push')
  if (endpoint) await sendWake(deviceId, endpoint)
}

/** The outer Factory/Skill transaction has committed before this lookup. */
export async function notifyQueuedLocalRun(database: {
  query: (text: string, values: unknown[]) => Promise<{ rows: { deviceId: string }[] }>
}, userId: string, runId: string) {
  if (!gatewayConfig()) return
  try {
    const { rows: [run] } = await database.query(`SELECT r."deviceId" FROM agent_runs r
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND r.status='queued' AND r."stopRequestedAt" IS NULL
        AND d.kind='local' AND d.enabled=true AND d."removedAt" IS NULL`, [runId, userId])
    notifyDeviceWork(run?.deviceId)
  } catch { console.warn('[device-gateway] queued run notification failed', { runId }) }
}

export type RunControlTarget = { runIds: readonly string[] } | { userId: string } | { workspaceId: string }
const ACTIVE_RUN_STATUSES = ['preparing', 'running', 'paused', 'waiting_input', 'finishing']

/**
 * Wakes each device (local or cloud) holding one of these runs, so its daemon
 * checks run control again at once (#1212). A daemon on the gateway runs no
 * periodic check, so every write that can stop, pause or revoke a run, or
 * change its policy, calls this after commit. The wake makes current daemons
 * consume persisted stop/pause commands. Legacy daemons also refresh their
 * cached control state; current provider and tool calls need no remote check.
 */
export async function notifyRunControl(database: {
  query: (text: string, values: unknown[]) => Promise<{ rows: { deviceId: string }[] }>
}, target: RunControlTarget) {
  if ('runIds' in target && target.runIds.length === 0) return
  // Human capabilities use the run's root gateway independently of the
  // daemon's optional device gateway. Close them before notifying execution.
  try {
    const { revokeReviewSessions } = await import('./coding-workspace/review-sessions')
    await revokeReviewSessions(database as Pick<Pool, 'query'>, target, 'run_control')
  } catch {
    const { armDueTimerSoon } = await import('./due-timer')
    armDueTimerSoon('run-recovery')
    console.warn('[device-gateway] review control notification deferred')
  }
  if (!gatewayConfig()) return
  const [where, values]: [string, unknown[]] = 'runIds' in target ? ['r.id=ANY($1::uuid[])', [[...target.runIds]]]
    : 'userId' in target ? ['r."userId"=$1 AND r.status=ANY($2::text[])', [target.userId, ACTIVE_RUN_STATUSES]]
      : ['r."botId" IN (SELECT id FROM bots WHERE "workspaceId"=$1) AND r.status=ANY($2::text[])', [target.workspaceId, ACTIVE_RUN_STATUSES]]
  try {
    const { rows } = await database.query(`SELECT DISTINCT r."deviceId" FROM agent_runs r
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
      WHERE ${where}`, values)
    for (const { deviceId } of rows) notifyDeviceWork(deviceId)
  } catch { console.warn('[device-gateway] run control notification failed') }
}

/** notifyRunControl once this transaction commits; nothing on rollback. The
 * device lookup reads the committed rows from the default pool. */
export function runControlChanged(executor: object, target: RunControlTarget, lookup?: Parameters<typeof notifyRunControl>[0]) {
  if (!gatewayConfig()) return
  if ('runIds' in target && target.runIds.length === 0) return
  const key = 'runIds' in target ? `runs:${[...target.runIds].sort().join(',')}` : 'userId' in target ? `owner:${target.userId}` : `workspace:${target.workspaceId}`
  // A wake is best-effort: it can never fail the stop or policy write itself.
  try {
    afterDatabaseCommit(executor, `run-control:${key}`, async () => {
      if (lookup) return notifyRunControl(lookup, target)
      const { pool, withoutDatabaseClient } = await import('./db/request-scope')
      await withoutDatabaseClient(() => notifyRunControl(pool, target))
    })
  } catch { console.warn('[device-gateway] run control notification unavailable') }
}
