import { defineWebSocketHandler } from 'h3'
import { builtinGateway } from '../../../lib/builtin-gateway/runtime'
import { gatewayRequest, gatewayUpgrade } from '../../../lib/builtin-gateway/request'
import type { GatewaySocket } from '../../../lib/builtin-gateway/hub'
import type { GatewayHub } from '../../../lib/builtin-gateway/hub'

export function createGatewayHandler(getRuntime: () => { hub: GatewayHub; bus: { ready(): Promise<void> } } | null = builtinGateway,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  return defineWebSocketHandler({
  async upgrade(request) {
    const authorization = gatewayUpgrade(request, env)
    if (authorization instanceof Response) throw authorization
    const runtime = getRuntime()
    if (!runtime) throw new Response(null, { status: 404 })
    try { await runtime.bus.ready() }
    catch { throw new Response(null, { status: 503 }) }
    return { protocol: authorization.protocol, context: { socket: authorization.socket } }
  },
  async open(peer) {
    const runtime = getRuntime()
    const socket = peer.context.socket as GatewaySocket | undefined
    if (!runtime || !socket) { peer.close(1012, 'gateway unavailable'); return }
    await runtime.hub.open(peer, socket)
  },
  message(peer, message) { getRuntime()?.hub.message(peer, message.text()) },
  close(peer) { getRuntime()?.hub.close(peer) },
  error(peer) { getRuntime()?.hub.close(peer) },
}, async event => {
  const runtime = getRuntime()
  return runtime ? gatewayRequest(event.req, runtime.hub, env) : new Response(null, { status: 404 })
})
}

export default createGatewayHandler()
