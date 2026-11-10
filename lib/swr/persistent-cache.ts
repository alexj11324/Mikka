import type { State } from 'swr'
import { persistentReadData, persistentReadKey } from './cache-policy'
import { IndexedReadStorage, type ReadStorage } from './indexed-db'

export type ReadCacheScope = { userId: string; workspaceId: string; build: string; role: string; server?: string | null; accessProof?: string }
export type ReadCacheState = State<unknown, unknown> & { _k?: unknown }
export const readCacheNamespace = (scope: ReadCacheScope) => JSON.stringify(scope.accessProof
  ? [3, scope.server ?? '', scope.userId, scope.workspaceId, scope.build, scope.role, scope.accessProof]
  : scope.server
  ? [2, scope.server, scope.userId, scope.workspaceId, scope.build, scope.role]
  : [1, scope.userId, scope.workspaceId, scope.build, scope.role])
type Restore = (key: string, data: unknown) => Promise<unknown>
type RevalidateHydratedRead = () => Promise<unknown>
const activeCaches = new Set<PersistentReadCache>()
const issueResourceId = (key: unknown): string | undefined => Array.isArray(key) && ['issue', 'issue-activity-versions', 'versions'].includes(key[0]) && typeof key[1] === 'string' ? key[1] : undefined

export function readAccessFailure(error: unknown): 'session' | 'workspace' | 'resource' | null {
  if (!error || typeof error !== 'object') return null
  const value = error as { status?: unknown; statusCode?: unknown; code?: unknown; kind?: unknown; name?: unknown }
  const status = value.status ?? value.statusCode
  if (status === 401 || value.code === 'authRequired' || value.kind === 'owner') return 'session'
  if (status === 403 || value.code === 'workspaceAccessDenied' || value.kind === 'workspace') return 'workspace'
  if (status === 404 || value.code === 'issueNotFound' || value.code === 'botNotFound') return 'resource'
  return null
}

/** SWR still reads synchronously from memory; IndexedDB is only the durable
 * backing. Every startup fetch waits for hydration, then uses the restored
 * cursor. Hydration never overwrites a newer server result or optimistic write. */
export class PersistentReadCache extends Map<string, ReadCacheState> {
  readonly namespace: string | null
  /** Authority for invalidation also survives the non-persistent fallback. */
  private readonly authorityNamespace: string | null
  readonly ownerId: string | undefined
  readonly workspaceId: string | undefined
  readonly accessProof: string | undefined
  readonly hydrated: Promise<void>
  private finishHydration!: () => void
  private started = false
  private enabled = true
  private hydrationComplete = false
  private restoring = false
  private revisions = new Map<string, number>()
  private removedIssues = new Set<string>()
  private freshData = new Set<string>()
  private startupReads = new Map<string | RevalidateHydratedRead, Set<RevalidateHydratedRead>>()
  private pending: Promise<unknown> = Promise.resolve()
  private invalidated?: (documentNavigation: boolean) => void
  private channel?: BroadcastChannel

  constructor(scope: ReadCacheScope | null, private storage: ReadStorage = new IndexedReadStorage(), persistent = true) {
    super()
    this.ownerId = scope?.userId
    this.workspaceId = scope?.workspaceId
    this.accessProof = scope?.accessProof
    this.authorityNamespace = scope ? readCacheNamespace(scope) : null
    this.namespace = scope && persistent ? readCacheNamespace(scope) : null
    this.hydrated = new Promise(resolve => { this.finishHydration = resolve })
  }

  get isHydrated() { return this.hydrationComplete }
  get isEnabled() { return this.enabled }
  hasFreshData(key: string) { return this.freshData.has(key) }

  trackHydrationRead(key: string, revalidate: RevalidateHydratedRead) {
    const registration = key || revalidate
    const readers = this.startupReads.get(registration) ?? new Set<RevalidateHydratedRead>()
    readers.add(revalidate)
    this.startupReads.set(registration, readers)
    return () => {
      readers.delete(revalidate)
      if (!readers.size) this.startupReads.delete(registration)
    }
  }

  resumeHydrationReads() {
    if (!this.hydrationComplete || !this.enabled) return
    for (const [key, readers] of this.startupReads) {
      if (typeof key === 'string' && this.hasFreshData(key)) continue
      // The bound hook knows its actual SWR key. In particular, an infinite
      // hook revalidates its aggregate key rather than an ordinary page key.
      const revalidate = readers.values().next().value
      if (revalidate) void revalidate().catch(() => undefined)
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work)
    this.pending = next.catch(() => undefined)
    return next
  }

  override set(key: string, state: ReadCacheState): this {
    if (!this.enabled) return this
    const previous = this.get(key)
    const failure = readAccessFailure(state.error)
    if (failure === 'session' || failure === 'workspace') { this.invalidate(); return this }
    const rawKey = state._k ?? previous?._k ?? key
    const issueId = issueResourceId(rawKey)
    if (failure === 'resource' && issueId) this.removeIssue(issueId)
    else if (issueId && state.data !== undefined) this.removedIssues.delete(issueId)
    const next = failure ? { ...state, data: undefined } : state
    super.set(key, next)
    if (!this.restoring && next.data !== undefined && next.data !== previous?.data) this.freshData.add(key)
    if (next.data !== previous?.data || failure) this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    if (!this.enabled || this.restoring || !this.namespace || next.data === previous?.data && !failure) return this
    const namespace = this.namespace
    const data = persistentReadData(rawKey, next.data)
    void this.enqueue(() => !this.enabled ? Promise.resolve() : data === undefined ? this.storage.remove(namespace, key) : this.storage.write(namespace, { key, rawKey, data, savedAt: Date.now() })).catch(() => undefined)
    return this
  }

