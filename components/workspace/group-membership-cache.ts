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
export function useGroupMembershipLoss(ownerId: string, workspaceId: string | null, groups: GroupSummary[] | undefined, onRemoved: (id: string) => void) {
  const previous = useRef<{ ownerId: string; workspaceId: string; groups: GroupSummary[] } | null>(null)
  const removed = useEffectEvent(onRemoved)
  useEffect(() => {
    if (!workspaceId || !groups) return
    const old = previous.current
    previous.current = { ownerId, workspaceId, groups }
    if (!old || old.ownerId !== ownerId || old.workspaceId !== workspaceId) return
    const visible = new Set(groups.map(group => group.id))
    for (const group of old.groups) if (!visible.has(group.id)) removed(group.id)
  }, [ownerId, workspaceId, groups])
}
