'use client'

import { useMemo } from 'react'
import useSWR from 'swr'
import { listUnreadTaskIds, setTaskUnread } from '@/app/actions/task-list'

const key = (workspaceId: string) => ['task-unread', workspaceId] as const

/**
 * The tasks this person marked unread in the workspace (Capy's Mark as unread, S1-C). One read per workspace, shared
 * by the board, its card menus and the task page; a toggle updates it in place. The flag is the person's own, so no
 * other reader's list changes and nothing else needs a live push.
 */
export function useTaskUnread(workspaceId: string | null | undefined) {
  const read = useSWR(workspaceId ? key(workspaceId) : null, ([, workspace]) => listUnreadTaskIds(workspace), { revalidateOnFocus: false, revalidateIfStale: false, shouldRetryOnError: false })
  const unread = useMemo(() => new Set(read.data ?? []), [read.data])
  async function set(id: string, next: boolean): Promise<boolean> {
    const result = await setTaskUnread({ id, unread: next }).catch(() => ({ error: 'generic' as const }))
    if ('error' in result && result.error) return false
    await read.mutate(current => next ? [...new Set([...(current ?? []), id])] : (current ?? []).filter(item => item !== id), { revalidate: false })
    return true
  }
  return { unread, loaded: read.data !== undefined, set }
}
