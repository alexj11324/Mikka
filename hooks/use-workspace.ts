'use client'

import useSWR from 'swr'
import { fetchSettingsData, memberSettingsKey } from '@/lib/settings-data'
import type { WorkspaceSettings } from '@/lib/workspace-access'

export function useWorkspace(userKey: string, workspaceId?: string, enabled = true) {
  return useSWR(enabled && userKey ? memberSettingsKey(workspaceId) : null, async (url: string) => {
    try {
      return await fetchSettingsData<WorkspaceSettings>(url)
    } catch {
      throw new Error('无法读取工作区，请确认访问权限后重试。')
    }
  }, { dedupingInterval: 15000, revalidateOnFocus: true, keepPreviousData: false })
}
