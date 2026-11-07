import { isDeviceOnline } from '@mikka/protocol/device'
import { deviceGatewayEndpoint } from './device-gateway-client'

type DevicePresence = { id: string; lastSeenAt: string | number | Date | null }
const GATEWAY_ONLINE_WINDOW_MS = 90_000

/**
 * An idle gateway daemon stops HTTP heartbeats. Read its hibernating socket's
 * last auto-response only when somebody needs presence, never on a timer or by
 * writing synthetic heartbeats to Neon. Old daemons retain their 60s heartbeat
 * rule. This is availability, not authority: callers still check owner/enabled.
 */
export async function deviceIsOnline(device: DevicePresence, now?: number): Promise<boolean> {
  const startedAt = Date.now()
  const observedAt = now ?? startedAt
  const seen = device.lastSeenAt instanceof Date ? device.lastSeenAt.getTime() : typeof device.lastSeenAt === 'number' ? device.lastSeenAt : Date.parse(device.lastSeenAt ?? '')
  // A future stored heartbeat is invalid, even when a gateway happens to answer.
  if (seen > observedAt) return false
  if (isDeviceOnline(device.lastSeenAt, observedAt)) return true
  const endpoint = deviceGatewayEndpoint(device.id, 'status')
  if (!endpoint) return false
  try {
    const response = await fetch(endpoint.url, {
      headers: { authorization: `Bearer ${endpoint.secret}` },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return false
    const status: unknown = await response.json()
    if (!status || typeof status !== 'object' || !('online' in status) || status.online !== true
      || !('lastSeenAt' in status) || typeof status.lastSeenAt !== 'string') return false
    const seen = Date.parse(status.lastSeenAt)
    // Future timestamps never prove a device is present.
    const receivedAt = now === undefined ? Date.now() : now + Date.now() - startedAt
    return Number.isFinite(seen) && seen <= receivedAt && receivedAt - seen <= GATEWAY_ONLINE_WINDOW_MS
  } catch { return false }
}

/** Deduplicate a page's devices; parallel reads have one bounded timeout. */
export async function deviceOnlineStates(devices: readonly DevicePresence[], now?: number): Promise<Map<string, boolean>> {
  const unique = new Map(devices.map(device => [device.id, device]))
  return new Map(await Promise.all([...unique.values()].map(async device => [device.id, await deviceIsOnline(device, now)] as const)))
}
