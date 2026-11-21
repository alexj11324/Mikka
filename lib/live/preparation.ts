import { LIVE_ID, type LiveKind } from './events'
import type { LiveRefresh, LiveRuntime, LiveSubscription, LiveSubscriptionOptions } from './channel'
import { LiveChannels, type LiveChannelRegistry } from './channels'

const routeId = (value: string | null | undefined): value is string => typeof value === 'string'
  && LIVE_ID.test(value) && value !== '00000000-0000-0000-0000-000000000000'
const ownerHomeKinds = new Set<LiveKind>(['thread_list', 'task_run_list', 'bot_chat_list'])
type Lease = { channels: LiveChannels; current(): boolean; confirmWorkspace(workspaceId?: string): void; release(): void }

/** One preparation belongs to one committed cache/provider lifetime. Its hints
 * choose tickets only; real subscriptions retain their own scopes and checks. */
export class PreparedLiveChannels {
  readonly channels: LiveChannels
  private cache: object | null = null
  private owner: object | null = null
  private lease: Lease | null = null
  private retired = false
  private authorityRetired = false
  private authorityListeners = new Set<() => void>()
  private reservations = new Map<'selected' | 'home', () => void>()
  private selectedHint: string | null
  private confirmedWorkspace: string | null = null

  constructor(runtime: (workspaceId: string | null) => LiveRuntime,
    scopes: { workspaceId?: string | null; homeWorkspaceId?: string | null }) {
    this.selectedHint = routeId(scopes.workspaceId) ? scopes.workspaceId : null
    this.channels = new LiveChannels(runtime, (workspaceId, kind, id) => {
      if (routeId(workspaceId) && LIVE_ID.test(id)) {
        if (workspaceId === this.confirmedWorkspace) this.confirm('selected', workspaceId)
      }
      // These owner-wide list contracts name their returned home as the entity.
      // A different fresh home T releases an unused hint S, never relabels T.
      if (workspaceId === id && routeId(workspaceId) && ownerHomeKinds.has(kind)) this.confirm('home', workspaceId)
    })
    if (routeId(scopes.workspaceId)) this.reservations.set('selected', this.channels.retain(scopes.workspaceId))
    if (routeId(scopes.homeWorkspaceId)) this.reservations.set('home', this.channels.retain(scopes.homeWorkspaceId))
  }

  get isRetired() { return this.retired }
  get isAuthorityRetired() { return this.authorityRetired }

  watchAuthority(retire: () => void) {
    if (this.authorityRetired) { retire(); return () => {} }
    this.authorityListeners.add(retire)
    return () => { this.authorityListeners.delete(retire) }
  }

  private confirm(role: 'selected' | 'home', workspaceId?: string) {
    if (this.retired || !routeId(workspaceId)) return
    if (role === 'selected') {
      this.confirmedWorkspace = workspaceId
      // Confirming the hint alone is not a real subscriber. Preserve the warm
      // socket until that same entry has a consumer; a mismatch releases it.
      if (workspaceId === this.selectedHint && !this.channels.hasSubscribers(workspaceId)) return
    }
    const release = this.reservations.get(role)
    this.reservations.delete(role)
    release?.()
  }

  /** Called from committed effects/subscriptions, never during React render. */
  claim(cache: object, owner: object): Lease | null {
    if (this.retired || this.owner && (this.owner !== owner || this.cache !== cache)) return null
    if (this.lease) return this.lease
    this.cache = cache
    this.owner = owner
    return this.lease = { channels: this.channels, current: () => !this.retired,
      confirmWorkspace: workspaceId => this.confirm('selected', workspaceId),
      release: () => { if (this.owner === owner) this.retire('provider') } }
  }

  retire(reason: 'authority' | 'provider' = 'authority') {
    if (reason === 'authority' && !this.authorityRetired) {
      this.authorityRetired = true
      for (const retire of this.authorityListeners) retire()
      this.authorityListeners.clear()
    }
    if (this.retired) return
    this.retired = true
    for (const release of this.reservations.values()) release()
    this.reservations.clear()
    this.channels.dispose()
  }
}

/** Rendering creates an inert owner. Only effect setup/subscribe adopts the
 * prepared registry. Discarded renders never consume or bind its cache. */
export class LiveChannelOwner implements LiveChannelRegistry {
  private active: { token: object; channels: LiveChannels; lease: Lease | null; blocked: boolean; unwatch: () => void } | null = null
  constructor(private runtime: (workspaceId: string | null) => LiveRuntime,
    private cache: object, private preparation?: PreparedLiveChannels) {}

  private current() {
    if (!this.active) {
      const token = {}
      const lease = this.preparation?.claim(this.cache, token) ?? null
      const current = { token, channels: lease?.channels ?? new LiveChannels(this.runtime), lease, blocked: false, unwatch: () => {} }
      this.active = current
      current.unwatch = this.preparation?.watchAuthority(() => {
        if (this.active !== current) return
        current.blocked = true
        current.channels.dispose()
      }) ?? (() => {})
    }
    return this.active
  }

  mount() {
    const { token } = this.current()
    return () => {
      const current = this.active
      if (!current || current.token !== token) return
      this.active = null
      current.unwatch()
      current.lease?.release()
      current.channels.dispose()
    }
  }

  confirmWorkspace(workspaceId?: string) { this.active?.lease?.confirmWorkspace(workspaceId) }

  keyConnected(key: string) {
    const current = this.active
    if (!current || current.blocked || current.lease && !current.lease.current()) return undefined
    return current.channels.keyConnected(key)
  }

  subscribe(workspaceId: string | null, kind: LiveKind, id: string, keys: readonly string[], refresh: LiveRefresh, options?: LiveSubscriptionOptions): LiveSubscription {
    const current = this.current()
    // A parent can retire authority before React tears down the old provider.
    // Old pending effects must not revive its connection in that interval.
    if (current.blocked || current.lease && !current.lease.current()) return Object.assign(() => {}, { update() {} })
    return current.channels.subscribe(workspaceId, kind, id, keys, refresh, options)
  }
}
