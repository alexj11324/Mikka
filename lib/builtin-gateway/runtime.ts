import { builtinGatewayConfig } from './config'
import { GatewayHub } from './hub'
import { PostgresGatewayBus } from './postgres'
import { authorizeEnterpriseLiveChannel } from '../enterprise/live-authority'

type Runtime = { hub: GatewayHub; bus: PostgresGatewayBus; stop(): Promise<void> }
let runtime: Runtime | undefined

/** Shared by route handlers and post-commit writers in this Node process. */
export function builtinGateway(): Runtime | null {
  const config = builtinGatewayConfig()
  if (!config) return null
  if (!runtime) {
    const bus = new PostgresGatewayBus({ connectionString: process.env.MIKKA_DATABASE_URL_UNPOOLED || process.env.MIKKA_DATABASE_URL })
    // Device sessions are applied in this process, by the replica holding the
    // socket; no HTTP hop back to itself (decision 2026-11-17-2215).
    const hub = new GatewayHub(bus, Date.now, config.secret, (sessionId, channel) => authorizeEnterpriseLiveChannel(sessionId, channel), {
      report: async (deviceId, report) => (await import('@/lib/device-session')).applyDeviceSessionReport(deviceId, report),
    })
    runtime = { hub, bus, async stop() { hub.stop(); await bus.stop(); runtime = undefined } }
  }
  return runtime
}
