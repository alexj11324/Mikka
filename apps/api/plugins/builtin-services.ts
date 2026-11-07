import { definePlugin } from 'nitro'
import { useNitroHooks } from 'nitro/app'
import { builtinGateway } from '../../../lib/builtin-gateway/runtime'
import { startBuiltinScheduler } from '../../../lib/builtin-gateway/scheduler'
import { schedulerConfig } from '../../../lib/builtin-gateway/scheduler'
import { PostgresGatewayBus } from '../../../lib/builtin-gateway/postgres'

export default definePlugin(application => {
  const runtime = builtinGateway()
  const originalFetch = application.fetch
  application.fetch = async request => {
    const response = await originalFetch(request)
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return response
    const carrier = request as Request & { [key: symbol]: unknown; context?: Record<symbol, unknown> }
    const key = Symbol.for('crossws.hooks')
    const hooks = (response as Response & { crossws?: unknown }).crossws ?? carrier[key] ?? carrier.context?.[key]
    // Nitro's WebSocket resolver ignores HTTP status. Unmatched upgrades must
    // be refused explicitly, rather than receiving an unauthenticated socket.
    return Object.assign(response, { crossws: hooks ?? { upgrade() { throw new Response(null, { status: 404 }) } } })
  }
  // A self-hoster may keep their own Worker and still need local scheduling.
  if (!runtime && !schedulerConfig()) return
  const bus = runtime?.bus ?? new PostgresGatewayBus({ connectionString: process.env.MIKKA_DATABASE_URL_UNPOOLED || process.env.MIKKA_DATABASE_URL })
  const scheduler = startBuiltinScheduler({
    fetch: (input, init) => Promise.resolve(application.fetch(new Request(input, init))),
    leader: () => bus.isSchedulerLeader(),
  })
  useNitroHooks().hook('close', async () => { scheduler.stop(); if (runtime) await runtime.stop(); else await bus.stop() })
})
