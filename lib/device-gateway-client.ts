const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Server-only callers already authorize ownership before asking the gateway. */
export function deviceGatewayEndpoint(deviceId: string, operation: 'push' | 'status') {
  const base = process.env.DEVICE_GATEWAY_URL
  const secret = process.env.DEVICE_GATEWAY_PUSH_SECRET
  if (!base || !secret || !DEVICE_ID.test(deviceId)) return null
  try {
    const origin = new URL(base)
    if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password) return null
    return { url: new URL(`/v1/devices/${deviceId}/${operation}`, origin), secret }
  } catch { return null }
}
