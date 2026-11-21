'use client'

import useSWR, { unstable_serialize } from 'swr'
import type { IssueStatesView } from '@/app/actions/issue-states'
import type { ActionResult } from '@/lib/action-result'
import { useLiveKey } from '@/hooks/use-live-key'
import { settingsRead } from '@/lib/settings-read'
import { settingsReadOptions } from '@/lib/settings-data'
import { settingsKeys } from '@/lib/swr/keys'

/**
 * The workspace's task states (decision 2026-11-19-2115), one read shared by the settings page, the board and every
 * status picker. `live` subscribes to the workspace's settings channel; one live owner per page (the board, the task
 * page, the settings page) is enough, since every picker reads the same SWR entry.
 */
export function useIssueStates(workspaceId: string | null | undefined, { live = false }: { live?: boolean } = {}) {
  const key = workspaceId ? settingsKeys.issueStates(workspaceId) : null
  const read = useSWR<ActionResult<IssueStatesView>>(key, () => settingsRead('issue-states', { workspace: workspaceId }), settingsReadOptions)
  useLiveKey('workspace_settings', live ? workspaceId : null, key ? [unstable_serialize(key)] : [], workspaceId)
  const data = !read.error && read.data && !read.data.error ? read.data : null
  return { states: data?.states ?? null, canEdit: data?.canEdit === true, error: read.error ? 'generic' : read.data?.error ?? null, mutate: read.mutate }
}
