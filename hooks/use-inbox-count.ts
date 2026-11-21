'use client'

import { useEffect } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { useLiveKeys } from './use-live-key'
import { readInboxCount, readableInboxCount } from '@/lib/inbox/client'
import { webSelectionVersion } from '@/lib/web-connection/selection'

export function inboxCountKey(version: number, ownerId: string, workspaceId: string) {
  return ['inbox-count', version, ownerId, workspaceId] as const
}

/** The rail reads the same authorized pending set as Inbox. This read cannot create a suggestion or wake a run. */
export function useInboxCount(ownerId: string, workspaceId: string | undefined, enabled: boolean) {
  const version = webSelectionVersion()
  const key = enabled && workspaceId ? inboxCountKey(version, ownerId, workspaceId) : null
  const { data, error, mutate } = useSWR(key, ([, selected, , workspace]) => readInboxCount(workspace, selected), {
    revalidateOnFocus: false, shouldRetryOnError: false,
  })
  useLiveKeys(key && workspaceId ? [
    { kind: 'pending_actions', id: workspaceId }, { kind: 'issue_list', id: workspaceId },
  ] : [], key ? [unstable_serialize(key)] : [], workspaceId)
  const counts = readableInboxCount(data, error)
  const unreadable = counts === undefined
  useEffect(() => {
    // Also retire a revoked count on standard in-memory SWR providers. A later network error cannot resurrect it.
    if (data !== undefined && unreadable) void mutate(undefined, { revalidate: false })
  }, [unreadable, data, mutate])
  return key ? counts : undefined
}
