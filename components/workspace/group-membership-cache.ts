'use client'
import { useEffect, useEffectEvent, useRef } from 'react'
import type { useSWRConfig } from 'swr'
import { unstable_serialize } from 'swr/infinite'
import { revokedGroupCacheKey, type GroupSummary } from '@/lib/group-messages'

export function forgetGroupReads(mutate: ReturnType<typeof useSWRConfig>['mutate'], id: string) {
  // SWR's key-filter mutation deliberately skips infinite aggregate keys.
  return Promise.all([
    mutate(unstable_serialize(() => ['group-messages', id, null]), undefined, { revalidate: false }),
    mutate(key => revokedGroupCacheKey(key, id), undefined, { revalidate: false }),
  ])
}

/** Only a successfully refreshed list in the same owner/workspace can revoke a group. */
export function useGroupMembershipLoss(ownerId: string, workspaceId: string | null, groups: GroupSummary[] | undefined, onRemoved: (id: string) => void, revalidate: () => Promise<unknown>) {
  const previous = useRef<{ ownerId: string; workspaceId: string; groups: GroupSummary[] } | null>(null)
  const removed = useEffectEvent(onRemoved)
  const refresh = useEffectEvent(revalidate)
  const channel = useRef<BroadcastChannel | null>(null)
  const name = workspaceId ? `mikka-group-list:${JSON.stringify([ownerId, workspaceId])}` : null
  useEffect(() => {
    if (!name || typeof window.BroadcastChannel !== 'function') return
    let current: BroadcastChannel
    try { current = new window.BroadcastChannel(name) } catch { return }
    channel.current = current
    current.onmessage = event => {
      // The hint carries no membership or transcript. Only the authenticated read can revoke a view.
      if (event.data === 'refresh') void refresh().catch(() => {})
    }
    return () => { current.close(); channel.current = null }
  }, [name])
  useEffect(() => {
    if (!workspaceId || !groups) return
    const old = previous.current
    previous.current = { ownerId, workspaceId, groups }
    if (!old || old.ownerId !== ownerId || old.workspaceId !== workspaceId) return
    const visible = new Set(groups.map(group => group.id))
    for (const group of old.groups) if (!visible.has(group.id)) removed(group.id)
  }, [ownerId, workspaceId, groups])
  return () => {
    const current = channel.current
    if (!current || current.name !== name) return
    try { current.postMessage('refresh') } catch { /* The authenticated live and reconnect reads remain available. */ }
  }
}
