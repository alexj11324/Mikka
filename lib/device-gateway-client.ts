import { gatewayConfig, gatewayURL } from './builtin-gateway/config'

const DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Server-only callers already authorize ownership before asking the gateway. */
export function deviceGatewayEndpoint(deviceId: string, operation: 'push' | 'status') {
  const config = gatewayConfig()
  if (!config || !DEVICE_ID.test(deviceId)) return null
  return { url: gatewayURL(config, `/v1/devices/${deviceId}/${operation}`), secret: config.secret, mode: config.mode }
}
