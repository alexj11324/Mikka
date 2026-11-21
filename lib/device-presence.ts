import { isDeviceOnline, type DeviceSessionState } from '@mikka/protocol/device'
import { sql, type SQL } from 'drizzle-orm'
import { devices } from './db/schema'
import { deviceGatewayEndpoint } from './device-gateway-client'

/**
 * Presence is the device session (decision 2026-11-17-2215): a device is
 * online while the gateway socket it opened last is open. The gateway reports
 * `connected` and `disconnected` (lib/device-session.ts); reading presence is
 * a column read, never a call to the gateway. This is availability, not
 * authority: callers still check owner/enabled.
 */
export type DevicePresence = { id: string } & DeviceSessionState

/** SQL form of `isDeviceOnline` for a `devices` row under `alias`. */
export function deviceSessionOpenSql(alias = 'd'): string {
  return `(${alias}."sessionOpenedAt" IS NOT NULL AND (${alias}."sessionClosedAt" IS NULL OR ${alias}."sessionClosedAt" < ${alias}."sessionOpenedAt"))`
}

/** Drizzle form of `deviceSessionOpenSql` for the `devices` table. */
export const deviceSessionOpen: SQL<boolean> = sql<boolean>`(${devices.sessionOpenedAt} IS NOT NULL AND (${devices.sessionClosedAt} IS NULL OR ${devices.sessionClosedAt} < ${devices.sessionOpenedAt}))`

export function deviceIsOnline(device: DeviceSessionState): boolean {
  return isDeviceOnline(device)
}

/** Presence of a page's devices, by id. */
export function deviceOnlineStates(rows: readonly DevicePresence[]): Map<string, boolean> {
  return new Map(rows.map(device => [device.id, isDeviceOnline(device)] as const))
}

/**
 * What the gateway itself says about a device's socket. Only the run-recovery
 * backstop asks (lib/device-session.ts), for a device whose session the
 * database still holds open while it has leased runs: a lost `disconnected`
 * report cannot keep a run alive. Null when the gateway cannot answer.
 */
export async function gatewayDeviceOnline(deviceId: string): Promise<boolean | null> {
  const endpoint = deviceGatewayEndpoint(deviceId, 'status')
  if (!endpoint) return null
  try {
    if (endpoint.mode === 'builtin') {
      const { builtinGateway } = await import('./builtin-gateway/runtime')
      const status = await builtinGateway()?.hub.status(deviceId)
      return status ? status.online === true : null
    }
    const response = await fetch(endpoint.url, {
      headers: { authorization: `Bearer ${endpoint.secret}` },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) return null
    const status: unknown = await response.json()
    if (!status || typeof status !== 'object' || !('online' in status) || typeof status.online !== 'boolean') return null
    return status.online
  } catch { return null }
}
