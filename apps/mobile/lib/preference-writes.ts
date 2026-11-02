export interface PreferenceWriteState<T> { status: 'idle' | 'saving' | 'unconfirmed'; intent: Partial<T> }

/** One account's preference writes; confirmed values and unconfirmed intent stay separate. */
export class PreferenceWrites<T extends object> {
  private state: PreferenceWriteState<T> = { status: 'idle', intent: {} }
  private listeners = new Set<() => void>()
  private queued: Partial<T> = {}
  private running: Promise<boolean> | null = null
  constructor(private readonly deps: { write: (patch: Partial<T>) => Promise<T>; confirm: (preferences: Partial<T>) => void; current: () => boolean }) {}
  snapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(status: PreferenceWriteState<T>['status'], intent: Partial<T>) {
    this.state = { status, intent }
    for (const listener of this.listeners) listener()
  }
  save(patch: Partial<T>): Promise<boolean> {
    if (!this.deps.current()) return Promise.resolve(false)
    this.queued = { ...this.queued, ...patch }
    const intent = { ...this.state.intent, ...patch }
    if (this.state.status === 'unconfirmed') { this.publish('unconfirmed', intent); return Promise.resolve(false) }
    this.publish('saving', intent)
    return this.start()
  }
  retry = () => {
    if (!this.deps.current()) return Promise.resolve(false)
    this.publish('saving', this.state.intent)
    return this.start()
  }
  private start() {
    if (this.running) return this.running
    this.running = this.drain().finally(() => { this.running = null })
    return this.running
  }
  private async drain(): Promise<boolean> {
    while (Object.keys(this.queued).length) {
      if (!this.deps.current()) return false
      const sent = this.queued
      this.queued = {}
      try {
        const confirmed = await this.deps.write(sent)
        if (!this.deps.current()) return false
        this.deps.confirm(confirmed)
        this.publish(Object.keys(this.queued).length ? 'saving' : 'idle', { ...this.queued })
      } catch {
        if (this.deps.current()) {
          this.queued = { ...sent, ...this.queued }
          this.publish('unconfirmed', { ...this.queued })
        }
        return false
      }
    }
    return true
  }
}
