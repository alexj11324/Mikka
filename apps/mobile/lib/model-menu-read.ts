/** Deduplicates the model chip's explicit read retries; a failed read stays retryable. */
export class ModelMenuRead {
  private pending: Promise<void> | null = null
  private busy = false
  private listeners = new Set<() => void>()
  constructor(private readonly read: () => Promise<void>) {}
  snapshot = () => this.busy
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(busy: boolean) { this.busy = busy; for (const listener of this.listeners) listener() }
  retry = () => {
    if (this.pending) return this.pending
    this.publish(true)
    this.pending = Promise.resolve().then(this.read).finally(() => { this.pending = null; this.publish(false) })
    return this.pending
  }
}
