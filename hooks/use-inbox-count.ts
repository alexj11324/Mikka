'use client'

import useSWR, { unstable_serialize } from 'swr'
import { useLiveKeys } from './use-live-key'
import { readInboxCount } from '@/lib/inbox/client'
import { webSelectionVersion } from '@/lib/web-connection/selection'

/** The rail reads the same authorized pending set as Inbox. This read cannot create a suggestion or wake a run. */
export function useInboxCount(ownerId: string, workspaceId: string | undefined, enabled: boolean) {
  const version = webSelectionVersion()
  const key = enabled && workspaceId ? ['inbox-count', version, ownerId, workspaceId] as const : null
  const { data, error } = useSWR(key, ([, selected, , workspace]) => readInboxCount(workspace, selected), {
    revalidateOnFocus: false, shouldRetryOnError: false,
  })
  useLiveKeys(key && workspaceId ? [
    { kind: 'pending_actions', id: workspaceId }, { kind: 'issue_list', id: workspaceId },
  ] : [], key ? [unstable_serialize(key)] : [], workspaceId)
  return error ? 0 : data ?? 0
}
