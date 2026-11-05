/** One model mutation at a time: a second tap must not race a saved choice or refresh. */
export class ModelMenuWrite {
  private busy = false
  private listeners = new Set<() => void>()
  snapshot = () => this.busy
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish() { for (const listener of this.listeners) listener() }
  run<T>(write: () => Promise<T>): Promise<T | undefined> {
    if (this.busy) return Promise.resolve(undefined)
    this.busy = true; this.publish()
    return Promise.resolve().then(write).finally(() => { this.busy = false; this.publish() })
  }
}
