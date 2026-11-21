// Gateway pushes for waits other than run control (#1212, decision
// 2026-11-17-2215). A push is a hint to read again, never authority. Every
// server pushes; while the socket is down nothing is read, and the socket's
// next open counts as a push because one may have been lost meanwhile.

export class DeviceWorkSignal {
  private connected = false
  private readonly listeners = new Set<() => void>()

  /** Whether the device session socket is open. */
  get live(): boolean { return this.connected }

  /** The socket opened or dropped. Opening wakes every waiter to read again. */
  setConnected(connected: boolean) {
    if (this.connected === connected) return
    this.connected = connected
    this.notify()
  }

  /** A work frame arrived on the gateway socket. */
  notify() { for (const listener of [...this.listeners]) listener() }

  /** Calls `listener` on each push or connection change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