  private removeIssue(id: string) {
    // A removed task and its history share authority. Mark even absent keys as
    // deleted so a concurrently opening disk snapshot cannot bring them back.
    this.removedIssues.add(id)
    for (const [key, state] of this) if (issueResourceId(state._k) === id) this.delete(key)
  }

  override delete(key: string) {
    this.freshData.delete(key)
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    if (this.namespace) void this.enqueue(() => this.storage.remove(this.namespace!, key)).catch(() => undefined)
    return super.delete(key)
  }

  async hydrate(restore: Restore): Promise<void> {
    if (this.started) return this.hydrated
    this.started = true
    const initial = new Map(this.revisions)
    try {
      if (!this.namespace || !this.enabled) return
      // Activation shares the write queue: an invalidate must clear after even
      // a slow database open, rather than letting activation resurrect its scope.
      const values = await this.enqueue(() => this.enabled ? this.storage.activate(this.namespace!, () => this.enabled) : Promise.resolve([]))
      if (!this.enabled) return
      for (const value of values) {
        const issueId = issueResourceId(value.rawKey)
        if (issueId && this.removedIssues.has(issueId)) { this.delete(value.key); continue }
        if (!this.enabled || !persistentReadKey(value.rawKey) || this.get(value.key)?.data !== undefined || this.revisions.get(value.key) !== initial.get(value.key)) continue
        const data = persistentReadData(value.rawKey, value.data)
        if (data === undefined) continue
        // Preserve SWR's mounted key/validation bookkeeping; only its data is restored.
        this.restoring = true
        try {
          super.set(value.key, { ...this.get(value.key), _k: value.rawKey })
          await restore(value.key, data)
        } finally { this.restoring = false }
      }
    } catch {
      // Storage may be unavailable, full or blocked in private browsing. The
      // ordinary authorized network read remains the source of truth.
    } finally { this.hydrationComplete = true; this.finishHydration() }
  }

  connect(onInvalidated: (documentNavigation: boolean) => void) {
    this.invalidated = onInvalidated
    activeCaches.add(this)
    if (typeof BroadcastChannel !== 'undefined' && this.authorityNamespace) {
      this.channel = new BroadcastChannel('mikka-read-cache')
      this.channel.onmessage = event => {
        const value = event.data as { type?: unknown; scope?: unknown } | null
        if (value?.type === 'clear' && (!value.scope || value.scope === this.authorityNamespace) || value?.type === 'scope' && value.scope !== this.authorityNamespace) this.invalidate(false)
      }
      this.channel.postMessage({ type: 'scope', scope: this.authorityNamespace })
    }
    return () => {
      activeCaches.delete(this)
      this.channel?.close(); this.channel = undefined
      this.invalidated = undefined
      // A departed provider must not activate after the next page clears it.
      // StrictMode immediately reconnects the same provider; preserve that case.
      queueMicrotask(() => {
        if (activeCaches.has(this)) return
        this.enabled = false
        super.clear()
        this.hydrationComplete = true
        this.finishHydration()
      })
    }
  }

  invalidate(broadcast = true, documentNavigation = false) {
    if (!this.enabled) return
    this.enabled = false
    super.clear()
    this.hydrationComplete = true
    this.finishHydration()
    // Clear after any writes already in flight; future writes are disabled.
    // Retiring an old tab must not clear a newly activated account's namespace.
    if (this.namespace) void this.enqueue(() => this.storage.clear(this.namespace!)).catch(() => undefined)
    if (broadcast) this.channel?.postMessage({ type: 'clear', scope: this.authorityNamespace })
    this.invalidated?.(documentNavigation)
  }

  async flushed() { await this.pending }
}

export async function waitForCacheHydration(cache: object) {
  if (cache instanceof PersistentReadCache) await cache.hydrated
}

/** Cross-tab reads have the same authority boundary as the authenticated
 * provider. Memory fallbacks and a retired provider cannot export/adopt data. */
export function readCacheShareNamespace(cache: object, ownerId: string): string | null {
  return cache instanceof PersistentReadCache && cache.isEnabled && cache.ownerId === ownerId ? cache.namespace : null
}

/** Successful logout, account deletion and workspace/account switches share
 * this path. No token, account content or credential is broadcast. */
/** Validated access events retire in-flight requests and mounted child state. */
export async function invalidateResourceAccessCaches(workspaceId: string, proof?: string) {
  const affected=[...activeCaches].filter(cache => cache.workspaceId === workspaceId && (!proof || cache.accessProof !== proof))
  if(affected.length)(await import('../chat-drafts')).clearChatDrafts()
  await Promise.all(affected.map(cache => cache.invalidate()))
}

export async function clearPersistentReadCaches(options: { documentNavigation?: boolean } = {}) {
  // Invalidating calls React subscribers, which may unregister or create a
  // provider. Work on one snapshot so none of its pending writes escape the wait.
  const caches = [...activeCaches]
  // A confirmed full-page switch needs no fresh reader in the departing
  // Document. Other tabs still receive the ordinary clear/revalidate signal.
  for (const cache of caches) cache.invalidate(false, options.documentNavigation === true)
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('mikka-read-cache')
    channel.postMessage({ type: 'clear' }); channel.close()
  }
  await Promise.all(caches.map(cache => cache.flushed()))
  // There may be no mounted cache (for example sign-out from a plugin page).
  try { if (typeof indexedDB !== 'undefined') await new IndexedReadStorage().clear() } catch { /* memory-only fallback */ }
}
