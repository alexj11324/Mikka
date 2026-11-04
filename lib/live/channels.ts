import { LiveChannel, type LiveRuntime, type LiveSubscriptionOptions } from './channel'
import type { LiveKind } from './events'

/** A page may display an owned task from another workspace. Share by its authorized scope. */
export class LiveChannels {
  private channels = new Map<string | null, { channel: LiveChannel; subscribers: number }>()
  constructor(private runtime: (workspaceId: string | null) => LiveRuntime) {}

  subscribe(workspaceId: string | null, kind: LiveKind, id: string, keys: readonly string[], refresh: (key: string) => unknown, options?: LiveSubscriptionOptions) {
    let entry = this.channels.get(workspaceId)
    if (!entry) {
      entry = { channel: new LiveChannel(this.runtime(workspaceId)), subscribers: 0 }
      this.channels.set(workspaceId, entry)
    }
    const current = entry
    current.subscribers++
    const unsubscribe = current.channel.subscribe(kind, id, keys, refresh, options)
    return () => {
      unsubscribe()
      if (--current.subscribers === 0 && this.channels.get(workspaceId) === current) this.channels.delete(workspaceId)
    }
  }

  dispose() {
    for (const { channel } of this.channels.values()) channel.dispose()
    this.channels.clear()
  }
}
