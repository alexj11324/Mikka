/** A cache belongs to one signed-in account/workspace context at a time. */
export class ApiCache {
  private generation = 0
  private identity: string | null = null
  private sessionId: string | null = null
  private ownerId: string | null = null
  private values = new Map<string, unknown>()
  private revisions = new Map<string, { version: number; denial: Error | null }>()
  private revocations = new Map<string, Set<(reason: Error) => void>>()
  revision(path: string) { return this.revisions.get(path)?.version ?? 0 }
  denial(path: string) { return this.revisions.get(path)?.denial ?? null }
  onRevoked(path: string, listener: (reason: Error) => void) {
    const subscribers = this.revocations.get(path) ?? new Set<(reason: Error) => void>()
    subscribers.add(listener)
    this.revocations.set(path, subscribers)
    return () => {
      subscribers.delete(listener)
      if (subscribers.size === 0) this.revocations.delete(path)
    }
  }
  revoke(path: string, context: number, reason: Error) {
    this.commit(context, () => {
      this.values.delete(path)
      this.revisions.set(path, { version: this.revision(path) + 1, denial: reason })
      for (const listener of this.revocations.get(path) ?? []) listener(reason)
    })
  }
  context() { return this.generation }
  account() { return this.identity }
  owner() { return this.ownerId }
  get<T>(path: string): T | null { return (this.values.get(path) as T | undefined) ?? null }
  clear() { this.generation++; this.values.clear(); this.revisions.clear() }
  setIdentity(identity: string | null, ownerId: string | null = identity, sessionId: string | null = null) {
    if (this.identity === identity && this.ownerId === ownerId && this.sessionId === sessionId) return
    this.sessionId = sessionId
    this.identity = identity
    this.ownerId = identity ? ownerId : null
    this.clear()
  }
  commit(context: number, apply: () => void): boolean {
    if (context !== this.generation) return false
    apply()
    return true
  }
  set(path: string, value: unknown, context: number) { return this.commit(context, () => { this.values.set(path, value) }) }
  /** Only a newer successful read can supersede a server denial, including across screen mounts. */
  storeRead(path: string, value: unknown, context: number) {
    return this.commit(context, () => {
      this.values.set(path, value)
      const revision = this.revisions.get(path)
      if (revision) revision.denial = null
    })
  }
  async prefetch(path: string, read: (path: string) => Promise<unknown>) {
    if (this.values.has(path)) return
    const context = this.context(), revision = this.revision(path)
    try {
      const value = await read(path)
      if (revision === this.revision(path)) this.storeRead(path, value, context)
    } catch { /* the screen loads it itself */ }
  }
}

export const apiCache = new ApiCache()
