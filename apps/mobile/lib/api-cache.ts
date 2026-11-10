/** A cache belongs to one signed-in account/workspace context at a time. */
export class ApiCache {
  private generation = 0
  private identity: string | null = null
  private ownerId: string | null = null
  private values = new Map<string, unknown>()
  private listeners = new Set<() => void>()
  private accessProofs = new Map<string,string>()
  private accessDeadlines = new Map<string,number>()
  private accessTimer: ReturnType<typeof setTimeout> | null = null
  constructor(private now: () => number = () => typeof performance !== 'undefined' ? performance.now() : Date.now()) {}
  context() { return this.generation }
  account() { return this.identity }
  owner() { return this.ownerId }
  get<T>(path: string): T | null { return (this.values.get(path) as T | undefined) ?? null }
  watch = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.generation
  clear() { this.generation++; this.values.clear(); for (const listener of this.listeners) listener() }
  accessProof(workspaceId:string,proof:string,expiresAt:string|null=null, expiresAfterMs:number|null=null, requestedAt=this.now()) {
    const previous = this.accessProofs.get(workspaceId)
    this.accessProofs.set(workspaceId,proof)
    const deadline = expiresAt ? requestedAt + (expiresAfterMs !== null && Number.isFinite(expiresAfterMs)
      ? Math.max(0, expiresAfterMs) : 0) : NaN
    if (Number.isFinite(deadline)) this.accessDeadlines.set(workspaceId,deadline)
    else this.accessDeadlines.delete(workspaceId)
    if (previous && previous !== proof) this.clear()
    this.expireAccess()
  }
  /** One known expiry deadline, never an idle polling loop. Foreground/live
   * reads call this as well because native timers may pause in the background. */
  expireAccess() {
    if (this.accessTimer) clearTimeout(this.accessTimer)
    this.accessTimer = null
    const now = this.now()
    let expired = false
    for (const [workspaceId,deadline] of this.accessDeadlines) if (deadline <= now) {
      this.accessDeadlines.delete(workspaceId)
      expired = true
    }
    if (expired) this.clear()
    if (this.accessDeadlines.size) this.accessTimer = setTimeout(() => this.expireAccess(),
      Math.min(2_147_483_647,Math.max(0,Math.min(...this.accessDeadlines.values()) - now)))
  }
  setIdentity(identity: string | null, ownerId: string | null = identity) {
    if (this.identity === identity && this.ownerId === ownerId) return
    this.identity = identity
    this.ownerId = identity ? ownerId : null
    this.accessProofs.clear()
    this.accessDeadlines.clear()
    if (this.accessTimer) clearTimeout(this.accessTimer)
    this.accessTimer = null
    this.clear()
  }
  commit(context: number, apply: () => void): boolean {
    if (context !== this.generation) return false
    apply()
    return true
  }
  set(path: string, value: unknown, context: number) { return this.commit(context, () => { this.values.set(path, value) }) }
  forget(path: string, context: number) { return this.commit(context, () => { this.values.delete(path) }) }
  async prefetch(path: string, read: (path: string) => Promise<unknown>) {
    if (this.values.has(path)) return
    const context = this.context()
    try { this.set(path, await read(path), context) } catch { /* the screen loads it itself */ }
  }
}

export const apiCache = new ApiCache()
