'use client'

import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSettings } from '@/lib/workspace-access'

function fetchWorkspace([url]: readonly [string, string]): Promise<WorkspaceSettings> {
  return fetchSettingsData<WorkspaceSettings>(url)
}

export function useWorkspace(userKey: string, workspaceId?: string) {
  const url = workspaceId ? `/api/workspace?workspace=${encodeURIComponent(workspaceId)}` : '/api/workspace'
  const { cache } = useSWRConfig()
  // Settings first read the default workspace, then name it once it resolves. Until that read
  // returns, the same workspace's earlier answer stands in, so the role (and the admin-only rows
  // it shows) does not blink away and back. A different workspace never borrows it.
  const unscoped = workspaceId ? cache.get(unstable_serialize(['/api/workspace', userKey]))?.data as WorkspaceSettings | undefined : undefined
  const fallbackData = unscoped?.workspace.id === workspaceId ? unscoped : undefined
  return useSWR([url, userKey] as const, fetchWorkspace, { dedupingInterval: 15000, keepPreviousData: false, fallbackData })
}
