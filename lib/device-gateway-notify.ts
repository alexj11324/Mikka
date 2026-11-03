import 'server-only'

/**
 * Tells the device gateway that this device has work. The body is empty:
 * the device reads the work through its existing authenticated route.
 * No gateway configured, or a gateway that does not answer, leaves the
 * long-poll fallback in place.
 */
export function notifyDeviceWork(deviceId: string | null | undefined) {
  const base = process.env.DEVICE_GATEWAY_URL
  const secret = process.env.DEVICE_GATEWAY_PUSH_SECRET
  if (!base || !secret || !deviceId) return
  let url: URL
  try { url = new URL(`/v1/devices/${encodeURIComponent(deviceId)}/push`, base) } catch { return }
  if (url.origin !== new URL(base).origin) return
  void fetch(url, { method: 'POST', headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
}
