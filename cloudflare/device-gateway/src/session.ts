import { DurableObject } from 'cloudflare:workers'
import { LIVE_REVISION_PARAM, liveInvalidations, liveReady, withoutRevisions, type LiveInvalidation } from '../../../lib/live/events'

const ONLINE_WINDOW_MS = 90_000

interface ConnectionAttachment {
  connectedAt: number
  liveExpiresAt?: number
  /** The socket asked for version 2 keys. Older tabs and the mobile app never do. */
  liveRevisions?: boolean
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
    const url = new URL(request.url)
    const live = url.pathname.startsWith('/v1/live/')
    const revisions = live && url.searchParams.get(LIVE_REVISION_PARAM) === '1'
    // A daemon reconnect replaces its previous socket. Browser tabs share
    // their owner/workspace channel until their individual tickets expire.
    for (const existing of this.ctx.getWebSockets()) {
      const expiry = (existing.deserializeAttachment() as ConnectionAttachment | null)?.liveExpiresAt
      if (!live) existing.close(4000, 'replaced')
      else if (expiry && expiry <= Date.now()) existing.close(4001, 'ticket expired')
    }
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ connectedAt: Date.now(), ...(live ? { liveExpiresAt: Number(protocol.match(/^mikka-ticket-(\d+)-/)?.[1]) * 1000 } : {}), ...(revisions ? { liveRevisions: true } : {}) } satisfies ConnectionAttachment)
    if (live) server.send(JSON.stringify(liveReady(revisions ? 2 : 1)))
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

  /** Browser tabs share a channel; an expired ticket never receives another key. */
  async notifyLive(events: LiveInvalidation[]) {
    const validated = liveInvalidations(events, true)
    if (!validated) return
    const plain = withoutRevisions(validated)
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null
      const expiry = attachment?.liveExpiresAt
      if (!expiry || expiry <= Date.now()) { socket.close(4001, 'ticket expired'); continue }
      // A version 1 reader drops any key with a third field, so it gets the plain key.
      try { for (const event of attachment?.liveRevisions ? validated : plain) socket.send(JSON.stringify(event)) }
      catch { /* a closing tab is dropped by the runtime */ }
    }
  }
}
