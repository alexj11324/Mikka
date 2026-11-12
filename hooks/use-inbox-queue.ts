'use client'

import { useEffect, useState } from 'react'
import { readAccessFailure } from '@/lib/swr/persistent-cache'
import { useSWRConfig } from 'swr'
import { inboxCountKey } from './use-inbox-count'
import useSWRInfinite, { unstable_serialize } from 'swr/infinite'
import { useLiveKeys } from '@/hooks/use-live-key'
import { readInboxPage, submitInboxCommand, type InboxTab } from '@/lib/inbox/client'
import type { InboxPage, InboxCommand, InboxEntry } from '@/lib/inbox/contract'
import { webSelectionVersion } from '@/lib/web-connection/selection'

export function useInboxQueue(ownerId: string | undefined, workspaceId: string | undefined, tab: InboxTab) {
  const { mutate } = useSWRConfig()
  const version = webSelectionVersion()
  const getKey = (index: number, previous: InboxPage | null) => {
    if (!ownerId || !workspaceId || (index > 0 && !previous?.nextCursor)) return null
    return ['inbox-queue', version, ownerId, workspaceId, tab, index ? previous!.nextCursor : null] as const
  }
  const read = useSWRInfinite<InboxPage, Error, typeof getKey>(getKey, ([, selected, , workspace, list, cursor]) => readInboxPage(workspace, list, cursor, selected), {
    revalidateOnFocus: false, shouldRetryOnError: false,
  })
  useLiveKeys(ownerId && workspaceId ? [
    { kind: 'pending_actions', id: workspaceId }, { kind: 'issue_list', id: workspaceId },
  ] : [], [unstable_serialize(getKey)], workspaceId)
  const scope = JSON.stringify([version, ownerId, workspaceId, tab])
  const [deniedScope, setDeniedScope] = useState<string | null>(null)
  const denied = Boolean(readAccessFailure(read.error))
  useEffect(() => {
    if (denied) setDeniedScope(scope)
    else if (!read.error && read.data) setDeniedScope(null)
  }, [scope, denied, read.error, read.data])
  const forbidden = denied || deniedScope === scope
  const items = forbidden ? [] : read.data?.flatMap(page => page.items) ?? []
  const more = Boolean(read.data?.at(-1)?.nextCursor)
  function refreshAfterWrite() {
    if (!ownerId || !workspaceId || version !== webSelectionVersion()) return
    // The local reader must also converge on installations without a live gateway.
    // Refresh only mounted projections belonging to this command's original scope.
    void Promise.allSettled([mutate(unstable_serialize(getKey)), mutate(inboxCountKey(version, ownerId, workspaceId))])
  }
  async function command(entry: InboxEntry, action: 'reject' | 'undo_reject' | 'reopen' | 'snooze', until?: string) {
    if (!ownerId || !workspaceId || forbidden || !entry.actions.includes(action)) throw new Error('decisionUnavailable')
    const target = { workspaceId, type: entry.type, id: entry.id }
    let operation: InboxCommand
    if (action === 'snooze') {
      if (!until || !Number.isFinite(Date.parse(until))) throw new Error('inboxInvalid')
      operation = { ...target, action, until }
    } else operation = { ...target, action }
    const result = await submitInboxCommand(operation, version)
    refreshAfterWrite()
    return result
  }
  return {
    items, refreshAfterWrite, error: read.error, loading: !read.data && !read.error, more, loadingMore: read.size > (read.data?.length ?? 0),
    reload: read.mutate, loadMore: () => more && !read.isValidating ? read.setSize(size => size + 1) : undefined, command,
  }
}
