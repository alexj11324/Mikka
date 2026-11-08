'use client'

import { useCallback } from 'react'
import useSWR from 'swr'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import { selectedWebWorkspace } from '@/lib/web-connection/selection'
import { taskWorkspaceState, type TaskWorkspaceState } from '@/lib/task-workspace-state'

const SWITCHER_KEY = '/api/workspace/switcher'

/**
 * The workspace a task is created in or fixed to, against the one shown now:
 * the account menu's read (shared through SWR and revalidated by the existing
 * `workspace_settings` live key in IssueWorkspace, no polling of its own) and,
 * on a selected server, the Workspace the web client confirmed.
 *
 * `retry` reads it again after an error. `confirm` is the create action's last
 * check: one fresh read right before it submits, so a switch made in another
 * tab shows up as a mismatch instead of a task created elsewhere.
 */
export function useTaskWorkspace(target?: string | null) {
  const { data, error, mutate } = useSWR(SWITCHER_KEY, fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const state = taskWorkspaceState({ data, error, target, confirmed: selectedWebWorkspace() })
  const retry = useCallback(() => { void mutate() }, [mutate])
  const confirm = useCallback(async (captured: string): Promise<TaskWorkspaceState> => {
    let fresh: WorkspaceSwitcher | undefined
    try { fresh = await mutate() } catch (cause) { return taskWorkspaceState({ error: cause }) }
    return taskWorkspaceState({ data: fresh, error: fresh ? undefined : true, target: captured, confirmed: selectedWebWorkspace() })
  }, [mutate])
  return { state, retry, confirm }
}
