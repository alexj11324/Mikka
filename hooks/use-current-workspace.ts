'use client'

import useSWR from 'swr'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'

/**
 * The workspace currently shown, from the same request as the account menu
 * (SWR shares it). Undefined while it loads or when it cannot be read.
 */
export function useCurrentWorkspace() {
  const { data } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  return data?.workspace
}
