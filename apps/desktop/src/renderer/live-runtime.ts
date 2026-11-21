import type { LiveRuntime, LiveSocket, LiveTicket } from '@/lib/live/channel'
import { rendererHost, type DesktopLiveEvent } from './host'

export function watchPageVisibility(changed: () => void) {
  document.addEventListener('visibilitychange', changed)
  return () => document.removeEventListener('visibilitychange', changed)
}

/** Only an owner-bound local connection id crosses the bridge. The remote
 * websocket address and its ticket are obtained, attached and renewed in main. */
class MainSocket implements LiveSocket {
  onopen: WebSocket['onopen'] = null
  onmessage: WebSocket['onmessage'] = null
  onclose: WebSocket['onclose'] = null
  onerror: WebSocket['onerror'] = null
  readyState: LiveSocket['readyState'] = 0
  private readonly stop: () => void
  constructor(private readonly id: string) {
    const host = rendererHost().live
    this.stop = host.onEvent(event => this.receive(event))
    void host.connect(id).catch(() => {
      if (this.readyState >= 2) return
      this.onerror?.call(this as unknown as WebSocket, new Event('error'))
      this.close()
    })
  }
  private receive(event: DesktopLiveEvent) {
    if (event.id !== this.id || this.readyState >= 2) return
    if (event.type === 'open') {
      this.readyState = 1
      this.onopen?.call(this as unknown as WebSocket, new Event('open'))
    } else if (event.type === 'message' && typeof event.data === 'string') {
      this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data: event.data }))
    } else if (event.type === 'error') {
      this.onerror?.call(this as unknown as WebSocket, new Event('error'))
    } else if (event.type === 'close') {
      this.readyState = 3
      this.stop()
      this.onclose?.call(this as unknown as WebSocket, new CloseEvent('close'))
    }
  }
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
    if (data !== 'ping' || this.readyState !== 1) return
    void rendererHost().live.send(this.id, data).catch(() => {
      this.onerror?.call(this as unknown as WebSocket, new Event('error'))
    })
  }
  close() {
    if (this.readyState >= 2) return
    this.readyState = 3
    this.stop()
    void rendererHost().live.close(this.id).catch(() => {})
  }
}

/** Only the transport differs; use-live-key and LiveChannel keep exactly the
 * same revision-aware, scoped invalidation and database request budget. */
export function browserRuntime(workspaceId: string | null): LiveRuntime {
  return {
    async ticket(signal) {
      if (!workspaceId || signal.aborted) return null
      const prepared = await rendererHost().live.prepare(workspaceId)
      if (!prepared) return null
      if (signal.aborted) {
        await rendererHost().live.close(prepared.id)
        return null
      }
      // This is a local handle, not a remotely usable URL or authorization token.
      return { url: `mikka-live://channel/${prepared.id}`, protocol: '', expiresAt: prepared.expiresAt } satisfies LiveTicket
    },
    socket: ticket => new MainSocket(new URL(ticket.url).pathname.slice(1)),
    visible: () => document.visibilityState === 'visible',
    watchVisibility(changed) {
      const unwatch = watchPageVisibility(changed)
      window.addEventListener('online', changed)
      return () => { unwatch(); window.removeEventListener('online', changed) }
    },
    now: Date.now,
    monotonicNow: () => performance.now(),
    later: (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  }
}
