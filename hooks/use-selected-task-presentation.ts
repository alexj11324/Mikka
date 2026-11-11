'use client'

import { useContext } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { getTaskPresentations } from '@/app/actions/task-domain'
import { useLiveKeys } from './use-live-key'
import { TaskPresentationsContext } from './use-task-collection'

/** The open Task reuses the workspace batch. A deep link outside the list
 * subscribes to a single authorized presentation for this account and Task. */
export function useSelectedTaskPresentation(ownerId: string, workspaceId: string | null, issueId: string | undefined) {
  const collection = useContext(TaskPresentationsContext)
  const resident = issueId ? collection[issueId] : undefined
  const key = !resident && workspaceId && issueId ? ['selected-task-presentation', ownerId, workspaceId, issueId] as const : null
  const selected = useSWR(key, async ([, , scope, id]) => (await getTaskPresentations({
    workspaceId: scope, issueIds: [id], includeFactoryIdentity: true,
  })).items[id] ?? null, { revalidateOnFocus: false, shouldRetryOnError: false })
  useLiveKeys(key ? [
    { kind: 'issue_list', id: key[2], workspaceId: key[2] },
    { kind: 'issue_threads', id: key[3], workspaceId: key[2] },
    { kind: 'factory_issue', id: key[3], workspaceId: key[2] },
  ] : [], key ? [unstable_serialize(key)] : [], workspaceId, { minIntervalMs: 2000 })
  return { data: resident ?? (key && !selected.error ? selected.data : undefined), error: key ? selected.error : undefined,
    retry: () => { void selected.mutate() } }
}
