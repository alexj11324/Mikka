'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { getResourceCreationDefaults } from '@/app/actions/resource-access'

export const resourceCreationKey = (workspaceId?: string) => ['resource-creation-defaults', workspaceId ?? null] as const

/** The displayed default is frozen into the submitted request. While the
 * authoritative setting is unavailable, creation is disabled instead of
 * silently choosing Shared. A different Workspace never borrows a draft. */
export function useResourceCreation(workspaceId?: string, enabled = true) {
  const read = useSWR(enabled ? resourceCreationKey(workspaceId) : null, () => getResourceCreationDefaults(workspaceId))
  const [choice, setChoice] = useState<{ workspaceId?: string; visibility: 'private' | 'shared' } | null>(null)
  useEffect(() => { if (!enabled) setChoice(null) }, [enabled])
  const chosen = choice?.workspaceId === workspaceId ? choice : null
  const visibility = chosen?.visibility ?? read.data?.visibility ?? 'private'
  return { ...read, visibility, chosen: chosen !== null, ready: !!read.data && !read.error,
    setVisibility: (visibility: 'private' | 'shared') => setChoice({ workspaceId, visibility }) }
}
