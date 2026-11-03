import { after } from 'next/server'
import { waitUntil } from '@vercel/functions'
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
 * Keep the signal alive after the HTTP response, and send after the request's
 * transaction commits. Work stays in the existing authorized device routes.
 * Non-Next hosts use the platform's waitUntil lifecycle instead.
 */
export function notifyDeviceWork(deviceId: string | null | undefined) {
  if (!deviceId) return
  const endpoint = deviceGatewayEndpoint(deviceId, 'push')
  if (!endpoint) return
  try { after(() => sendWake(deviceId, endpoint)) }
  catch { waitUntil(sendWake(deviceId, endpoint)) }
}
