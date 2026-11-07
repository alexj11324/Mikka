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
    const hub = new GatewayHub(bus, Date.now, config.secret, (sessionId, channel) => authorizeEnterpriseLiveChannel(sessionId, channel))
    runtime = { hub, bus, async stop() { hub.stop(); await bus.stop(); runtime = undefined } }
  }
  return runtime
}
