/** A cache belongs to one signed-in account/workspace context at a time. */
export class ApiCache {
  private generation = 0
  private identity: string | null = null
  private sessionId: string | null = null
  private ownerId: string | null = null
  private values = new Map<string, unknown>()
  context() { return this.generation }
  account() { return this.identity }
  owner() { return this.ownerId }
  get<T>(path: string): T | null { return (this.values.get(path) as T | undefined) ?? null }
  clear() { this.generation++; this.values.clear() }
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
  async prefetch(path: string, read: (path: string) => Promise<unknown>) {
    if (this.values.has(path)) return
    const context = this.context()
    try { this.set(path, await read(path), context) } catch { /* the screen loads it itself */ }
  }
}

export const apiCache = new ApiCache()
