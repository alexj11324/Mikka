'use client'

import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { withBasePath } from '@/lib/base-path'
import type { WorkspaceSettings } from '@/lib/workspace-access'

async function fetchWorkspace([url]: readonly [string, string]): Promise<WorkspaceSettings> {
  const response = await fetch(withBasePath(url))
  if (!response.ok) throw new Error('无法读取工作区，请确认访问权限后重试。')
  return response.json()
}

export function useWorkspace(userKey: string, workspaceId?: string) {
  const url = workspaceId ? `/api/workspace?workspace=${encodeURIComponent(workspaceId)}` : '/api/workspace'
  const { cache } = useSWRConfig()
  // Settings first read the default workspace, then name it once it resolves. Until that read
  // returns, the same workspace's earlier answer stands in, so the role (and the admin-only rows
  // it shows) does not blink away and back. A different workspace never borrows it.
  const unscoped = workspaceId ? cache.get(unstable_serialize(['/api/workspace', userKey]))?.data as WorkspaceSettings | undefined : undefined
  const fallbackData = unscoped?.workspace.id === workspaceId ? unscoped : undefined
  return useSWR([url, userKey] as const, fetchWorkspace, { dedupingInterval: 15000, revalidateOnFocus: true, keepPreviousData: false, fallbackData })
}
