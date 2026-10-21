'use client'

import useSWR from 'swr'
import type { WorkspaceSettings } from '@/lib/workspace-access'

async function fetchWorkspace([url]: readonly [string, string]): Promise<WorkspaceSettings> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('无法读取工作区，请确认访问权限后重试。')
  return response.json()
}

export function useWorkspace(userKey: string, workspaceId?: string) {
  const url = workspaceId ? `/api/workspace?workspace=${encodeURIComponent(workspaceId)}` : '/api/workspace'
  return useSWR([url, userKey] as const, fetchWorkspace, { dedupingInterval: 15000, revalidateOnFocus: true, keepPreviousData: false })
}
