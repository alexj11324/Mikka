'use client'

import { useContext, useMemo } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { listWorkspaceTaskPage } from '@/app/actions/issues'
import { groupPresentedTasks } from '@/lib/task-collection'
import { useTaskContinuation } from '@/lib/hooks/use-task-continuation'
import { useLiveKeys, useLiveScope } from './use-live-key'
import { TaskPresentationsContext, useWorkspaceTaskPresentations } from './use-task-collection'
import type { BotTasksProps } from '@/components/slots/bot-tasks-contract'

/** The visible thread window is not the Bot's complete dispatch history. */
export function useDispatchedTasks({ botId, workspaceId, shown, query }: Pick<BotTasksProps, 'botId' | 'workspaceId' | 'shown' | 'query'>) {
  const scope = useLiveScope()
  const key = scope?.ownerId && workspaceId && botId ? ['dispatched-tasks', scope.ownerId, workspaceId, botId] : null
  const first = useSWR(key, () => listWorkspaceTaskPage({ workspaceId: workspaceId!, dispatchedBy: botId!, after: null }), { revalidateOnFocus: false, shouldRetryOnError: false })
  const live = key && workspaceId ? [
    { kind: 'issue_list' as const, id: workspaceId, workspaceId },
    ...(scope?.workspaceId ? [{ kind: 'task_run_list' as const, id: scope.workspaceId, workspaceId: scope.workspaceId }] : []),
  ] : []
  useLiveKeys(live, key ? [unstable_serialize(key)] : [], workspaceId ?? null, { minIntervalMs: 2000 })
  const paging = useTaskContinuation(first.data?.items ?? [], first.data, first.data?.next ?? null, async after => {
    const page = await listWorkspaceTaskPage({ workspaceId: workspaceId!, dispatchedBy: botId!, after })
    if (page.reset) { await first.mutate(); throw new Error('issueStale') }
    return page
  })
  const workspace = useContext(TaskPresentationsContext)
  const missing = useMemo(() => paging.items.filter(issue => !workspace[issue.id]), [paging.items, workspace])
  const extra = useWorkspaceTaskPresentations(scope?.ownerId ?? '', workspaceId, scope?.workspaceId ?? null, missing, Boolean(key))
  const groups = useMemo(() => {
    const matches = new Set(shown.map(thread => thread.issueId))
    const needle = query.trim().toLocaleLowerCase()
    const selected = paging.items.filter(issue => !needle || matches.has(issue.id) || [issue.title, issue.identifier].some(value => value?.toLocaleLowerCase().includes(needle)))
    return groupPresentedTasks(selected, shown, { ...extra.items, ...workspace }, 'workspace')
  }, [paging.items, shown, query, extra.items, workspace])
  return { groups, paging, isLoading: first.isLoading || extra.isLoading, error: first.error || extra.error, retry: () => Promise.all([first.mutate(), extra.mutate()]) }
}
