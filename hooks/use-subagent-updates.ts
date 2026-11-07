'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { withBasePath } from '@/lib/base-path'
import { pageRefreshSignal } from '@/lib/app-build'
import { ComputerEventFeed } from '@/lib/computer/event-stream'
import type { LiveChannels } from '@/lib/live/channels'
import type { SubagentUpdate } from '@/lib/subagents/login-needs'
import { useLiveScope } from './use-live-key'

const feeds = new WeakMap<LiveChannels, Map<string, ComputerEventFeed>>()
const empty: ReadonlyMap<string, SubagentUpdate> = new Map()
const emptySnapshot = () => empty
const noSubscribe = () => () => {}

function sharedFeed(channels: LiveChannels, workspaceId: string) {
  let scoped = feeds.get(channels)
  if (!scoped) { scoped = new Map(); feeds.set(channels, scoped) }
  let feed = scoped.get(workspaceId)
  if (!feed) {
    feed = new ComputerEventFeed({
      async page(cursor, signal) {
        const response = await fetch(withBasePath(`/api/computer/events?workspace=${encodeURIComponent(workspaceId)}&after=${encodeURIComponent(cursor)}`), {
          cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        })
        if (!response.ok) throw new Error('Computer events unavailable')
        return response.json()
      },
      visible: () => document.visibilityState === 'visible',
      watchVisibility(changed) {
        document.addEventListener('visibilitychange', changed)
        return () => document.removeEventListener('visibilitychange', changed)
      },
      invalidations: refresh => channels.subscribe(workspaceId, 'subagent_events', workspaceId, [`computer-events:${workspaceId}`],
        (_key, _required, _reuse, after) => refresh(after)),
      stopped: pageRefreshSignal(),
      later: (callback, milliseconds) => setTimeout(callback, milliseconds),
      cancel: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
    scoped.set(workspaceId, feed)
  }
  return feed
}

/** Channel identity changes with the owner; workspace changes select a separate cursor/cache. */
export function useSubagentUpdates() {
  const context = useLiveScope()
  const channels = context?.channels, workspaceId = context?.workspaceId
  const feed = useMemo(() => channels && workspaceId ? sharedFeed(channels, workspaceId) : null, [channels, workspaceId])
  return useSyncExternalStore(feed?.subscribe ?? noSubscribe, feed?.getSnapshot ?? emptySnapshot, emptySnapshot)
}
