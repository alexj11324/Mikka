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
export async function deviceIsOnline(device: DevicePresence, now = Date.now()): Promise<boolean> {
  if (isDeviceOnline(device.lastSeenAt, now)) return true
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
    // Tolerate a small clock difference, but not an unbounded future timestamp.
    return Number.isFinite(seen) && seen <= now + 5_000 && now - seen <= GATEWAY_ONLINE_WINDOW_MS
  } catch { return false }
}

/** Deduplicate a page's devices; parallel reads have one bounded timeout. */
export async function deviceOnlineStates(devices: readonly DevicePresence[], now = Date.now()): Promise<Map<string, boolean>> {
  const unique = new Map(devices.map(device => [device.id, device]))
  return new Map(await Promise.all([...unique.values()].map(async device => [device.id, await deviceIsOnline(device, now)] as const)))
}
