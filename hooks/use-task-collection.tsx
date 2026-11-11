'use client'

import { createContext, useContext, useMemo } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { getTaskPresentations } from '@/app/actions/task-domain'
import { useLiveKeys, useLiveScope } from '@/hooks/use-live-key'
import { groupPresentedTasks, type CollectionIssue } from '@/lib/task-collection'
import { readPresentationPages } from '@/lib/task-presentation-batch'
import type { TaskPresentation } from '@/lib/task-presentation'
import type { Thread } from '@/app/actions/task-runs'

const EMPTY: Record<string, TaskPresentation> = {}
export const TaskPresentationsContext = createContext<Readonly<Record<string, TaskPresentation>>>(EMPTY)

/** The shell owns one batch per visible issue list. The Bot and Inbox views
 * consume that same result; neither owns a per-row request or a second cache. */
export function useWorkspaceTaskPresentations(ownerId: string, workspaceId: string | undefined,
  home: string | null, issues: readonly CollectionIssue[], enabled: boolean) {
  const ids = useMemo(() => issues.filter(issue => issue.workspaceId === workspaceId).map(issue => issue.id).sort(), [issues, workspaceId])
  const key = enabled && workspaceId && ids.length ? ['task-presentations', ownerId, workspaceId, ids] : null
  const { data, error, isLoading, mutate } = useSWR(key, async () => Object.fromEntries(await readPresentationPages(workspaceId!, ids,
    input => getTaskPresentations({ ...input, includeFactoryIdentity: true }))), {
    revalidateOnFocus: false, shouldRetryOnError: false,
  })
  const keys = key ? [unstable_serialize(key)] : []
  useLiveKeys(key && workspaceId ? [
    { kind: 'issue_list', id: workspaceId, workspaceId },
    ...(home && home !== workspaceId ? [{ kind: 'issue_list' as const, id: home, workspaceId: home }] : []),
    ...(home ? [{ kind: 'task_run_list' as const, id: home, workspaceId: home }] : []),
    ...ids.map(id => ({ kind: 'factory_issue' as const, id, workspaceId })),
  ] : [], keys, workspaceId ?? null, { minIntervalMs: 2000 })
  return { items: error ? EMPTY : data ?? EMPTY, error, isLoading, mutate }
}

export function usePresentedTaskGroups(threads: readonly Thread[], issues: readonly CollectionIssue[], scope: 'workspace' | 'dispatched') {
  const presentations = useContext(TaskPresentationsContext)
  return useMemo(() => groupPresentedTasks(issues, threads, presentations, scope), [issues, threads, presentations, scope])
}

export function useTaskEvidenceFolders(issues: readonly CollectionIssue[], storedArtifactIds: readonly string[] | undefined) {
  const scope = useLiveScope()
  const workspaceId = scope?.workspaceId
  const ids = useMemo(() => issues.filter(issue => issue.workspaceId === workspaceId).map(issue => issue.id).sort(), [issues, workspaceId])
  const stored = useMemo(() => storedArtifactIds && [...new Set(storedArtifactIds)].sort(), [storedArtifactIds])
  const key = workspaceId && ids.length && stored ? ['task-evidence-folders', scope?.ownerId, workspaceId, ids, stored] : null
  const result = useSWR(key, async () => {
    const projected = await readPresentationPages(workspaceId!, ids, input => getTaskPresentations({ ...input, folderStoredIds: stored }))
    const folders: Record<string, { factoryTaskId: string; extraCount: number }> = {}
    for (const [id, task] of projected) {
      if (task.factoryTaskId && task.factoryExtraCount !== undefined) folders[id] = { factoryTaskId: task.factoryTaskId, extraCount: task.factoryExtraCount }
    }
    return folders
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  const keys = key ? [unstable_serialize(key)] : []
  useLiveKeys(key ? ids.map(id => ({ kind: 'factory_issue', id, workspaceId })) : [], keys, workspaceId ?? null, { minIntervalMs: 2000 })
  return result
}
