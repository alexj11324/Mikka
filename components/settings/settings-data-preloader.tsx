'use client'

import { useEffect } from 'react'
import useSWR, { useSWRConfig } from 'swr'
import { useSearchParams } from 'next/navigation'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { fetchSettingsData, fetchTeamDirectory, fetchTeamMembers, memberSettingsKey, settingsReadOptions, teamDirectoryKey, teamMembersKey } from '@/lib/settings-data'

export function SettingsDataPreloader({ workspaceId, onWorkspaceResolved }: { workspaceId?: string; onWorkspaceResolved: (id: string) => void }) {
  const { mutate } = useSWRConfig()
  const teamId = useSearchParams().get('team')
  useSWR(teamId ? teamMembersKey(teamId) : null, fetchTeamMembers, settingsReadOptions)
  const { data: members } = useSWR(memberSettingsKey(workspaceId), fetchSettingsData<WorkspaceSettings>, { ...settingsReadOptions, refreshInterval: 60000 })
  const { data: directory } = useSWR(teamDirectoryKey(workspaceId), fetchTeamDirectory, { ...settingsReadOptions, refreshInterval: 60000 })

  useEffect(() => {
    if (workspaceId) return
    if (members) void mutate(memberSettingsKey(members.workspace.id), members, { revalidate: false })
    if (directory) void mutate(teamDirectoryKey(directory.workspace.id), directory, { revalidate: false })
    const id = members?.workspace.id ?? directory?.workspace.id
    if (id) onWorkspaceResolved(id)
  }, [workspaceId, members, directory, mutate, onWorkspaceResolved])

  return null
}
