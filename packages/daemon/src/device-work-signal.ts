// Gateway pushes for waits other than run control (#1212). A push is a hint
// to read again, never authority. Which waits a server pushes for is in its
// gateway ticket; against an older server, or while the socket is down, a
// waiter keeps a timer.

/** Waits the gateway ticket can say the server pushes for. */
export type PushedWait = 'computerReviews' | 'coordinatorResults'

/**
 * - `legacy`: this server does not push for the wait; keep its old cadence.
 * - `push`: the gateway is connected and the server pushes for it; read on each push.
 * - `fallback`: the server pushes for it, but the gateway is down; a slow timer.
 */
export type PushMode = 'legacy' | 'push' | 'fallback'

export class DeviceWorkSignal {
  private connected = false
  private pushed = new Set<PushedWait>()
  private readonly listeners = new Set<() => void>()

  /** From the last gateway ticket: the waits this server pushes for. */
  setPushedWaits(waits: Iterable<PushedWait>) {
    this.pushed = new Set(waits)
    this.notify()
  }

  /** The gateway socket opened or dropped. Either way, read again: a push may have been lost meanwhile. */
  setConnected(connected: boolean) {
    if (this.connected === connected) return
    this.connected = connected
    this.notify()
  }

  mode(wait: PushedWait): PushMode {
    if (!this.pushed.has(wait)) return 'legacy'
    return this.connected ? 'push' : 'fallback'
  }

  /** A work frame arrived on the gateway socket. */
  notify() { for (const listener of [...this.listeners]) listener() }

  /** Calls `listener` on each push or mode change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Resolves on the next push or mode change, after `ms`, or on abort. */
  next(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise(resolve => {
      if (signal?.aborted) { resolve(); return }
      const done = () => { clearTimeout(timer); off(); signal?.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, Math.max(0, ms))
      const off = this.subscribe(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }
}
