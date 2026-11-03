import { DurableObject } from 'cloudflare:workers'

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
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    // One live socket. A reconnect replaces the previous one so a device
    // does not keep a second hibernating connection.
    for (const existing of this.ctx.getWebSockets()) existing.close(4000, 'replaced')
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Wake this device. The text is the signal only; the work stays in Neon until the device asks. */
  async notify() {
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send('work') } catch { /* a closing socket is dropped by the runtime */ }
    }
  }
}
