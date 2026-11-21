'use client'

import useSWR, { unstable_serialize } from 'swr'
import { listWorkspaceTaskPage } from '@/app/actions/issues'
import { useLiveKey } from '@/hooks/use-live-key'
import { useTaskContinuation } from '@/lib/hooks/use-task-continuation'
import type { TaskListView } from '@/lib/task-list-page'

/**
 * A task list tab other than All (S1-C): its first page read on the server, where the view narrows before the page
 * limit, then the next pages on request with the same cursor continuation as the All list, so the board shows every
 * task the tab's count names. A live issue_list change refreshes the first page and retires the loaded tail.
 */
export function useTaskViewPage(userId: string, workspaceId: string | null | undefined, view: TaskListView | null) {
  const key = workspaceId && view && view !== 'all' ? ['task-list-view-page', userId, workspaceId, view] as const : null
  const first = useSWR(key, ([, , workspace, current]) => listWorkspaceTaskPage({ workspaceId: workspace, view: current, after: null }),
    { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKey('issue_list', key ? workspaceId : null, key ? [unstable_serialize(key)] : [], workspaceId, { minIntervalMs: 2000 })
  const paging = useTaskContinuation(first.data?.items ?? [], first.data, first.data?.next ?? null, async after => {
    if (!key) throw new Error('taskViewMissing')
    const page = await listWorkspaceTaskPage({ workspaceId: key[2], view: key[3], after })
    // The anchor left this view (moved, deleted, or no longer visible): read the first page again.
    if (page.reset) { await first.mutate(); throw new Error('issueStale') }
    return page
  })
  return { active: Boolean(key), items: paging.items, error: first.error, retry: () => first.mutate(), hasMore: paging.hasMore, loading: paging.loading, failed: paging.failed, loadMore: paging.loadMore }
}
