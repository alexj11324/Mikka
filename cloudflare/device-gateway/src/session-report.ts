/**
 * Device session reports, gateway → application (decision 2026-11-17-2215).
 *
 * The Worker does not bundle `packages/protocol` (its schema graph is large),
 * so these values mirror `packages/protocol/src/device.ts`;
 * `session-report.test.ts` fails if they drift.
 *
 * WebSocket close codes the gateway sends:
 *
 * | Code | Socket | Meaning                                                    |
 * | ---- | ------ | ---------------------------------------------------------- |
 * | 4000 | device | replaced: a newer socket of the same device opened         |
 * | 4001 | device | this daemon must update (`DEVICE_GATEWAY_UPDATE_REQUIRED_CODE`); nothing else |
 * | 4001 | live   | browser ticket expired or live capability revoked          |
 * | 1011 | any    | the socket could not be written (built-in gateway)          |
 * | 1012 | any    | the gateway is restarting or lost its bus (built-in gateway) |
 *
 * A device socket never receives 4001 for an expired ticket or a revoked
 * capability: a device's ticket only authorizes the upgrade, and device
 * authority is checked again on every device route.
 */

/** The daemon pings this often; the gateway answers without waking. */
export const DEVICE_GATEWAY_PING_MS = 10_000
/** No message for this long: the daemon drops and redials its socket. */
export const DEVICE_GATEWAY_SILENCE_MS = 30_000
/** A closed device socket is reported only if no newer socket opens within this. */
export const DEVICE_SESSION_CLOSE_GRACE_MS = 30_000
/** Close code reserved for "this daemon must update". */
export const DEVICE_GATEWAY_UPDATE_REQUIRED_CODE = 4001
/** Close code for a device socket replaced by a newer one. */
export const DEVICE_SOCKET_REPLACED_CODE = 4000
/**
 * `GET /v1/devices/:id/status` is online while a device socket is open and its
 * last connect or auto-answered ping is younger than this: the daemon's own
 * silence limit plus one ping interval of margin.
 */
export const DEVICE_STATUS_ONLINE_MS = DEVICE_GATEWAY_SILENCE_MS + DEVICE_GATEWAY_PING_MS

/** Same shape as `deviceSessionReportSchema`. */
export type DeviceSessionReport = { state: 'connected' | 'disconnected'; at: string; socketId: string }
export type PendingSessionReport = { deviceId: string; report: DeviceSessionReport; attempts: number; retryAt: number }
export type DeliveryOutcome = 'delivered' | 'dropped' | 'retry'

export const SESSION_REPORT_RETRY_MIN_MS = 1_000
export const SESSION_REPORT_RETRY_MAX_MS = 60_000
/** Reports kept per device while the application is unreachable; older ones are superseded anyway. */
export const SESSION_REPORT_QUEUE_MAX = 32
const SOCKET_ID = /^[A-Za-z0-9_-]{8,64}$/

/** Matches `deviceSessionReportSchema.socketId`. */
export function newSocketId(): string {
  const id = crypto.randomUUID()
  if (!SOCKET_ID.test(id)) throw new Error('socket id format')
  return id
}

/** 1 s, doubling, capped at 60 s. */
export function sessionReportBackoff(attempts: number): number {
  return Math.min(SESSION_REPORT_RETRY_MAX_MS, SESSION_REPORT_RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1))
}

/** 2xx is acknowledged. 408, 429 and 5xx (and 3xx: a misconfigured URL) are retried; other 4xx can never succeed. */
export function deliveryOutcome(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return 'delivered'
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'dropped'
  return 'retry'
}

/** `POST <base>/<deviceId>` with the gateway push secret as bearer. Never throws. */
export async function sendSessionReport(base: string, secret: string, deviceId: string, report: DeviceSessionReport,
  fetchImpl: typeof fetch = fetch): Promise<DeliveryOutcome> {
  try {
    const response = await fetchImpl(`${base.replace(/\/+$/, '')}/${encodeURIComponent(deviceId)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(report),
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    return deliveryOutcome(response.status)
  } catch { return 'retry' }
}
