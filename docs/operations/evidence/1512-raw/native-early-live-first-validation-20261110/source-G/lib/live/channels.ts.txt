import { LiveChannel, type LiveRefresh, type LiveRuntime, type LiveSubscriptionOptions } from './channel'
import { LIVE_ID, type LiveKind } from './events'

type Entry = { channel: LiveChannel; subscribers: number; retainers: number }
export type LiveChannelRegistry = Pick<LiveChannels, 'keyConnected' | 'subscribe'>

/** A page may display an owned task from another workspace. Share by its authorized scope. */
export class LiveChannels {
  private channels = new Map<string | null, Entry>()
  constructor(private runtime: (workspaceId: string | null) => LiveRuntime,
    private subscribed?: (workspaceId: string | null, kind: LiveKind, id: string) => void) {}

  private entry(workspaceId: string | null) {
    let entry = this.channels.get(workspaceId)
    if (!entry) {
      entry = { channel: new LiveChannel(this.runtime(workspaceId)), subscribers: 0, retainers: 0 }
      this.channels.set(workspaceId, entry)
    }
    return entry
  }

  private release(workspaceId: string | null, entry: Entry) {
    if (!entry.subscribers && !entry.retainers && this.channels.get(workspaceId) === entry) this.channels.delete(workspaceId)
  }

  /** Does not register an entity or issue a business read. */
  retain(workspaceId: string) {
    if (!LIVE_ID.test(workspaceId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(workspaceId)) return () => {}
    const entry = this.entry(workspaceId)
    entry.retainers++
    const stop = entry.channel.retain()
    let active = true
    return () => {
      if (!active) return
      active = false
      stop(); entry.retainers--
      this.release(workspaceId, entry)
    }
  }

  hasSubscribers(workspaceId: string) { return (this.channels.get(workspaceId)?.subscribers ?? 0) > 0 }

  keyConnected(key: string): boolean | undefined {
    let connected: boolean | undefined
    for (const { channel } of this.channels.values()) {
      const current = channel.keyConnected(key)
      if (current === false) return false
      if (current === true) connected = true
    }
    return connected
  }

  subscribe(workspaceId: string | null, kind: LiveKind, id: string, keys: readonly string[], refresh: LiveRefresh, options?: LiveSubscriptionOptions) {
    if (!LIVE_ID.test(id)) return Object.assign(() => {}, { update() {} })
    const current = this.entry(workspaceId)
    current.subscribers++
    const unsubscribe = current.channel.subscribe(kind, id, keys, refresh, options)
    this.subscribed?.(workspaceId, kind, id)
    let active = true
    return Object.assign(() => {
      if (!active) return
      active = false
      unsubscribe(); current.subscribers--
      this.release(workspaceId, current)
    }, { update: unsubscribe.update })
  }

  dispose() {
    for (const { channel } of this.channels.values()) channel.dispose()
    this.channels.clear()
  }
}
