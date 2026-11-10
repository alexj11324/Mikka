import { LiveChannel, type LiveRefresh, type LiveRuntime, type LiveSubscriptionOptions } from './channel'
import type { LiveKind } from './events'

/** A page may display an owned task from another workspace. Share by its authorized scope. */
export class LiveChannels {
  private channels = new Map<string | null, { channel: LiveChannel; subscribers: number }>()
  constructor(private runtime: (workspaceId: string | null) => LiveRuntime) {}

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
    let entry = this.channels.get(workspaceId)
    if (!entry) {
      entry = { channel: new LiveChannel(this.runtime(workspaceId)), subscribers: 0 }
      this.channels.set(workspaceId, entry)
    }
    const current = entry
    current.subscribers++
    const unsubscribe = current.channel.subscribe(kind, id, keys, refresh, options)
    return Object.assign(() => {
      unsubscribe()
      if (--current.subscribers === 0 && this.channels.get(workspaceId) === current) this.channels.delete(workspaceId)
    }, { update: unsubscribe.update })
  }

  dispose() {
    for (const { channel } of this.channels.values()) channel.dispose()
    this.channels.clear()
  }
}
