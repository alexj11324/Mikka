import { afterJob } from '@/lib/background'
import { setTimeout as delay } from 'node:timers/promises'
import { deviceGatewayEndpoint } from './device-gateway-client'

/** A wake is idempotent; retry transient failures without dropping committed work. */
async function sendWake(deviceId: string, endpoint: NonNullable<ReturnType<typeof deviceGatewayEndpoint>>) {
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
  afterJob('after:device-wake', () => sendWake(deviceId, endpoint), { orRun: true })
}

/** The outer Factory/Skill transaction has committed before this lookup. */
export async function notifyQueuedLocalRun(database: {
  query: (text: string, values: unknown[]) => Promise<{ rows: { deviceId: string }[] }>
}, userId: string, runId: string) {
  if (!process.env.DEVICE_GATEWAY_URL || !process.env.DEVICE_GATEWAY_PUSH_SECRET) return
  try {
    const { rows: [run] } = await database.query(`SELECT r."deviceId" FROM agent_runs r
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND r.status='queued' AND r."stopRequestedAt" IS NULL
        AND d.kind='local' AND d.enabled=true AND d."removedAt" IS NULL`, [runId, userId])
    notifyDeviceWork(run?.deviceId)
  } catch { console.warn('[device-gateway] queued run notification failed', { runId }) }
}
