'use client'

import { useEffect, useState } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { SWRConfig, unstable_serialize } from 'swr'
import type { listIssues } from '@/app/actions/issues'
import type { loadTeamDirectory } from '@/app/actions/teams'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { IssueWorkspace } from '@/components/workspace/issue-workspace'
import { SettingsShell } from '@/components/settings/settings-shell'
import { SettingsDataPreloader } from '@/components/settings/settings-data-preloader'
import { memberSettingsKey, teamDirectoryKey } from '@/lib/settings-data'

export function WorkspaceApp({ user, initialIssues, initialTeams, initialMembers }: {
  user: { id: string; name: string; email: string; image?: string | null }
  initialIssues?: Awaited<ReturnType<typeof listIssues>>
  initialTeams?: Awaited<ReturnType<typeof loadTeamDirectory>>
  initialMembers?: WorkspaceSettings
}) {
  const pathname = usePathname()
  const params = useSearchParams()
  const initialWorkspaceId = initialTeams?.workspace.id ?? initialMembers?.workspace.id
  useEffect(() => {
    document.title = pathname === '/' ? 'Orvilo3 · 任务与文档工作台' : pathname === '/settings/teams' ? '团队管理 · Orvilo3' : pathname === '/settings/members' ? '成员管理 · Orvilo3' : '设置 · Orvilo3'
  }, [pathname])
  const [workspaceId, setWorkspaceId] = useState(initialTeams?.workspace.id ?? initialMembers?.workspace.id)
  const [cacheConfig] = useState(() => {
    const fallback: Record<string, unknown> = {}
    if (initialTeams) fallback[unstable_serialize(teamDirectoryKey(initialTeams.workspace.id))] = initialTeams
    if (initialMembers) fallback[memberSettingsKey(initialMembers.workspace.id)] = initialMembers
    return { provider: () => new Map(), fallback }
  })
  return <SWRConfig value={cacheConfig}>
    <SettingsDataPreloader workspaceId={params.get('workspace') ?? initialWorkspaceId} onWorkspaceResolved={setWorkspaceId} />
    {pathname.startsWith('/settings')
      ? <SettingsShell user={user} defaultWorkspaceId={workspaceId} onWorkspaceResolved={setWorkspaceId} />
      : <IssueWorkspace user={user} initialIssues={initialIssues} />}
  </SWRConfig>
}
