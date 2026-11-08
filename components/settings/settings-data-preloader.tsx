'use client'

import { useCallback, useEffect } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useSearchParams } from 'next/navigation'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { prefetchConnectedApps } from '@/lib/settings-prefetch'
import { fetchSettingsData, fetchTeamDirectory, fetchTeamMembers, memberSettingsKey, settingsReadOptions, teamDirectoryKey, teamMembersKey } from '@/lib/settings-data'
import { useLiveKeys } from '@/hooks/use-live-key'
import { governanceLiveKey } from '@/hooks/settings/use-workspace-governance'
import { ListReadScopeError, listReadDeadline, liveListReadOptions, UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'

export function SettingsDataPreloader({ ownerId, userKey, workspaceId, onWorkspaceResolved }: { ownerId: string; userKey: string; workspaceId?: string; onWorkspaceResolved: (id: string) => void }) {
  const { mutate, cache } = useSWRConfig()
  const teamId = useSearchParams().get('team')
  const readMembers = useCallback(async (url: string) => {
    const value = await fetchSettingsData<WorkspaceSettings>(url)
    if (value.currentUserId !== ownerId) throw new ListReadScopeError('owner')
    if (workspaceId && value.workspace.id !== workspaceId) throw new ListReadScopeError('workspace')
    return value
  }, [ownerId, workspaceId])
  const readDirectory = useCallback(async (key: ReturnType<typeof teamDirectoryKey>) => {
    const value = await fetchTeamDirectory(key)
    if (value.currentUserId !== ownerId) throw new ListReadScopeError('owner')
    if (workspaceId && value.workspace.id !== workspaceId) throw new ListReadScopeError('workspace')
    return value
  }, [ownerId, workspaceId])
  useSWR(teamId ? teamMembersKey(teamId) : null, fetchTeamMembers, { ...settingsReadOptions, ...liveListReadOptions })
  const { data: members } = useSWR(memberSettingsKey(workspaceId), readMembers, { ...settingsReadOptions, ...liveListReadOptions })
  const { data: directory } = useSWR(teamDirectoryKey(workspaceId), readDirectory, { ...settingsReadOptions, ...liveListReadOptions })
  const scope = members?.currentUserId === ownerId && (!workspaceId || members.workspace.id === workspaceId) ? members.workspace.id : null
  const scopes = [...new Set([scope, members?.live?.ownerId === ownerId ? members.live.homeWorkspaceId : null])]
  useLiveKeys(scopes.map(workspace => ({ kind: 'workspace_settings', id: workspace ?? UNRESOLVED_LIST_SCOPE, workspaceId: workspace })), [
    memberSettingsKey(workspaceId), unstable_serialize(teamDirectoryKey(workspaceId)),
    '/api/workspace/switcher', unstable_serialize([memberSettingsKey(workspaceId), userKey]),
    ...(teamId ? [unstable_serialize(teamMembersKey(teamId))] : []),
    // Plan, seats and role cards count the same members (#1662).
    ...(scope ? [governanceLiveKey(scope)] : []),
  ], null, { minIntervalMs: 2_000, deadline: listReadDeadline(members, ownerId) })

  useEffect(() => {
    if (members?.currentUserId !== ownerId || directory?.currentUserId !== ownerId) return
    if (members.workspace.id === directory.workspace.id && (!workspaceId || members.workspace.id === workspaceId)) onWorkspaceResolved(members.workspace.id)
    if (workspaceId) return
    if (members) void mutate(memberSettingsKey(members.workspace.id), members, { revalidate: false })
    if (directory) void mutate(teamDirectoryKey(directory.workspace.id), directory, { revalidate: false })
  }, [ownerId, workspaceId, members, directory, mutate, onWorkspaceResolved])

  useEffect(() => prefetchConnectedApps(cache, mutate), [cache, mutate])

  return null
}
