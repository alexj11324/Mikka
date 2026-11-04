import { DurableObject } from 'cloudflare:workers'

const ONLINE_WINDOW_MS = 90_000

interface ConnectionAttachment {
  connectedAt: number
}

/**
 * Hibernating WebSocket for one device.
 *
 * Cloudflare's hibernation API (`acceptWebSocket`, not `accept`) drops the
 * object from memory while the socket stays connected, so duration is not
 * billed for the idle connection. `setWebSocketAutoResponse` answers the
 * daemon's 30s `ping` without waking the object and without duration
 * (https://developers.cloudflare.com/durable-objects/api/state/ and
 * https://developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/).
 *
 * No alarm. An alarm invocation is a request, and 400 always-online devices
 * waking every 90s would pass the Workers Free daily request cap
 * (https://developers.cloudflare.com/durable-objects/platform/pricing/).
 * A dead socket closes on its own; the next push or reconnect is the signal.
 * The ping is not written to Neon.
 */
export class DeviceSession extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 426 })
    const protocol = request.headers.get('sec-websocket-protocol')
    if (!protocol) return new Response(null, { status: 400 })
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // One live socket. A reconnect replaces the previous one so a device
    // does not keep a second hibernating connection.
    for (const existing of this.ctx.getWebSockets()) existing.close(4000, 'replaced')
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ connectedAt: Date.now() } satisfies ConnectionAttachment)
    // The edge authenticated this exact ticket. Node's built-in WebSocket
    // rejects the upgrade unless its offered protocol is selected here.
    return new Response(null, {
      status: 101,
      headers: { 'sec-websocket-protocol': protocol },
      webSocket: client,
    })
  }

  /** Queried on demand. Auto-pongs update this timestamp without waking JS. */
  async status(): Promise<{ online: boolean; lastSeenAt: string | null }> {
    let lastSeen = 0
    for (const socket of this.ctx.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      const connectedAt = attachment?.connectedAt ?? 0
      const lastPong = this.ctx.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? 0
      lastSeen = Math.max(lastSeen, connectedAt, lastPong)
    }
    return {
      online: lastSeen > 0 && Date.now() - lastSeen < ONLINE_WINDOW_MS,
      lastSeenAt: lastSeen > 0 ? new Date(lastSeen).toISOString() : null,
    }
  }

  webSocketClose(socket: WebSocket, code: number, reason: string) {
    // These callback statuses are reserved and cannot be sent in a close
    // frame. In particular, a client calling close() supplies code 1005.
    if (code === 1005 || code === 1006) socket.close()
    else socket.close(code, reason)
  }

  /** Wake this device. The text is the signal only; the work stays in Neon until the device asks. */
  async notify() {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send('work') } catch { /* a closing socket is dropped by the runtime */ }
    }
  }
}
